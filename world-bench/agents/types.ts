// World-Bench v0.4 — Core Type Definitions
// All interfaces per SPEC-orchestrator-v0.4.md

// ─── Lens Configuration ───

export interface SlackPersona {
  username: string;
  icon_emoji: string;
}

export interface ContractSpec {
  description: string;
  // v0.6.5.6: field values can be a plain-English description (string) OR a
  // structured shape spec (nested object, e.g. {type: "array", items: {...}}).
  // The Orchestrator's generate_lens SDK action produces both forms depending
  // on how complex the field is. buildLensSystemPrompt handles both via its
  // renderField helper — objects are rendered as JSON code blocks, strings as
  // inline markdown bullets.
  fields: Record<string, string | Record<string, unknown>>;
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
  // v0.6.5.8: block the default Claude Code plugin Slack MCP server. The
  // orchestrator ships its own pre-authenticated Slack MCP (mcp-servers.json
  // → "slack") and lenses should use THAT, not the plugin one which requires
  // per-user OAuth and triggers a browser redirect inside a lens session. The
  // first Harvester production run (run 09ac10dd, 2026-04-09) burned all its
  // turns calling mcp__plugin_slack_slack__authenticate trying to acquire an
  // OAuth token it could never receive inside a headless lens session.
  //
  // Trailing '*' is a prefix-match marker (see permission-manager's elevation
  // check and agent-adapter's PreToolUse hook — both understand the '*' suffix
  // as "block any tool starting with this prefix").
  'mcp__plugin_slack_slack__*',
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

// ─── Lens Maturity Lifecycle (SPEC-lens-maturity-lifecycle.md v2) ───

export type LensMaturity = 'discovery' | 'first-cut' | 'settling' | 'steady';

export interface MaturityTransition {
  from: LensMaturity;
  to: LensMaturity;
  reason: string;
  evidence?: string;
  triggeredBy: 'orchestrator' | 'pav' | 'lens' | 'automatic';
  timestamp: string;            // ISO 8601
  runId?: string;
  promptVersionBefore?: number;
  promptVersionAfter?: number;
}

export interface PromptVersion {
  version: number;
  systemPrompt: string;
  tools: string[];
  researchEnabled: boolean;
  createdAt: string;            // ISO 8601
  createdBy: 'orchestrator' | 'pav' | 'lens';
  reason: string;
  maturityAtCreation: LensMaturity;
}

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

  // v0.6.7: Lens Maturity Lifecycle
  maturity?: LensMaturity;
  maturityLog?: MaturityTransition[];
  activePromptVersion?: number;
  // promptVersions stored in separate prompt-history.json (council: keep lens.json lean)
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

// ─── Project Seed (v0.6) ───

/**
 * The lawful starting artifact for any World-Bench project.
 * Pav drops intent → Orchestrator asks questions → drafts a seed → Pav approves
 * (in a separate turn) → seed ignites → lenses render one at a time.
 *
 * Non-collapsible Pav interlock: created_at_turn_id prevents same-turn
 * create_seed → ignite_seed self-advancement.
 *
 * NOTE: first_lens is intentionally NOT in this type. Lens commitment
 * happens in Phase 3 (propose_lens), not in the seed itself.
 */
export interface ProjectSeed {
  slug: string;
  intent: string;             // Pav's words preferred
  output_shape: string;       // what done looks like
  lens_sketch: LensSketch[];  // ADVISORY ONLY — not executable
  status: 'draft' | 'ignited' | 'rendering' | 'complete';
  created_at: string;
  created_at_turn_id: string; // for non-collapsible Pav interlock
  ignited_at?: string;
  ignited_at_turn_id?: string;
  legacy_pre_seed?: boolean;  // for grandfathering pre-v0.6 projects

  // v0.6.3: structural fields added to give the seed real homes for the
  // load-bearing context the Orchestrator was previously stuffing into
  // markdown body. Both are optional so existing seeds load cleanly.
  /**
   * Boundary constraints — what the project will and will not be in v1.
   * "v1 is one hat, not a hat system." "Shape-cutting is manual." etc.
   * The Orchestrator should bake these into its reasoning each turn.
   */
  constraints?: {
    product?: string[];   // hard product boundaries — what NOT to build
    process?: string[];   // process discipline — how to build
  };
  /**
   * The artifact this project will produce, in mechanically-checkable terms.
   * Path, format, sections, soft caps — anything Pav can later assert against.
   */
  artifact_spec?: {
    path: string;           // e.g. "world-bench/hats/orchestrator/hat.md"
    format: 'markdown' | 'json' | 'yaml' | 'jsonl' | 'other';
    sections?: string[];    // for markdown artifacts: required sections
    word_cap?: number;      // soft cap on length
    notes?: string;         // freeform anything-else
  };
}

export interface LensSketch {
  slug: string;
  name: string;
  purpose: string;
  // Intentionally NO tools, NO system prompt, NO contracts.
  // Sketch is debate. Render is commitment.
}

export type ProjectPhase = 'intake' | 'seed_draft' | 'ignited' | 'rendering' | 'accumulating' | 'complete';

// ─── Project & Run Metadata ───

export interface ProjectMeta {
  name: string;
  slug: string;
  created_at: string;
  project_channel_id?: string;
  lenses: string[];        // lens slugs
  legacy_pre_seed?: boolean; // grandfather marker for pre-v0.6 projects
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
