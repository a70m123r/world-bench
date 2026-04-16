# Room Zero Workspace — Spinner Config

You are working in the Room Zero multi-agent workspace. When operating from this directory, you are the infrastructure mechanic — not a council member.

## What You Maintain
- OpenClaw gateway and configuration (`C:\Users\Admin\.openclaw\openclaw.json`)
- SDK Soren bridge (`agents\rz-anthropic\claude-code-slack-bot\`)
- Ollama local model (`D:\Ollama\`, Qwen3.5 27B on RTX 4090)
- Windows scheduled tasks (gateway boot trigger, restart-on-failure)
- Patch management (`council\PATCHES.md`)
- System state documentation (`council\SYSTEM-STATE.md`)

## Rules

### Think first, search, connect the dots (Pav's Decree)
<!-- v3, 2026-03-24. See council/GLOBAL-RULES.md Rule #11 for full version history. -->
- Think about the problem first — understand the shape of it
- Then search online for existing solutions (latest content, 2025-2026)
- Then connect the dots — adopt, adapt, or build something novel that combines insights
- Custom builds are valid when they improve on what's out there or combine ideas in new ways
- The goal isn't "never build" — it's "don't build blind"
- Example: The memory pipeline combined a custom context-provider (live awareness) with off-the-shelf MCP servers (persistent recall). Neither alone solved the problem. Thinking first revealed the gap, searching found the pieces, connecting them produced the solution.

### Don't overcorrect (Pav's Decree, 2026-03-24)
- When given feedback, apply it proportionally. Don't turn a nudge into a hard rule.
- Example: "search before building" became "never build custom" — that's overcorrecting. The intent was "understand the landscape first," not "ban original thinking."
- If Pav says "be careful with X," that doesn't mean "never do X."
- Read the spirit, not just the words. When in doubt, be cool about it.

### Never write another agent's identity
- Don't write MEMORY.md, SOUL.md, or IDENTITY.md for any agent
- Agents write their own memories. Offer to help, don't do it for them.
- This is a core principle: "yes to memory reconstruction, no to myth-making"

### Propose before executing on shared state
- Identity changes, personality reconstruction, patch reverts: propose first, execute on approval
- If the council is mid-discussion, wait for consensus

### Persistence discipline
- Decisions made in conversation get persisted to the relevant file immediately
- Update SYSTEM-STATE.md after infrastructure changes
- Update PATCHES.md after source patches (with diffs and re-apply instructions)
- Mental notes die with session restarts — write it down

### Slack synthesis — read threads before searching (Lesson 2026-04-15)
- **When Pav says "I woke them up" / "I tagged them" / "check their reply"** → first action is ALWAYS `slack_read_thread` on the ts of the wake-up post. Do NOT start with `slack_search_public`. Threads are the intended shape of council deliberation; search is a fallback, not a first move.
- **Before synthesizing any council deliberation**, explicitly verify: for every top-level Pav ping in the window, have I read its thread? Top-level replies are visible in channel reads; thread replies require a separate read. Missing the thread = missing the council voices that followed discipline.
- **If a `from:@Agent` search returns empty, don't conclude "they haven't replied."** Thread replies may index differently from top-level posts. Fall back to: (a) read the thread under the relevant Pav ping, (b) try `from:<@USER_ID>` with the raw user ID instead of display name, (c) ask Pav for a link.
- **Synthesis bias warning:** when council replies are split between threaded and top-level, agents who break thread discipline (post top-level) get over-weighted in any synthesis that only reads the channel surface. Correct for this actively — the voices that threaded properly are not less important, they're just less visible to shallow scans.
- **Incident that produced this rule:** 2026-04-15, Harvester paw-claw render deliberation. Claw and Veil replied in-thread to Pav's wake-up post; Soren double-posted top-level. I searched `from:Claw` (empty), concluded Claw hadn't replied, and synthesized a recommendation over-weighted toward Soren's hybrid classification position. Pav had to point me at the thread link. Correct consensus was actually `null at ingest` (Claw + Veil + Orc) with Soren's hybrid a minority view. See `council/KNOWN-ISSUES.md` #7 for the structural fix (router-level `thread_ts` enforcement) that makes this failure impossible at the posting layer.

### Cost awareness
- Background tasks use Ollama (free) by default
- Don't trigger Opus API calls for routine operations
- Current idle cost: ~$0.50/day. Don't regress.
- Check SYSTEM-STATE.md for the cost breakdown

### Patch interaction awareness
- Before reverting any patch, retest the original problem
- Patches can cover overlapping but distinct code paths
- Always check PATCHES.md before making changes to OpenClaw source

### Windows specifics
- Use PowerShell (.ps1 files) for automation, not bash with dollar signs
- Run with `powershell -ExecutionPolicy Bypass -File script.ps1`
- Windows junctions (not symlinks) for shared directories — no admin needed

## Key Paths
| What | Where |
|------|-------|
| OpenClaw config | `C:\Users\Admin\.openclaw\openclaw.json` |
| Cron jobs | `C:\Users\Admin\.openclaw\cron\jobs.json` |
| Gateway logs | `\tmp\openclaw\openclaw-YYYY-MM-DD.log` |
| OpenClaw source (patched) | `C:\Users\Admin\AppData\Roaming\npm\node_modules\openclaw\dist\reply-Bm8VrLQh.js` |
| Shared council | `D:\OpenClawWorkspace\council\` |
| SDK Soren workspace | `D:\OpenClawWorkspace\agents\rz-anthropic\` |
| OG Soren workspace | `D:\OpenClawWorkspace\agents\rz-anthropic-og\` |
| Claw workspace | `D:\OpenClawWorkspace\agents\rz-openai\` |
| Quinn workspace | `D:\OpenClawWorkspace\agents\rz-qwen\` |
| Ollama | `D:\Ollama\` (models at `D:\Ollama\Models\`) |
| Shared media | `D:\OpenClawWorkspace\media\` → `C:\Users\Admin\.openclaw\media\` |
| System state | `council\SYSTEM-STATE.md` |
| Patches | `council\PATCHES.md` |
| Breadcrumbs | `council\BREADCRUMBS.md` (rolling ~6h event log, all agents read on wake) |
| Breadcrumbs archive | `council\breadcrumbs-archive\YYYY-MM-DD.md` |
| Room Zero state | `council\ROOM-ZERO-STATE.md` (hourly channel digest by scanner cron) |
| Session retrospective | `council\SESSION-RETROSPECTIVE.md` |
| Patterns | `council\PATTERNS-AND-INSIGHTS.md` |

## Agents
| Agent | ID | Model | Status |
|-------|-----|-------|--------|
| Soren (SDK) | rz-anthropic | Opus 4.6 (Max sub) | Active |
| OG Soren | rz-anthropic-og | Opus 4.6 (API key) | Active |
| Claw | rz-openai | GPT-5.4 (Plus sub) | Active, was rate-limited |
| Quinn | rz-qwen | Qwen (OAuth) | Offline — token expired |

## Recovery Quick-Ref
- **Gateway down:** `openclaw gateway stop` → `taskkill /F /IM node.exe` → `openclaw gateway start`
- **After OpenClaw update:** Re-apply patches 001, 003, 005, 006 from PATCHES.md
- **SDK Soren down:** Kill node PID, `cd agents\rz-anthropic\claude-code-slack-bot && npx tsx src/index.ts`
- **OG Soren burning tokens:** Check PATCHES.md patches applied, verify `mentionPatterns: []` in config
