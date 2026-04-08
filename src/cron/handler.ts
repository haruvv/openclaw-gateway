import { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { buildSandboxOptions } from '../index';
import { ensureGateway } from '../gateway';
import { createSnapshot, getLastBackupTime } from '../persistence';
import { shouldWakeContainer, DEFAULT_LEAD_TIME_MS, CRON_STORE_R2_KEY } from './wake';

const AUTO_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BACKUP_DIR = '/home/openclaw';

/**
 * Take a snapshot if the last backup is older than AUTO_BACKUP_INTERVAL_MS.
 *
 * Safety check: skips backup if the openclaw working directory appears empty,
 * which indicates the container just restarted without a restore yet.
 * createBackup on an empty directory would overwrite the valid backup with nothing.
 */
async function maybeAutoBackup(
  sandbox: ReturnType<typeof getSandbox>,
  env: OpenClawEnv,
): Promise<void> {
  try {
    const lastBackupTime = await getLastBackupTime(env.BACKUP_BUCKET);
    const nowMs = Date.now();
    const lastMs = lastBackupTime ? new Date(lastBackupTime).getTime() : 0;
    if (nowMs - lastMs < AUTO_BACKUP_INTERVAL_MS) return;

    // Safety: skip if the openclaw working directory is empty (restore not yet done)
    const lsResult = await sandbox.exec(`ls ${BACKUP_DIR}/clawd/ 2>&1 || echo "(empty)"`);
    const dirOutput = lsResult.stdout?.trim() ?? '';
    if (!dirOutput || dirOutput === '(empty)') {
      console.log('[CRON] /home/openclaw/clawd/ is empty, skipping auto-backup');
      return;
    }

    console.log(`[CRON] Auto-backup triggered (last: ${lastBackupTime ?? 'never'})`);
    await createSnapshot(sandbox, env.BACKUP_BUCKET);
    console.log('[CRON] Auto-backup complete');
  } catch (err) {
    // Non-fatal: backup failure should not break keepAlive
    console.error('[CRON] Auto-backup failed:', err);
  }
}

/**
 * Handle Workers Cron Trigger: wake the container if OpenClaw has upcoming cron jobs.
 *
 * Reads the cron job store from R2 (synced by the background sync loop in the container)
 * and checks if any job is scheduled to fire within the lead time window. If so, wakes
 * the container so OpenClaw's internal timers can fire on time.
 *
 * Configure via environment variables:
 * - CRON_WAKE_AHEAD_MINUTES: How many minutes before a cron job to wake (default: 10)
 *
 * Configure the check interval in wrangler.jsonc triggers.crons (default: every 1 minute).
 */
export async function handleScheduled(env: OpenClawEnv): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, 'openclaw', buildSandboxOptions(env));

  // keepAlive モード（SANDBOX_SLEEP_AFTER 未設定）では毎分コンテナの死活を確認し、
  // 落ちていれば自動再起動する。デプロイ後の DO リセットから最大1分で復帰できる。
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    console.log('[CRON] keepAlive mode: ensuring gateway is running');
    await ensureGateway(sandbox, env);
    console.log('[CRON] Gateway is up');
    await maybeAutoBackup(sandbox, env);
    return;
  }

  // スリープポリシーが設定されている場合は従来通りスケジュール起動のみ
  const cronStoreObject = await env.BACKUP_BUCKET.get(CRON_STORE_R2_KEY);
  if (!cronStoreObject) {
    console.log('[CRON] No cron store found in R2, skipping');
    return;
  }

  const cronStoreJson = await cronStoreObject.text();
  const leadMinutes = parseInt(env.CRON_WAKE_AHEAD_MINUTES || '', 10);
  const leadTimeMs = leadMinutes > 0 ? leadMinutes * 60 * 1000 : DEFAULT_LEAD_TIME_MS;
  const nowMs = Date.now();

  const earliestRun = shouldWakeContainer(cronStoreJson, nowMs, leadTimeMs);
  if (!earliestRun) {
    console.log('[CRON] No upcoming cron jobs within lead time, skipping wake');
    return;
  }

  const deltaMinutes = ((earliestRun - nowMs) / 60_000).toFixed(1);
  console.log(`[CRON] Cron job due in ${deltaMinutes}m, waking container`);

  await ensureGateway(sandbox, env);
  console.log('[CRON] Container woken successfully');
}
