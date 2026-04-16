# World-Bench v0.5 — Build Audit

**Date:** 2026-04-05
**Builder:** Spinner (Claude Code CLI)
**Spec:** `council/SPEC-orchestrator-v0.5-draft.md` (extends v0.4)
**Branch:** `feat/orchestrator-v0.4`
**PR:** https://github.com/a70m123r/world-bench/pull/1

---

## v0.5 Pillar Status

| Pillar | Spec | Implementation | Gap |
|--------|------|----------------|-----|
| **Permission lifecycle** | Stem→Shaping→Hardened→Dormant | Types + PermissionManager built | Elevation loop not wired into PreToolUse hook; hardening suggestions logged but not prompted to Pav; break glass not connected |
| **Structured output** | SDK tool-use routing | Action.json file write | Not using SDK tool_use — still a file-based pattern. Works but doesn't match spec. |
| **Lens resume** | SDK session resume | Session IDs captured + persisted in lens.json | No public `resumeLens()` method; Pav has no way to trigger resume from Slack |

---

## What Works

| Feature | Status | Verified |
|---------|--------|----------|
| All v0.4 baseline features | Working | First loop tested, council verified |
| Permission types + tier system | Defined | `LensPermissions` with stem/shaping/hardened |
| PermissionManager elevation logic | Built | `evaluateElevation()` handles grant/deny/escalate |
| PermissionManager hardening detection | Built | `updateToolUsage()` detects convergence after 3 runs |
| PreToolUse hook (denial enforcement) | Working | Denied tools blocked at runtime |
| PostToolUse hook (tool logging) | Working | Tool calls auto-logged to events.jsonl |
| Lens session ID capture | Working | Captured from SDK init message |
| Lens session ID persistence | Working | Saved to lens.json after each run |
| SDK resume wiring | Working | `options.resume` passed if sessionId exists |
| Action.json dispatch | Working | Orchestrator reads + consumes action files |
| Stem cell defaults on new lenses | Working | Every new lens gets stem permissions |

---

## What's Not Wired

These are built but not connected to the execution path:

### 1. Elevation Loop Disconnected (HIGH)

`agent-adapter.ts` PreToolUse hook denies tools based on a hardcoded `deniedTools` list. It never calls `PermissionManager.evaluateElevation()`. The entire elevation logic (auto-grant if purpose aligns, escalate if ambiguous) exists in `permission-manager.ts` but isn't invoked.

**Impact:** All tool denials are binary — denied or not. No intelligence, no escalation to Pav.

### 2. Hardening Prompt Not Surfaced (MEDIUM)

`lens-manager.ts` calls `updateToolUsage()` after each run and gets `{ suggest: true }` when tool usage stabilizes. It logs a hardening event to `events.jsonl` — but the Orchestrator never reads it, never prompts Pav, never calls `hardenLens()`.

**Impact:** Hardening never happens. All lenses stay in their initial tier forever.

### 3. Break Glass Not Connected (MEDIUM)

`PermissionManager.reopenForShaping()` exists but nothing calls it. If a hardened lens hits a denied tool, the PreToolUse hook just denies it — no re-evaluation, no offer to reopen shaping.

### 4. Resume Has No User-Facing Trigger (MEDIUM)

Session IDs are persisted and the SDK `options.resume` is wired. But there's no `resumeLens()` method, no action, no way for Pav to say "continue this lens with new feedback."

### 5. Structured Output Is Still File-Based (LOW)

Spec says SDK tool-use routing. Implementation uses `action.json` file writes. This works and is an improvement over JSON-in-system-prompt (no regex parsing), but doesn't match the spec.

---

## Bugs Found

