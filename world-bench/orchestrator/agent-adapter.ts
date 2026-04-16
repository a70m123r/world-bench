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

      // v0.8 Phase B: stream the lens's assistant-text narrative live to its
      // lens channel as each turn arrives (not batched to end-of-run). This is
      // what Pav actually cares about — the "Clean run. All 9 channels..." prose,
      // progress tables, diagnostic narrative. Tool-use heartbeats (wrenches) are
      // the lightweight "I'm alive" ticker; this is the real signal.
      const streamTerminal: any = context.terminal;
      const streamLensId: string = context.lensId || '';
      const streamLensConfig: LensConfig | undefined = context.lensConfig;
      const streamProjectSlug: string = context.projectSlug || '';
      const streamEnabled = !!(streamTerminal && streamLensId && streamLensConfig && streamProjectSlug);
      const streamTextToLens = async (text: string): Promise<void> => {
        if (!streamEnabled) return;
        const trimmed = text.trim();
        // Skip empty or trivial acknowledgement strings that would spam the channel.
        if (trimmed.length < 20) return;
        try {
          const MAX = 3500;
          if (trimmed.length <= MAX) {
            await streamTerminal.postToLensChannel(streamProjectSlug, streamLensId, streamLensConfig!, trimmed);
          } else {
            for (let i = 0; i < trimmed.length; i += MAX) {
              await streamTerminal.postToLensChannel(streamProjectSlug, streamLensId, streamLensConfig!, trimmed.slice(i, i + MAX));
            }
          }
        } catch { /* non-critical — don't crash the run for a Slack post */ }
      };

      for await (const message of q) {
        if (abortController.signal.aborted) break;

        // v0.6.9: capture session_id from ANY message that has it.
        // The SDK emits session_id on every message type (system, assistant,
        // result, etc.), not just the system/init message. The original code
        // only checked system/init, which may not fire for all spawn modes
        // (e.g., resume). Capture from the first message that has it.
        if (!lensSessionId && (message as any).session_id) {
          lensSessionId = (message as any).session_id;
          console.log(`[AgentAdapter] Captured sessionId: ${lensSessionId!.slice(0, 8)} from message type: ${message.type}`);
        }

        // Track user message IDs for file checkpointing rewind targets
        if (message.type === 'user' && (message as any).message?.id) {
          lastUserMessageId = (message as any).message.id;
        }

        if (message.type === 'assistant' && message.message) {
          if (typeof message.message === 'string') {
            messages.push(message.message);
            await streamTextToLens(message.message);
          } else if (message.message.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                messages.push(block.text);
                await streamTextToLens(block.text);
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

    // v0.6.6: lens channel streaming context. Threaded from
    // render_lens → executeRun → runLens → baseContext → here.
    const terminal: any = context.terminal;  // Terminal instance (any to avoid circular import)
    const lensId: string = context.lensId || '';
    const verbose: boolean = context.verbose || false;

    // Helper: post to lens channel (non-critical — swallows errors)
    const streamToLens = async (text: string): Promise<void> => {
      if (!terminal || !lensId || !lensConfig || !projectSlug) return;
      try {
        await terminal.postToLensChannel(projectSlug, lensId, lensConfig, text);
      } catch { /* non-critical — don't crash the lens for a Slack post */ }
    };

    // Rate-limit state for streaming: batch consecutive same-tool calls
    // within a 2-second window to stay under Slack's ~1 msg/sec limit.
    let lastStreamedTool = '';
    let lastStreamedTime = 0;
    let batchedCount = 0;

    // v0.8: tool filter for the always-on render streaming.
    // Meaningful tools stream by default (Pav sees live progress).
    // Noisy tools stay silent unless `verbose` is explicitly on.
    // Errors and escalations always stream (handled elsewhere in the hook).
    const MEANINGFUL_TOOLS = new Set([
      'Bash',
      'Edit',
      'MultiEdit',
      'Write',
      'NotebookEdit',
      'Task',
      'WebFetch',
      'WebSearch',
    ]);
    const isMeaningful = (toolName: string): boolean => {
      if (MEANINGFUL_TOOLS.has(toolName)) return true;
      // MCP tools with side-effects (posting, creating, deleting) are meaningful.
      // Read-only MCP tools (search, list, read) stay suppressed to avoid spam.
      if (toolName.startsWith('mcp__')) {
        const lowered = toolName.toLowerCase();
        if (lowered.includes('send') || lowered.includes('post') || lowered.includes('create')
          || lowered.includes('update') || lowered.includes('delete') || lowered.includes('write')) {
          return true;
        }
      }
      return false;
    };

    // v0.6.5.8: prefix matching for denied tools. Entries ending in '*' are
    // treated as prefix matches (e.g. 'mcp__plugin_slack_slack__*' blocks
    // every tool whose name starts with 'mcp__plugin_slack_slack__'). Exact
    // matches still work unchanged. Used to block the default Claude Code
    // plugin Slack MCP so lenses can't accidentally grab it instead of the
    // pre-authenticated internal Slack MCP from mcp-servers.json.
    const isDenied = (toolName: string): boolean => {
      for (const entry of deniedTools) {
        if (entry.endsWith('*')) {
          if (toolName.startsWith(entry.slice(0, -1))) return true;
        } else if (entry === toolName) {
          return true;
        }
      }
      return false;
    };

    return {
      // Permission enforcement via elevation loop
      PreToolUse: [{
        hooks: [async (input: any) => {
          const toolName = input.tool_name || '';

          // If tool is not in the denied list, allow it
          if (!isDenied(toolName)) {
            return { hookEventName: 'PreToolUse', permissionDecision: 'defer' };
          }

          // v0.6.6: Tool is in denied list — run elevation loop (advisory only
          // under bypassPermissions; the SDK ignores the deny decision and runs
          // the tool anyway. Labels renamed from DENIED→AUDIT per council decision
          // 2026-04-10 to reflect that this is observability, not enforcement.)
          console.log(`[AgentAdapter] AUDIT: tool not in allowed set: ${toolName} by ${lensName}`);

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
              console.log(`[AgentAdapter] AUDIT/ESCALATE (advisory): ${toolName} for ${lensName} — ${evaluation.reason}`);
              const event = createEvent(
                runId, lensName, 'elevation_request',
                `Needs Pav: ${evaluation.reason}`,
                { tool: toolName, lens_name: lensName, decision: 'escalate', reason: evaluation.reason },
              );
              try { appendEvent(projectSlug, runId, event); } catch { }
              // v0.6.6: stream escalation to lens channel (always, not just verbose)
              await streamToLens(`:lock: AUDIT/ESCALATE: \`${toolName}\` — ${evaluation.reason.slice(0, 200)}`);
              // Deny for now — Pav can grant later
              return {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                additionalContext: `Tool "${toolName}" requires approval. Request logged for Pav.`,
              };
            }

            // Explicit deny (advisory under bypassPermissions)
            console.log(`[AgentAdapter] AUDIT/DENIED (advisory): ${toolName} for ${lensName} — ${evaluation.reason}`);
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
            const toolName = input.tool_name || '';
            const event = createEvent(
              runId, lensName, 'message',
              `Tool: ${toolName}`,
              {
                tool: toolName,
                tool_input: truncateForLog(input.tool_input),
              },
            );
            try {
              appendEvent(projectSlug, runId, event);
            } catch { /* non-critical — don't crash the lens */ }

            // v0.8 Phase B: stream tool use to lens channel by default for
            // meaningful tools (Bash/Edit/Write/Task/etc.). Verbose mode adds
            // noisy tools (Read/Grep/Glob). Goal: Pav sees live render progress
            // in #wb-lens-{slug} without the channel becoming tool-call soup.
            const shouldStream = verbose || isMeaningful(toolName);
            if (shouldStream) {
              const now = Date.now();
              const truncInput = typeof input.tool_input === 'string'
                ? input.tool_input.slice(0, 80)
                : JSON.stringify(input.tool_input || '').slice(0, 80);

              // Rate-limit: batch consecutive same-tool calls within 2s window
              if (toolName === lastStreamedTool && (now - lastStreamedTime) < 2000) {
                batchedCount++;
              } else {
                // Flush any batched count from previous tool
                if (batchedCount > 0) {
                  await streamToLens(`:wrench: \`${lastStreamedTool}\`: _(${batchedCount} more call${batchedCount > 1 ? 's' : ''} batched)_`);
                  batchedCount = 0;
                }
                await streamToLens(`:wrench: \`${toolName}\`: ${truncInput}`);
                lastStreamedTool = toolName;
                lastStreamedTime = now;
              }
            }
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
          // v0.6.6: always stream errors to lens channel (exception-only default)
          await streamToLens(`:x: Tool failed: \`${input.tool_name}\` — ${(input.error || '').toString().slice(0, 200)}`);
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
