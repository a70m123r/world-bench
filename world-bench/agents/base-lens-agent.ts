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
