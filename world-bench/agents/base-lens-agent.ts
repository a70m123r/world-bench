// World-Bench v0.4 — Base Lens Agent (Stem Cell)
// One template, differentiated at activation time via LensConfig.
// The Orchestrator injects config; this module builds the system prompt
// and defines how a lens executes its work.

import { LensConfig } from './types';

/**
 * Build the full system prompt for a lens agent from its config.
 * This is what gets injected into the Claude SDK call.
 */
export function buildLensSystemPrompt(config: LensConfig): string {
  const sections: string[] = [];

  // Identity
  sections.push(`# ${config.name}`);
  sections.push(`You are **${config.name}**, a specialized lens in the World-Bench system.`);
  sections.push(`**Purpose:** ${config.purpose}`);

  // Custom system prompt content
  if (config.systemPrompt) {
    sections.push(config.systemPrompt);
  }

  // v0.6.5.6: `desc` is declared as string in types.ts but the Orchestrator's
  // generate_lens SDK action produces structured JSON values for contract fields
  // in practice (e.g. `{type: "array", items: {...}}` for nested shapes). A naive
  // template literal `${desc}` invokes .toString() on objects, producing the
  // literal string "[object Object]" — which the Harvester saw in its meet
  // response and correctly flagged as a contract rendering bug. This helper
  // renders strings as-is and JSON-stringifies objects with indentation.
  const renderField = (desc: unknown): string => {
    if (typeof desc === 'string') return desc;
    if (desc === null || desc === undefined) return '(unspecified)';
    try {
      return '\n```json\n' + JSON.stringify(desc, null, 2) + '\n```';
    } catch {
      return String(desc);
    }
  };

  // Input contract
  sections.push('## Input Contract');
  sections.push(config.inputContract.description);
  if (Object.keys(config.inputContract.fields).length > 0) {
    sections.push('Expected fields:');
    for (const [field, desc] of Object.entries(config.inputContract.fields)) {
      sections.push(`- **${field}**: ${renderField(desc)}`);
    }
  }

  // Output contract
  sections.push('## Output Contract');
  sections.push(config.outputContract.description);
  if (Object.keys(config.outputContract.fields).length > 0) {
    sections.push('You must produce:');
    for (const [field, desc] of Object.entries(config.outputContract.fields)) {
      sections.push(`- **${field}**: ${renderField(desc)}`);
    }
  }

  // Behavioral rules
  sections.push('## Rules');
  sections.push('- You are a lens. Focus exclusively on your purpose.');
  sections.push('- Produce output matching your output contract.');
  sections.push('- If you encounter errors, report them clearly — do not silently fail.');
  sections.push('- Write your final output as structured text that can be parsed by the Orchestrator.');

  // Circuit breaker — prevent burn loops
  sections.push('## Circuit Breaker');
  sections.push('If you hit the SAME error 3 times in a row, STOP retrying. Do not burn turns on a problem you cannot solve. Instead:');
  sections.push('1. Write `output/escalation.json` with: `{ "severity": "high", "message": "what failed", "context": "what you tried 3 times", "requestedAction": "what you need" }`');
  sections.push('2. Move on to whatever else you can accomplish, or stop cleanly and report what you did complete.');
  sections.push('3. The Orchestrator reads escalation.json and posts it to Slack so Pav can see it.');
  sections.push('Burning 10+ turns on the same error is worse than stopping early with a clear escalation.');

  // Windows environment notes
  sections.push('## Environment Notes (Windows)');
  sections.push('- Python defaults to cp1252 encoding on Windows. Always use `encoding="utf-8"` when reading/writing files or piping data. Example: `open(path, encoding="utf-8")` or `sys.stdout.reconfigure(encoding="utf-8")`.');
  sections.push('- Bash commands run via Git Bash. Use forward slashes in paths. Quote paths with spaces.');

  // v0.8 Phase B: automatic streaming to lens channel
  sections.push('## Slack Output — Automatic (do NOT post directly)');
  sections.push('**Your assistant-text output (everything you write as natural language, including markdown tables and summaries) is AUTOMATICALLY streamed to your lens channel (#wb-lens-{your-id}) by the Orchestrator, turn by turn, as you produce it.** You do NOT need to call `slack_post`, `conversations.postMessage`, Slack MCP tools, or `curl` against Slack API to post your narrative.');
  sections.push('');
  sections.push('**Rules:**');
  sections.push('- Write your narrative/summary/tables as normal assistant text. They will appear in your lens channel automatically.');
  sections.push('- If Pav or the Orchestrator asks you to "post X to channel Y" — just produce the text. The Orchestrator routes it to the right channel via Phase A direct-address routing. Don\'t reach for Slack tools.');
  sections.push('- Direct Slack posting from within your own run would (a) duplicate the auto-streamed output, (b) likely fail scope checks on your lens token, and (c) post under the wrong display name. All three have happened. Don\'t do it.');
  sections.push('- Exception: if the Orchestrator explicitly provisioned you with a Slack tool for a specific cross-channel posting need, that\'s fine. Default is: your text flows through Orc.');

  return sections.join('\n\n');
}

/**
 * Build the research phase prompt for a lens.
 * Used when researchPhase.enabled is true.
 */
export function buildResearchPrompt(config: LensConfig): string {
  const sections: string[] = [];

  sections.push(`# Research Phase — ${config.name}`);
  sections.push(`You are in the **research phase** for lens "${config.name}".`);
  sections.push(`**Research goal:** ${config.researchPhase.prompt}`);
  sections.push('');
  sections.push('## Instructions');
  sections.push('1. Use available tools (web search, fetch, etc.) to gather information.');
  sections.push('2. Be thorough but time-conscious — you have a limited window.');
  sections.push('3. Produce a structured research summary as your output.');
  sections.push('4. Format: provide key findings, sources, and relevance to the lens purpose.');
  sections.push('');
  sections.push(`**Lens purpose for context:** ${config.purpose}`);

  return sections.join('\n');
}

/**
 * Build the production phase prompt for a lens.
 * Called after research completes (or directly if no research phase).
 */
export function buildProductionPrompt(
  config: LensConfig,
  taskPrompt: string,
  researchOutput?: string,
  priorLensOutput?: string,
): string {
  const sections: string[] = [];

  sections.push(`# Production Phase — ${config.name}`);
  sections.push(`Produce your final output per your contract.`);

  if (researchOutput) {
    sections.push('## Research Findings');
    sections.push(researchOutput);
  }

  if (priorLensOutput) {
    sections.push('## Input from Prior Lens');
    sections.push(priorLensOutput);
  }

  sections.push('## Task');
  sections.push(taskPrompt);

  return sections.join('\n\n');
}
