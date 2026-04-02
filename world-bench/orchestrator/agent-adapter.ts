// World-Bench v0.4 — Agent Adapter
// Type boundary: one implementation now (Claude), interface stays for future SDKs.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuid } from 'uuid';
import { AgentAdapter, AgentResult, WorkflowEvent } from '../agents/types';

export class ClaudeAgentAdapter implements AgentAdapter {
  private activeAgents: Map<string, AbortController> = new Map();

  async spawn(
    prompt: string,
    tools: string[],
    context: Record<string, any>,
  ): Promise<AgentResult> {
    const agentId = uuid();
    const abortController = new AbortController();
    this.activeAgents.set(agentId, abortController);

    const events: WorkflowEvent[] = [];
    let output = '';

    try {
      const options: any = {
        outputFormat: 'stream-json',
        permissionMode: 'bypassPermissions',
        model: 'claude-sonnet-4-6',
        systemPrompt: context.systemPrompt || '',
        cwd: context.cwd || process.cwd(),
        maxTurns: context.maxTurns || 10,
        abortController,
      };

      // Inject allowed tools if specified
      if (tools.length > 0) {
        options.allowedTools = tools;
      }

      // Build the full prompt with injected context
      const fullPrompt = buildLensPrompt(prompt, context);

      const messages: string[] = [];

      for await (const message of query({ prompt: fullPrompt, options })) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant' && message.message) {
          // Collect text output from assistant messages
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

          // Create a completion event
          events.push({
            id: uuid(),
            timestamp: new Date().toISOString(),
            run_id: context.run_id || '',
            actor: context.lens_name || 'unknown-lens',
            type: 'state_change',
            content: `Lens completed: ${context.lens_name}`,
            metadata: { agent_id: agentId, status: 'completed' },
          });
        }
      }

      this.activeAgents.delete(agentId);

      return {
        id: agentId,
        status: 'completed',
        output: output || messages.join('\n\n'),
        events,
      };
    } catch (error: any) {
      this.activeAgents.delete(agentId);

      events.push({
        id: uuid(),
        timestamp: new Date().toISOString(),
        run_id: context.run_id || '',
        actor: context.lens_name || 'unknown-lens',
        type: 'error',
        content: `Lens failed: ${error.message}`,
        metadata: { agent_id: agentId, error: error.message },
      });

      return {
        id: agentId,
        status: 'failed',
        output: `Error: ${error.message}`,
        events,
      };
    }
  }

  async kill(id: string): Promise<void> {
    const controller = this.activeAgents.get(id);
    if (controller) {
      controller.abort();
      this.activeAgents.delete(id);
    }
  }
}

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
