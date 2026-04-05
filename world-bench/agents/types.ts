// World-Bench v0.4 — Core Type Definitions
// All interfaces per SPEC-orchestrator-v0.4.md

// ─── Lens Configuration ───

export interface SlackPersona {
  username: string;
  icon_emoji: string;
}

export interface ContractSpec {
  description: string;
  fields: Record<string, string>;
}

export interface ResearchPhase {
  enabled: boolean;
  prompt: string;
  maxDuration?: number; // seconds, default 120
}

export interface LensPermissions {
  /** Lens maturity — determines permission behavior */
  tier: 'stem' | 'shaping' | 'hardened';

  /** Tools the lens is allowed to use. Empty = use sandbox defaults for tier. */
  allowed: string[];

  /** Tools explicitly denied regardless of tier. Hard limits. */
  denied: string[];

  /** Tools granted during shaping via Orchestrator or Pav elevation. */
  granted: string[];

  /** Number of consecutive runs with stable tool usage (for hardening trigger). */
  stableRunCount: number;

  /** Tool usage history — aggregated from events.jsonl across runs. */
  observedTools: string[];
}

/** Hard sandbox limits for stem cell lenses — only Bash denied from birth. */
export const STEM_CELL_DENIED: string[] = [
  'Bash',         // no shell access until explicitly granted — too powerful
];

/** Default tools available to all stem cell lenses. Light guardrails. */
export const STEM_CELL_ALLOWED: string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Write',        // workspace writes allowed from birth
  'Edit',         // workspace edits allowed from birth
  'Agent',
];

export interface LensConfig {
  id: string;
  name: string;
  purpose: string;
  systemPrompt: string;
  tools: string[];
  state: 'active' | 'dormant';
  permissions: LensPermissions;
  slackPersona: SlackPersona;
  inputContract: ContractSpec;
  outputContract: ContractSpec;
  researchPhase: ResearchPhase;
}

// ─── Workflow Events ───

export type WorkflowEventType =
  | 'message'
  | 'state_change'
  | 'artifact'
  | 'error'
  | 'summary'
  | 'elevation_request'
  | 'elevation_granted'
  | 'elevation_denied';

export interface WorkflowEvent {
  id: string;
  timestamp: string;       // ISO 8601
  run_id: string;
  actor: string;           // "orchestrator" | lens name | "pav" | "bridge"
  type: WorkflowEventType;
  content: string;
  metadata?: Record<string, any>;
  ref?: string;            // parent event ID for threading
}

// ─── Agent Adapter ───

export interface AgentResult {
  id: string;
  status: 'completed' | 'failed';
  output: string;
  events: WorkflowEvent[];
}

/** Claude-specific extension for file checkpoint rollback + session resume */
export interface ClaudeAgentResult extends AgentResult {
  rewindContext?: {
    query: any;
    lastUserMessageId: string;
  };
  /** Lens session ID for resume support (v0.5) */
  sessionId?: string;
}

export interface AgentAdapter {
  spawn(
    prompt: string,
    tools: string[],
    context: Record<string, any>,
  ): Promise<AgentResult>;

  kill(id: string): Promise<void>;
}

// ─── Project & Run Metadata ───

export interface ProjectMeta {
  name: string;
  slug: string;
  created_at: string;
  project_channel_id?: string;
  lenses: string[];        // lens slugs
}

export interface RunMeta {
  run_id: string;
  project_slug: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  lenses: Array<{
    slug: string;
    status: 'pending' | 'researching' | 'producing' | 'completed' | 'failed';
    started_at?: string;
    finished_at?: string;
  }>;
}

// ─── Orchestrator Command ───

export interface OrchestratorCommand {
  raw: string;             // original text from Pav
  intent: string;          // parsed intent
  project_slug?: string;   // target project if applicable
  lens_slugs?: string[];   // target lenses if applicable
  channel_id: string;      // source channel
  thread_ts?: string;      // source thread
  user_id: string;         // who sent it
  ts: string;              // message timestamp
}
