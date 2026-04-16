# Shoots — memory-hats

> The seed is the intent. The shoots are what's growing from it.
> Updated by the Orchestrator after renders, meets, settling changes, and decisions.
> Read by Pav, the council, and lenses for situational awareness.

**Project:** Memory Hats
**Seed:** `SEED.md` — build a filtered, role-specific working view over shared memory
**Phase:** Pipeline proven — first clean end-to-end rehearsal complete. Output shape met.

---

## Pipeline

```
Harvester → Signal Extractor → Hat Renderer
   ✓            ✓                  ✓
  steady       steady           settling
  836 msgs     17 compiled      hat_version 3
  Bash x1      27s clean        520 words
```

**Architecture:** Karpathy LLM Wiki pattern — raw sources → compiled wiki → presentation.
**Compression:** 836 messages → 781 signals → 17 compiled pages → 520-word hat (~160:1)

---

## Lens Status

| Lens | Maturity | Renders | Last Run | Duration | Output | Next Action |
|------|----------|---------|----------|----------|--------|-------------|
| **Harvester** | `steady` | 10+ | 2026-04-14 | ~4.5min | 836 msgs → harvest.json | Done |
| **Signal Extractor** | `steady` | 6+ | 2026-04-14 | ~27s | signal.json + compiled/ (17 pages) | Fix seed page quality regression |
| **Hat Renderer** | `settling` | 3 | 2026-04-14 | ~4.5min | hat.md v3 (520 words) | 1 more clean render → steady |

---

## Rehearsals

| # | Date | Status | Notes |
|---|------|--------|-------|
| 1 | 2026-04-14 01:30Z | partial | Harvester ✓, SE ✗ (30-turn limit), Hat Renderer ✓ (used stale compiled/) |
| 2 | 2026-04-14 03:16Z | **complete** | All three ✓. First clean end-to-end. hat_version 3 produced. |
| 3 | 2026-04-14 13:24Z | **complete** | Hat refresh. hat_version 4. Captured hat-swapping + eval discussions. |
| 4 | 2026-04-15 03:46Z | **complete** | SE quality fix + hat v5. first_sentences() applied but decision clusters mis-anchored. |

---

## Known Quality Issue — Decision Cluster Mis-anchoring

**Root cause:** extract_v4.py topic_map regex patterns are too broad.
- `v0.6` matches "settling|steady|discover" → 109 signals in one cluster (catch-all)
- `v0.5` matches "audit" → pulls run audits, council audits
- `karpathy` matches "compiled.*dir" → pulls hat-swapping discussion

**Effect:** Wrong threads → wrong anchors → factually incorrect decision summaries. Hat Renderer compensates using memory of prior clean versions but flags confidence as `medium`.

**Fix options (posted to council for input):**
- A: Tighten regexes (quick, fragile)
- B: Thread-first clustering (robust, structural)
- C: Decision-statement extraction (find "my position:" / "approved" / "consensus:")
- Orchestrator recommends B+C (v5 rewrite of clustering logic)

---

## Decisions Made

| Date | Decision | By | Evidence |
|------|----------|-----|---------|
| 2026-04-09 | Flat array with threadTs pointers | Harvester + Orc | Meet session |
| 2026-04-11 | Maturity lifecycle adopted (4 phases) | Council unanimous | Spec v2 |
| 2026-04-13 | Karpathy LLM Wiki pattern adopted | Council + Pav | SE → compiled/ directory |
| 2026-04-14 | Claw's acceptance gate: Hat reads compiled/ only | Claw + council | Unanimous |
| 2026-04-14 | Hat sections: 6 with staleness + confidence | Council consensus | Claw: fresh ≠ confident |
| 2026-04-14 | SE refactored to data-driven (extract_v4.py) | SE self-diagnosis | 30-turn → 27s |
| 2026-04-14 | Seed amended — Karpathy pattern + evolved design | Orchestrator | amend_seed |
| 2026-04-14 | Hat wired into Orchestrator context loading | Spinner | Hardcoded path, read-only |
| 2026-04-14 | Hat-swapping: filesystem convention, no MCP until N≥5 | Council consensus | Soren's room-zero read |

---

## Open Questions (posted to council)

1. SE decision cluster fix shape — A (tighten regex), B (thread-first), C (decision-statement extraction), or B+C?
2. Eval/test lens design — council favors rehearse verb (Option B) over new lens
3. Is memory-hats ready to close as a seed?

---

_Last updated: 2026-04-15 04:00Z by Orchestrator. Hat v5 produced, SE quality audit posted to council._