| # | Bug | Severity | File |
|---|-----|----------|------|
| 1 | Sandbox defaults include Write/Edit — spec says stem should deny these, but Pav decided "light guardrails" (only Bash denied). **Not a bug — intentional deviation from spec per Pav's direction.** | INFO | types.ts |
| 2 | `evaluateElevation()` never called from execution path | HIGH | agent-adapter.ts |
| 3 | Hardening suggestion events logged but never acted on | MEDIUM | lens-manager.ts |
| 4 | Context provider timeout swallowed silently | LOW | context-provider.ts |
| 5 | `(productionResult as any).sessionId` — cast to any instead of using ClaudeAgentResult type | LOW | lens-manager.ts |
| 6 | `PermissionManager.saveLensConfig()` has empty catch block | LOW | permission-manager.ts |

---

## Dead Code

| Code | File | Reason |
|------|------|--------|
| `PermissionManager.denyTool()` | permission-manager.ts | Never called — denials happen in hook |
| `PermissionManager.reopenForShaping()` | permission-manager.ts | Break glass not wired |
| `AgentAdapter.kill()` | agent-adapter.ts | `getAbortController()` used instead |
| `extractJSON()` | index.ts | Replaced by action.json pattern but function still exists |
| Hardening suggestion event handler | lens-manager.ts | Logged, never acted on |

---

## Intentional Spec Deviations

| Spec Says | Reality | Why |
|-----------|---------|-----|
| Stem cells deny Write/Edit | Write/Edit allowed from birth | Pav's explicit decision: "keep it pretty free, dial in permissions as we go" |
| SDK tool-use routing for actions | Action.json file write | Incremental improvement over JSON-in-prompt. Tool-use is the ideal but file-based works now. |
| 3 consecutive runs for hardening | Implemented but not surfaced | Tracking runs silently, prompt will come when wiring is complete |

---

## Architectural Notes

1. **PermissionManager is ~30% utilized.** The class has comprehensive logic but only `getEffectiveTools()` and `updateToolUsage()` are called. The rest is designed but awaiting wiring.

2. **Action dispatch via disk file is fragile** but functional. No TOCTOU race at current concurrency (1 lens at a time). Would break at scale.

3. **Context provider timeout is silent.** If Slack is slow, Claude gets zero context and may hallucinate. Should log as degradation event.

4. **Memory MCP available but unused.** Orchestrator has knowledge graph tools but doesn't systematically build entities. This is expected — memory accumulates through conversation, not infrastructure.

---

## File Manifest (v0.5)

```
world-bench/
  CLAUDE.md
  package.json (v0.4.0 — should bump to v0.5.0)
  tsconfig.json
  mcp-servers.json
  start-orchestrator.cmd
  start-orchestrator.ps1
  .gitignore

  agents/
    types.ts                          # + LensPermissions, ClaudeAgentResult.sessionId
    base-lens-agent.ts

  orchestrator/
    index.ts                          # + action.json dispatch, context provider
    terminal.ts                       # + app_mention handler
    agent-adapter.ts                  # + PreToolUse hook, resume wiring, session capture
    lens-manager.ts                   # + permission enforcement, session persistence, hardening tracking
    event-log.ts
    context-provider.ts
    permission-manager.ts             # NEW — elevation loop, hardening, break glass
    config/.env
    memory/
    sessions.json

  mcp-servers/
    slack-mcp-server/                 # Own copy with Orchestrator's bot token

  projects/                           # Runtime data (git-ignored)
  research/                           # 30 pre-build research docs
  docs/
    BUILD-AUDIT-v0.4.md
    BUILD-AUDIT-v0.5.md               # This file
```

---

## Honest Assessment

v0.5 is **architecturally complete but execution-incomplete**. The permission lifecycle, structured output, and lens resume are all designed and partially built. The types, interfaces, and manager classes exist. But the wiring between components has gaps — the elevation loop is the biggest one.

For practical use today: the Orchestrator works. Lenses spawn, research, produce, post to Slack. Session continuity works. Permissions track silently. The gaps are in the automation layer — hardening prompts, escalation flows, break glass — which are quality-of-life features, not blockers for running projects.

**Recommendation:** Ship as v0.5-beta. Wire the elevation loop and hardening prompt as the first v0.5.1 patch. The rest can come as Pav uses the system and discovers what matters.
