import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { GATEWAY_PORT } from '../config';
import { findExistingGatewayProcess, ensureGateway, killGateway } from '../gateway';
import { restoreIfNeeded, signalRestoreNeeded } from '../persistence';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function verifyGatewayToken(c: {
  env: AppEnv['Bindings'];
  req: { header: (name: string) => string | undefined };
}): Response | null {
  const token = c.env.MOLTBOT_GATEWAY_TOKEN;
  if (!token) return Response.json({ error: 'Gateway token not configured' }, { status: 500 });

  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${token}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  return null;
}

function redactKnownSecrets(text: string, env: AppEnv['Bindings']): string {
  const values = [
    env.MOLTBOT_GATEWAY_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    env.REVENUE_AGENT_INTEGRATION_TOKEN,
    env.ZAI_API_KEY,
    env.GEMINI_API_KEY,
    env.GITHUB_PERSONAL_ACCESS_TOKEN,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  let redacted = text;
  for (const value of values) {
    redacted = redacted.split(value).join('[REDACTED]');
  }
  return redacted;
}

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'openclaw-sandbox',
    gateway_port: GATEWAY_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    let process = await findExistingGatewayProcess(sandbox);
    console.log('[api/status] existing process:', process?.id ?? 'none', process?.status ?? '');
    if (!process) {
      // Restore synchronously — restoreBackup is a fast RPC call (~1-3s).
      // This MUST happen before ensureGateway or the gateway starts without
      // the FUSE overlay.
      let restoreError: string | null = null;
      try {
        await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);
      } catch (err) {
        restoreError = err instanceof Error ? err.message : String(err);
        console.error('[api/status] Restore failed:', restoreError);
      }

      // Start the gateway but DON'T wait for it to be ready.
      // ensureGateway with waitForReady:false just starts the process
      // (fast RPC, ~2-5s) without blocking on waitForPort (which takes
      // up to 180s and would exceed the 30s Worker CPU limit).
      // The loading page polls every 2s — subsequent polls will find
      // the process and check if the port is up.
      console.log('[api/status] No process found, starting gateway...');
      try {
        await ensureGateway(sandbox, c.env, { waitForReady: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api/status] Gateway start failed:', msg);
        return c.json({ ok: false, status: 'start_failed', error: msg, restoreError });
      }
      return c.json({ ok: false, status: 'starting', restoreError });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// POST /api/gateway/restart - Gateway restart (authenticated by MOLTBOT_GATEWAY_TOKEN, no CF Access required)
publicRoutes.post('/api/gateway/restart', async (c) => {
  const authError = verifyGatewayToken(c);
  if (authError) return authError;

  const sandbox = c.get('sandbox');
  try {
    await killGateway(sandbox);
    await signalRestoreNeeded(c.env.BACKUP_BUCKET);
    return c.json({ success: true, message: 'Gateway killed, will restart on next request' });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// GET /api/gateway/logs - Token-protected process logs for production diagnostics.
publicRoutes.get('/api/gateway/logs', async (c) => {
  const authError = verifyGatewayToken(c);
  if (authError) return authError;

  const sandbox = c.get('sandbox');
  const process = await findExistingGatewayProcess(sandbox);
  if (!process) return c.json({ error: 'Gateway process not found' }, 404);

  try {
    const logs = await process.getLogs();
    return c.json({
      processId: process.id,
      status: process.status,
      stdout: redactKnownSecrets(logs.stdout ?? '', c.env).slice(-8000),
      stderr: redactKnownSecrets(logs.stderr ?? '', c.env).slice(-8000),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// POST /api/revenue-agent/verify - Smoke test from the OpenClaw container to RevenueAgentPlatform.
// Authenticated by MOLTBOT_GATEWAY_TOKEN. The response intentionally excludes secrets.
publicRoutes.post('/api/revenue-agent/verify', async (c) => {
  const authError = verifyGatewayToken(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => ({}));
  const requestedUrl = typeof body?.url === 'string' ? body.url : 'https://example.com';
  const mode = body?.mode === 'run' || body?.mode === 'health' ? body.mode : 'auth-check';

  let targetUrl: string;
  try {
    const parsed = new URL(requestedUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'url must use http or https' }, 400);
    }
    targetUrl = parsed.toString();
  } catch {
    return c.json({ error: 'Invalid url' }, 400);
  }

  const sandbox = c.get('sandbox');

  const script = `
(async () => {
  const base = process.env.REVENUE_AGENT_BASE_URL;
  const token = process.env.REVENUE_AGENT_INTEGRATION_TOKEN;
  const accessClientId = process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
  if (!base) throw new Error('REVENUE_AGENT_BASE_URL missing');
  if (!token) throw new Error('REVENUE_AGENT_INTEGRATION_TOKEN missing');

  const mode = ${JSON.stringify(mode)};
  const endpoint = mode === 'health' ? '/health' : '/api/revenue-agent/run';
  const expectedValidationStatus = mode === 'auth-check';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const response = await fetch(new URL(endpoint, base).toString(), {
    method: mode === 'health' ? 'GET' : 'POST',
    signal: controller.signal,
    headers: mode === 'health'
      ? undefined
      : {
          ...(accessClientId && accessClientSecret
            ? {
                'CF-Access-Client-Id': accessClientId,
                'CF-Access-Client-Secret': accessClientSecret,
              }
            : {}),
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
    body: mode === 'health'
      ? undefined
      : JSON.stringify({
          url: expectedValidationStatus ? 'not-a-url' : ${JSON.stringify(targetUrl)},
          sendEmail: false,
          sendTelegram: false,
          createPaymentLink: false,
        }),
  });
  clearTimeout(timeout);

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 1000) };
  }

  const sanitized = {
    mode,
    httpStatus: response.status,
    status: payload.status,
    error: payload.error,
    targetUrl: payload.targetUrl,
    steps: Array.isArray(payload.steps)
      ? payload.steps.map((step) => ({
          name: step.name,
          status: step.status,
          error: step.error,
        }))
      : undefined,
    outputs: payload.outputs
      ? {
          domain: payload.outputs.domain,
          seoScore: payload.outputs.seoScore,
          proposalPath: payload.outputs.proposalPath,
          paymentLinkUrlPresent: Boolean(payload.outputs.paymentLinkUrl),
        }
      : undefined,
  };

  console.log(JSON.stringify(sanitized));
  if (mode === 'auth-check') {
    if (response.status === 401 || response.status === 403 || response.status >= 500) process.exit(1);
  } else if (!response.ok) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`;

  try {
    const result = await sandbox.exec(`node -e ${shellSingleQuote(script)}`, {
      timeout: 90_000,
      env: {
        REVENUE_AGENT_BASE_URL: c.env.REVENUE_AGENT_BASE_URL,
        REVENUE_AGENT_INTEGRATION_TOKEN: c.env.REVENUE_AGENT_INTEGRATION_TOKEN,
        CLOUDFLARE_ACCESS_CLIENT_ID: c.env.CLOUDFLARE_ACCESS_CLIENT_ID,
        CLOUDFLARE_ACCESS_CLIENT_SECRET: c.env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
      },
    });
    const stdout = result.stdout?.trim() ?? '';
    let verification: unknown = stdout;
    try {
      verification = JSON.parse(stdout);
    } catch {
      // keep sanitized stdout as-is
    }

    if (result.exitCode !== 0) {
      return c.json(
        {
          success: false,
          exitCode: result.exitCode,
          result: verification,
          stderr: result.stderr?.slice(0, 1000),
        },
        502,
      );
    }

    return c.json({ success: true, result: verification });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// POST /github-webhook - GitHub webhook for workflow_job events from openclaw-dev
// Authenticated by HMAC-SHA256 signature (X-Hub-Signature-256 header)
publicRoutes.post('/github-webhook', async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'GITHUB_WEBHOOK_SECRET not configured' }, 500);

  // Verify GitHub signature (HMAC-SHA256)
  const signature = c.req.header('X-Hub-Signature-256');
  if (!signature) return c.json({ error: 'Missing signature' }, 401);

  const body = await c.req.arrayBuffer();

  // HMAC-SHA256 署名検証（GitHub 公式推奨）
  // signature format: "sha256=<hex>"
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigHex = signature.replace(/^sha256=/, '');
  const hexParts = sigHex.match(/../g);
  if (!hexParts) return c.json({ error: 'Invalid signature format' }, 401);
  const sigBytes = new Uint8Array(hexParts.map(h => parseInt(h, 16)));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, body);
  if (!valid) return c.json({ error: 'Invalid signature' }, 401);

  const event = c.req.header('X-GitHub-Event');
  if (event !== 'workflow_job') return c.json({ ok: true, skipped: 'not workflow_job' });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  const { action, workflow_job: job, repository } = payload as {
    action: string;
    workflow_job: Record<string, unknown>;
    repository: Record<string, unknown>;
  };

  // Only handle events from haruvv/openclaw-dev (full_name で一致させる)
  if (repository?.full_name !== 'haruvv/openclaw-dev') return c.json({ ok: true, skipped: 'wrong repo' });

  // Only handle the implement job
  if (job?.name !== 'implement') return c.json({ ok: true, skipped: 'not implement job' });

  let text: string | null = null;
  if (action === 'in_progress') {
    text = `🔨 実装開始\n${job.html_url}`;
  } else if (action === 'completed' && job.conclusion === 'success') {
    text = `✅ 実装完了\n${job.html_url}`;
  } else if (action === 'completed' && (job.conclusion === 'failure' || job.conclusion === 'cancelled')) {
    text = `❌ 実装失敗 (${job.conclusion})\n${job.html_url}`;
  }

  if (!text) return c.json({ ok: true, skipped: `action=${action} conclusion=${job?.conclusion}` });

  // Telegram 通知はワークフロー側で直接送信するため Worker では何もしない
  console.log('[WEBHOOK]', text.split('\n')[0]);
  return c.json({ ok: true });
});

// POST /telegram - Telegram webhook (no auth required; token validated by OpenClaw inside container)
publicRoutes.post('/telegram', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);
  } catch {
    // non-fatal
  }
  try {
    await ensureGateway(sandbox, c.env);
  } catch (err) {
    console.error('[telegram] Failed to start gateway:', err);
    return c.json({ error: 'Gateway not ready' }, 503);
  }
  return sandbox.containerFetch(c.req.raw, GATEWAY_PORT);
});

export { publicRoutes };
