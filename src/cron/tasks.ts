import type { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';

/**
 * Worker-side autonomous task scheduler.
 *
 * Two-phase design:
 *   1. scheduleTask(env)          — R2 only, no sandbox. Checks intervals,
 *                                   writes to R2 queue when threshold elapsed.
 *   2. injectQueuedTasks(sandbox) — Reads R2 queue, injects into the container
 *                                   via PENDING_TASKS.txt, then clears R2 queue.
 *
 * R2 is the durable source of truth. The container file is ephemeral and gets
 * re-injected from R2 after any container restart within the same scheduling
 * cycle. Clearing R2 immediately after injection means a crash in the ~30 min
 * window before the next auto-backup could lose the task — acceptable given the
 * non-urgent 72 h interval.
 *
 * Call sites:
 *   keepAlive mode: scheduleTask → injectQueuedTasks (sandbox already up)
 *   sleep mode:     scheduleTask → if queue non-empty → ensureGateway → injectQueuedTasks
 */

interface TaskQueue {
  tasks: string[];
  queuedAt: number; // epoch ms
}

interface TaskLastRuns {
  monetizeResearch?: number; // epoch ms
}

export const TASK_QUEUE_KEY = 'openclaw/tasks/queue.json';
const TASK_LAST_RUNS_KEY = 'openclaw/tasks/last-runs.json';
const PENDING_TASKS_PATH = '/home/openclaw/clawd/PENDING_TASKS.txt';

/** 72 hours between monetize-research runs */
const MONETIZE_RESEARCH_INTERVAL_MS = 72 * 60 * 60 * 1000;

/**
 * Check whether any autonomous tasks are due and write them to the R2 queue.
 * Does NOT touch the container — safe to call even when the container is asleep.
 *
 * Returns true if any tasks were newly queued.
 */
export async function scheduleTask(env: OpenClawEnv): Promise<boolean> {
  const [lastRunsObj, existingQueueObj] = await Promise.all([
    env.BACKUP_BUCKET.get(TASK_LAST_RUNS_KEY),
    env.BACKUP_BUCKET.get(TASK_QUEUE_KEY),
  ]);

  const lastRuns: TaskLastRuns = lastRunsObj
    ? (JSON.parse(await lastRunsObj.text()) as TaskLastRuns)
    : {};
  const existingQueue: TaskQueue = existingQueueObj
    ? (JSON.parse(await existingQueueObj.text()) as TaskQueue)
    : { tasks: [], queuedAt: 0 };

  const now = Date.now();
  const newTasks: string[] = [];

  if (
    !lastRuns.monetizeResearch ||
    now - lastRuns.monetizeResearch > MONETIZE_RESEARCH_INTERVAL_MS
  ) {
    newTasks.push('monetize-research');
  }

  if (newTasks.length === 0) return existingQueue.tasks.length > 0;

  // Merge with any already-queued tasks (shouldn't normally overlap)
  const merged = [...new Set([...existingQueue.tasks, ...newTasks])];

  console.log(`[CRON/tasks] Scheduling tasks: ${newTasks.join(', ')}`);

  // Update R2: queue and last-run timestamps
  const updatedLastRuns: TaskLastRuns = { ...lastRuns };
  if (newTasks.includes('monetize-research')) updatedLastRuns.monetizeResearch = now;

  await Promise.all([
    env.BACKUP_BUCKET.put(TASK_QUEUE_KEY, JSON.stringify({ tasks: merged, queuedAt: now })),
    env.BACKUP_BUCKET.put(TASK_LAST_RUNS_KEY, JSON.stringify(updatedLastRuns)),
  ]);

  return true;
}

/**
 * Read the R2 task queue and inject any pending tasks into the container's
 * PENDING_TASKS.txt. Clears the R2 queue after successful injection.
 *
 * Idempotent: skips tasks already present in the container file.
 * Requires the container to be running (call ensureGateway first).
 */
export async function injectQueuedTasks(
  sandbox: ReturnType<typeof getSandbox>,
  env: OpenClawEnv,
): Promise<void> {
  const obj = await env.BACKUP_BUCKET.get(TASK_QUEUE_KEY);
  if (!obj) return;

  const queue = JSON.parse(await obj.text()) as TaskQueue;
  if (!queue.tasks || queue.tasks.length === 0) return;

  console.log(`[CRON/tasks] Injecting tasks to container: ${queue.tasks.join(', ')}`);

  for (const task of queue.tasks) {
    // Validate task name to prevent shell injection (alphanumeric + hyphen only)
    if (!/^[a-zA-Z0-9-]+$/.test(task)) {
      console.warn(`[CRON/tasks] Skipping task with invalid name: "${task}"`);
      continue;
    }
    const cmd =
      `grep -qxF '${task}' '${PENDING_TASKS_PATH}' 2>/dev/null || ` +
      `printf '%s\\n' '${task}' >> '${PENDING_TASKS_PATH}'`;
    try {
      await sandbox.exec(cmd);
    } catch (err) {
      console.error(`[CRON/tasks] exec failed for task "${task}":`, err);
      return; // Leave R2 queue intact so next cron tick retries
    }
  }

  // Clear R2 queue — tasks are now in the container file
  await env.BACKUP_BUCKET.delete(TASK_QUEUE_KEY);
  console.log('[CRON/tasks] Queue cleared from R2');
}
