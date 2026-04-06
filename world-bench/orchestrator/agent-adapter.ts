// World-Bench v0.4 — Agent Adapter
// Type boundary: one implementation now (Claude), interface stays for future SDKs.
// Wires in SDK native features: PostToolUse hooks, native agent defs,
// file checkpointing, background task support.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuid } from 'uuid';
import { AgentAdapter, AgentResult, ClaudeAgentResult, LensConfig, WorkflowEvent } from '../agents/types';
import { appendEvent, createEvent } from './event-log';
import { PermissionManager } from './permission-manager';

export class ClaudeAgentAdapter implements AgentAdapter {
  private activeQueries: Map<string, { abort: AbortController; query: any }> = new Map();

  constructor() {
    // Ensure we use Claude Max OAuth, not paid API.
    if (process.env.ANTHROPIC_API_KEY) {
      console.warn('[AgentAdapter] Clearing ANTHROPIC_API_KEY — using Max OAuth instead.');
      delete process.env.ANTHROPIC_API_KEY;
    }
  }

  async spawn(
    prompt: string,
    tools: string[],
    context: Record<string, any>,
  ): Promise<AgentResult> {
    const agentId = uuid();
    const abortController = new AbortController();
    const events: WorkflowEvent[] = [];
    let output = '';
    let lastUserMessageId: string | undefined;
    let lensSessionId: string | undefined;

    try {
      const fullPrompt = buildLensPrompt(prompt, context);

      // ─── Build SDK options with native features ───
      const options: any = {
        outputFormat: 'stream-json',
        permissionMode: 'bypassPermissions',
        model: 'claude-opus-4-6',
        systemPrompt: context.systemPrompt || '',
        cwd: context.cwd || process.cwd(),
        maxTurns: context.maxTurns || 10,
        abortController,

        // Native feature: file checkpointing for rollback on failure
        enableFileCheckpointing: true,

        // v0.5: resume lens from previous session if available
        ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),

        // Native feature: PostToolUse hook for automatic event logging
        hooks: this.buildHooks(context),
      };

      // Native feature: define the lens as a named agent
      if (context.lens_name) {
        options.agents = {
          [context.lens_name]: {
            description: context.purpose || `Lens: ${context.lens_name}`,
            prompt: fullPrompt,
            tools: tools.length > 0 ? tools : undefined,
            model: 'opus',
            maxTurns: context.maxTurns || 10,
            background: context.background || false,
          },
        };
      }

      if (tools.length > 0) {
        options.allowedTools = tools;
      }

      // Pass MCP servers to lens if provided in context.
      // This lets the Orchestrator spec lenses with Slack MCP, Memory MCP, etc.
      if (context.mcpServers) {
        options.mcpServers = context.mcpServers;
        // Add MCP tool names to allowed tools
        if (context.mcpTools && Array.isArray(context.mcpTools)) {
          options.allowedTools = [
            ...(options.allowedTools || []),
            ...context.mcpTools,
          ];
        }
      }

      const messages: string[] = [];
      const q = query({ prompt: fullPrompt, options });

      this.activeQueries.set(agentId, { abort: abortController, query: q });

      for await (const message of q) {
        if (abortController.signal.aborted) break;

        // Capture lens session ID for resume support
        if (message.type === 'system' && (message as any).subtype === 'init') {
          lensSessionId = (message as any).session_id;
        }

        // Track user message IDs for file checkpointing rewind targets
        if (message.type === 'user' && (message as any).message?.id) {
          lastUserMessageId = (message as any).message.id;
        }

        if (message.type === 'assistant' && message.message) {
          if (typeof message.message === 'string') {
            messages.push(message.message);
          } else if (message.message.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                messages.push(block.text);
              }
            }
          }
        }

