import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('scheduler');

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  lastRun: number;
  running: boolean;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickMs = 1000;
  private stopped = false;

  register(name: string, intervalMs: number, fn: () => Promise<void>): void {
    this.tasks.set(name, {
      name,
      intervalMs,
      fn,
      lastRun: 0,
      running: false,
    });
    log.info({ name, intervalMs }, 'Task registered');
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    log.info('Scheduler started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Scheduler stopped');
  }

  async runNow(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`Task not found: ${name}`);
    await this.executeTask(task);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.running) continue;
      if (now - task.lastRun < task.intervalMs) continue;
      // Fire and forget — errors are caught inside executeTask
      this.executeTask(task);
    }
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    if (task.running) return;
    task.running = true;
    const start = Date.now();
    try {
      await task.fn();
      task.lastRun = Date.now();
      log.debug({ name: task.name, durationMs: Date.now() - start }, 'Task completed');
    } catch (err) {
      log.error({ name: task.name, error: (err as Error).message }, 'Task failed');
    } finally {
      task.running = false;
    }
  }

  getStatus(): Record<string, { lastRun: number; running: boolean; intervalMs: number }> {
    const status: Record<string, { lastRun: number; running: boolean; intervalMs: number }> = {};
    for (const [name, task] of this.tasks) {
      status[name] = {
        lastRun: task.lastRun,
        running: task.running,
        intervalMs: task.intervalMs,
      };
    }
    return status;
  }
}
