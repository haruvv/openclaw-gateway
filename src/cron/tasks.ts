import type { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';

/**
 * Worker-side autonomous task scheduler.
 *
 * Tracks last-run timestamps in R2 and injects tasks into the OpenClaw
 * container via PENDING_TASKS.txt when the interval has elapsed.
 * OpenClaw reads this file on each message and executes pending tasks.
 */

interface TaskLastRuns {
  monetizeResearch?: number; // epoch ms of last trigger
}

const TASK_LAST_RUNS_KEY = 'openclaw/tasks/last-runs.json';
const PENDING_TASKS_PATH = '/home/openclaw/clawd/PENDING_TASKS.txt';

/** 72 hours between monetize-research runs */
const MONETIZE_RESEARCH_INTERVAL_MS = 72 * 60 * 60 * 1000;

export async function maybeQueueAutonomousTasks(
  sandbox: ReturnType<typeof getSandbox>,
  env: OpenClawEnv,
): Promise<void> {
  const obj = await env.BACKUP_BUCKET.get(TASK_LAST_RUNS_KEY);
  const lastRuns: TaskLastRuns = obj ? (JSON.parse(await obj.text()) as TaskLastRuns) : {};

  const now = Date.now();
  const tasks: string[] = [];

  if (
    !lastRuns.monetizeResearch ||
    now - lastRuns.monetizeResearch > MONETIZE_RESEARCH_INTERVAL_MS
  ) {
    tasks.push('monetize-research');
  }

  if (tasks.length === 0) return;

  console.log(`[CRON/tasks] Queueing autonomous tasks: ${tasks.join(', ')}`);

  // Idempotently append each task — skip if already in the file
  for (const task of tasks) {
    const cmd =
      `grep -qxF '${task}' '${PENDING_TASKS_PATH}' 2>/dev/null || ` +
      `printf '%s\\n' '${task}' >> '${PENDING_TASKS_PATH}'`;
    try {
      await sandbox.exec(cmd);
    } catch (err) {
      console.error(`[CRON/tasks] Failed to queue task "${task}":`, err);
      return; // Don't update last-run if injection failed
    }
  }

  // Update last-run timestamps only after successful injection
  if (tasks.includes('monetize-research')) {
    lastRuns.monetizeResearch = now;
  }
  await env.BACKUP_BUCKET.put(TASK_LAST_RUNS_KEY, JSON.stringify(lastRuns));
  console.log('[CRON/tasks] Task queue updated, last-runs saved to R2');
}