        if (message.type === 'result') {
          output = messages.join('\n\n');
        }
      }

      this.activeQueries.delete(agentId);

      // Lifecycle event: completion
      const doneEvent = createEvent(
        context.run_id || '', context.lens_name || 'unknown-lens', 'state_change',
        `Lens completed: ${context.lens_name}`,
        { agent_id: agentId, status: 'completed' },
      );
      events.push(doneEvent);

      const result: ClaudeAgentResult = {
        id: agentId,
        status: 'completed',
        output: output || messages.join('\n\n'),
        events,
        sessionId: lensSessionId,
      };
      return result;
    } catch (error: any) {
      // Lifecycle event: failure
      const errorEvent = createEvent(
        context.run_id || '', context.lens_name || 'unknown-lens', 'error',
        `Lens failed: ${error.message}`,
        { agent_id: agentId, error: error.message },
      );
      events.push(errorEvent);

      // Capture rewind context BEFORE deleting the query reference
      const entry = this.activeQueries.get(agentId);
      const rewindContext = (entry && lastUserMessageId)
        ? { query: entry.query, lastUserMessageId }
        : undefined;

      this.activeQueries.delete(agentId);

      const result: ClaudeAgentResult = {
        id: agentId,
        status: 'failed',
        output: `Error: ${error.message}`,
        events,
        rewindContext,
      };

      return result;
    }
  }

  async kill(id: string): Promise<void> {
    const entry = this.activeQueries.get(id);
    if (entry) {
      entry.abort.abort();
      this.activeQueries.delete(id);
    }
  }

  /**
   * Get the AbortController for a running agent.
   * Used by LensManager for timeout enforcement — abort directly
   * instead of waiting for spawn to resolve then calling kill(id).
   */
  getAbortController(id: string): AbortController | undefined {
    return this.activeQueries.get(id)?.abort;
  }

  /**
   * Attempt to rewind files to a checkpoint after lens failure.
   * Returns true if rewind succeeded. Nulls out rewind context after use.
   */
  async rewindOnFailure(result: AgentResult): Promise<boolean> {
    const r = result as ClaudeAgentResult;
    if (!r.rewindContext) return false;

    const { query: q, lastUserMessageId } = r.rewindContext;

    try {
      const preview = await q.rewindFiles(lastUserMessageId, { dryRun: true });
      if (!preview.canRewind) {
        r.rewindContext = undefined; // Release reference
        return false;
      }

      const rewind = await q.rewindFiles(lastUserMessageId);
      console.log(`[AgentAdapter] Rewound ${rewind.filesChanged?.length || 0} files after failure`);
      r.rewindContext = undefined; // Release reference — prevent memory leak
      return true;
    } catch (e: any) {
      console.warn(`[AgentAdapter] Rewind failed: ${e.message}`);
      r.rewindContext = undefined; // Release reference
      return false;
    }
  }

  // ─── Hook Builders ───

  private buildHooks(context: Record<string, any>): Record<string, any> {
    const runId = context.run_id || '';
    const lensName = context.lens_name || 'unknown';
    const projectSlug = context.projectSlug || '';
    const deniedTools: string[] = context.deniedTools || [];
    const permissionManager: PermissionManager | undefined = context.permissionManager;
    const lensConfig: LensConfig | undefined = context.lensConfig;

    return {
      // Permission enforcement via elevation loop
      PreToolUse: [{
        hooks: [async (input: any) => {
          const toolName = input.tool_name || '';

          // If tool is not in the denied list, allow it
          if (!deniedTools.includes(toolName)) {
            return { hookEventName: 'PreToolUse', permissionDecision: 'defer' };
          }

          // Tool is denied — run the elevation loop
          console.log(`[AgentAdapter] Denied tool requested: ${toolName} by ${lensName}`);

          if (permissionManager && lensConfig && runId && projectSlug) {
            const evaluation = permissionManager.evaluateElevation(lensConfig, toolName);

            if (evaluation.decision === 'grant') {
              // Auto-grant: tool aligns with lens purpose
              console.log(`[AgentAdapter] ELEVATED: ${toolName} for ${lensName} — ${evaluation.reason}`);
              permissionManager.grantTool(lensConfig, toolName, projectSlug, runId, 'orchestrator');
              // Remove from denied so subsequent calls don't re-evaluate
              const idx = deniedTools.indexOf(toolName);
              if (idx >= 0) deniedTools.splice(idx, 1);
              return {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                additionalContext: `Tool "${toolName}" granted: ${evaluation.reason}`,
              };
            }

            if (evaluation.decision === 'escalate') {
              // Ambiguous — log escalation event for Pav to review
              console.log(`[AgentAdapter] ESCALATE: ${toolName} for ${lensName} — ${evaluation.reason}`);
              const event = createEvent(
                runId, lensName, 'elevation_request',
                `Needs Pav: ${evaluation.reason}`,
                { tool: toolName, lens_name: lensName, decision: 'escalate', reason: evaluation.reason },
              );
              try { appendEvent(projectSlug, runId, event); } catch { }
              // Deny for now — Pav can grant later
              return {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                additionalContext: `Tool "${toolName}" requires approval. Request logged for Pav.`,
              };
            }

            // Explicit deny
            console.log(`[AgentAdapter] DENIED: ${toolName} for ${lensName} — ${evaluation.reason}`);
            permissionManager.denyTool(lensConfig, toolName, projectSlug, runId, 'orchestrator', evaluation.reason);
          }

          return {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            additionalContext: `Tool "${toolName}" is not available for this lens.`,
          };
        }],
      }],

      // Automatic event logging for every tool call
      PostToolUse: [{
        hooks: [async (input: any) => {
          if (runId && projectSlug) {
            const event = createEvent(
              runId, lensName, 'message',
              `Tool: ${input.tool_name}`,
              {
                tool: input.tool_name,
                tool_input: truncateForLog(input.tool_input),
              },
            );
            try {
              appendEvent(projectSlug, runId, event);
            } catch { /* non-critical — don't crash the lens */ }
          }
          return { hookEventName: 'PostToolUse' };
        }],
      }],

      // Log tool failures for debugging
      PostToolUseFailure: [{
        hooks: [async (input: any) => {
          if (runId && projectSlug) {
            const event = createEvent(
              runId, lensName, 'error',
              `Tool failed: ${input.tool_name} — ${input.error}`,
              {
                tool: input.tool_name,
                error: input.error,
                is_interrupt: input.is_interrupt,
              },
            );
            try {
              appendEvent(projectSlug, runId, event);
            } catch { /* non-critical */ }
          }
          return { hookEventName: 'PostToolUseFailure' };
        }],
      }],
    };
  }
}

// ─── Helpers ───

function buildLensPrompt(prompt: string, context: Record<string, any>): string {
  const parts: string[] = [];

  if (context.run_id) {
    parts.push(`[run_id: ${context.run_id}]`);
  }

  if (context.researchOutput) {
    parts.push('## Research Output (from prior phase)\n' + context.researchOutput);
  }

  if (context.priorLensOutput) {
    parts.push('## Prior Lens Output\n' + context.priorLensOutput);
  }

  if (context.feedback) {
    parts.push('## Feedback from Pav\n' + context.feedback);
  }

  parts.push(prompt);

  return parts.join('\n\n');
}

/**
 * Truncate tool input for event logging — avoid bloating events.jsonl
 * with massive file contents or search results.
 */
function truncateForLog(input: any): any {
  if (!input) return input;
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  if (str.length <= 500) return input;
  return typeof input === 'string' ? str.slice(0, 500) + '...' : JSON.parse(JSON.stringify(input, (_, v) =>
    typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '...' : v
  ));
}
