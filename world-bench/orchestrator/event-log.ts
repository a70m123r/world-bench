// World-Bench v0.4 — Shared Event Log Utility
// Used by both the AgentAdapter (PostToolUse hooks) and the LensManager (lifecycle events).

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { WorkflowEvent } from '../agents/types';

let worldBenchRoot = process.env.WORLD_BENCH_ROOT || path.resolve(__dirname, '..');

export function setWorldBenchRoot(root: string): void {
  worldBenchRoot = root;
}

export function createEvent(
  runId: string,
  actor: string,
  type: WorkflowEvent['type'],
  content: string,
  metadata?: Record<string, any>,
  ref?: string,
): WorkflowEvent {
  return {
    id: uuid(),
    timestamp: new Date().toISOString(),
    run_id: runId,
    actor,
    type,
    content,
    metadata,
    ref,
  };
}

export function appendEvent(
  projectSlug: string,
  runId: string,
  event: WorkflowEvent,
): void {
  const eventsFile = path.join(
    worldBenchRoot, 'projects', projectSlug, 'runs', runId, 'events.jsonl',
  );
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
}
