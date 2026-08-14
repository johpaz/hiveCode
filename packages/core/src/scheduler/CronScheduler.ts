/**
 * CronScheduler Interface
 *
 * Type definition for the cron scheduler instance used throughout the gateway.
 * The actual implementation may be provided by an external package or a future
 * built-in scheduler. This module defines the contract that any scheduler must
 * satisfy.
 */

export interface CronTaskInput {
  name: string;
  task: string;
  task_type: "recurring" | "one_shot";
  cron_expression?: string | null;
  fire_at?: string | null;
  timezone: string;
  payload?: Record<string, unknown>;
  agent_id?: string | null;
  tool_name?: string | null;
  max_runs?: number | null;
  channel?: string;
  start_at?: string;
  stop_at?: string;
  dom_and_dow?: boolean;
  protect?: boolean;
  interval_sec?: number | null;
}

export interface CronTask {
  id: string;
  name: string;
  task: string;
  task_type: string;
  status: string;
  cron_expression?: string | null;
  fire_at?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  run_count?: number;
  channel?: string;
}

export interface CronCreateResult {
  id: string;
  nextRun?: string | null;
}

export interface CronStatusEntry {
  id: string;
  name: string;
  status: string;
  nextRun?: string | null;
  lastRun?: string | null;
}

export interface CronScheduler {
  /** Create a new scheduled task */
  create(input: CronTaskInput): Promise<CronCreateResult>;

  /** List all tasks, optionally filtered by status */
  listTasks(status?: string): Promise<CronTask[]>;

  /** Get a single task by ID */
  getTask(taskId: string): Promise<CronTask | null>;

  /** Update a task */
  update(taskId: string, changes: Record<string, unknown>): Promise<boolean>;

  /** Delete a task */
  delete(taskId: string): Promise<boolean>;

  /** Pause a task */
  pause(taskId: string): Promise<boolean>;

  /** Resume a paused task */
  resume(taskId: string): Promise<boolean>;

  /** Manually trigger a task */
  trigger(taskId: string): Promise<boolean>;

  /** Get runtime status of all tasks */
  getStatus(): Promise<CronStatusEntry[]>;
}
