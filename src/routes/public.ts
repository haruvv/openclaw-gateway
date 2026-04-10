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
  const token = c.env.MOLTBOT_GATEWAY_TOKEN;
  if (!token) return c.json({ error: 'Gateway token not configured' }, 500);

  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${token}`) return c.json({ error: 'Unauthorized' }, 401);

  const sandbox = c.get('sandbox');
  try {
    await killGateway(sandbox);
    await signalRestoreNeeded(c.env.BACKUP_BUCKET);
    return c.json({ success: true, message: 'Gateway killed, will restart on next request' });
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
  const sigBytes = new Uint8Array(sigHex.match(/../g)!.map(h => parseInt(h, 16)));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, body);
  if (!valid) return c.json({ error: 'Invalid signature' }, 401);

  const event = c.req.header('X-GitHub-Event');
  if (event !== 'workflow_job') return c.json({ ok: true, skipped: 'not workflow_job' });

  const payload = JSON.parse(new TextDecoder().decode(body));
  const { action, workflow_job: job, repository } = payload;

  // Only handle events from openclaw-dev
  if (repository?.name !== 'openclaw-dev') return c.json({ ok: true, skipped: 'wrong repo' });

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

  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  const chatId = c.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return c.json({ error: 'Telegram not configured' }, 500);

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

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
