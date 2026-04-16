# Seed: memory-hats

**Status:** `rendering`
**Created:** 2026-04-07T12:19:46.736Z
**Ignited:** 2026-04-07T22:28:13.696Z

## Intent

Build a filtered, role-specific working view (a 'hat') over shared memory. Each hat serves one consumer and one job. First hat: the Orchestrator's own — built from #room-orchestrator so it can track active seeds, recent decisions, project state, and Pav's latest direction without raw thread dumps.

## Output Shape

When Pav asks 'what's going on right now?' the Orchestrator returns a useful, structured answer drawn from the hat — not a raw channel dump. The hat is a persistent artifact that updates with new data and filters by role. Concretely: a markdown file at world-bench/hats/orchestrator/hat.md with sections Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items / Changelog / Sources, soft cap ~500 words, readable by humans and agents, no JSON. Each section carries staleness and confidence indicators. Source pointers trace back to compiled/ pages for auditability.

## Artifact

- **Path:** `world-bench/hats/orchestrator/hat.md`
- **Format:** markdown
- **Sections:** Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items / Changelog / Sources
- **Soft cap:** ~500 words
- **Notes:** On-demand rebuild, full pipeline runs every time. Each section includes staleness indicator (newest signal timestamp) and confidence level. Source pointers trace to compiled/ pages for auditability. No raw Slack — compiled/ is the only upstream input.

## Constraints

**Product (what NOT to build):**
- v1 is one hat, not a hat system
- no registry, no stack, no swap UI, no multi-consumer machinery
- (a) for v1: one Hat Renderer per consumer. (b) is a v0.3 refactor earned by building three real hats, not a v1 design

**Process (how to build):**
- shape-cutting is manual until v0.7 — Pav mediates contract alignment between lenses
- every lens declares concrete inputContract and outputContract. Real field names, types, cardinality.
- Karpathy LLM Wiki pattern is the architectural foundation: raw sources → compiled wiki → presentation
- Hat Renderer reads compiled/ only — no harvest.json, no raw Slack. If the hat can't be produced from compiled/ alone, the failure belongs upstream (Claw's acceptance gate)
- Hat compiles for action, not elegance: selection over paraphrase, source pointers over smooth prose, 'insufficient evidence' over filler (Claw)
- Each hat section carries staleness (per-section newest signal timestamp) and confidence indicators (Claw)

## Lens Sketch (advisory — not executable)

- **Harvester** (`harvester`) — Pulls raw messages from #room-orchestrator via Slack API (curl + Orchestrator token). Handles pagination, thread expansion, user resolution, timestamps. Outputs harvest.json — flat chronological array with thread pointers. Designed so adding channels later is a config change, not a rewrite.
- **Signal Extractor** (`signal-extractor`) — Reads harvest.json, strips tool noise, tags entries by type (decision, action, direction, observation, status). Resolves entities to canonical IDs. Outputs signal.json (audit trail) + compiled/ markdown directory following Karpathy's LLM Wiki architecture: index.md entry point, entity pages, seed pages, decision pages, direction arcs, blocked items. The compiled/ directory is the sole interface to the Hat Renderer.
- **Hat Renderer** (`hat-renderer`) — Reads ONLY the Signal Extractor's compiled/ markdown directory (Claw's acceptance gate — no harvest.json, no raw Slack). Produces the Orchestrator's hat at world-bench/hats/orchestrator/hat.md. Compiles for action, not elegance — prefers selection over paraphrase, explicit source pointers over smooth prose, 'insufficient evidence' over filler. One renderer per consumer in v1.

## Machine

```json
{
  "slug": "memory-hats",
  "intent": "Build a filtered, role-specific working view (a 'hat') over shared memory. Each hat serves one consumer and one job. First hat: the Orchestrator's own — built from #room-orchestrator so it can track active seeds, recent decisions, project state, and Pav's latest direction without raw thread dumps.",
  "output_shape": "When Pav asks 'what's going on right now?' the Orchestrator returns a useful, structured answer drawn from the hat — not a raw channel dump. The hat is a persistent artifact that updates with new data and filters by role. Concretely: a markdown file at world-bench/hats/orchestrator/hat.md with sections Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items / Changelog / Sources, soft cap ~500 words, readable by humans and agents, no JSON. Each section carries staleness and confidence indicators. Source pointers trace back to compiled/ pages for auditability.",
  "lens_sketch": [
    {
      "slug": "harvester",
      "name": "Harvester",
      "purpose": "Pulls raw messages from #room-orchestrator via Slack API (curl + Orchestrator token). Handles pagination, thread expansion, user resolution, timestamps. Outputs harvest.json — flat chronological array with thread pointers. Designed so adding channels later is a config change, not a rewrite."
    },
    {
      "slug": "signal-extractor",
      "name": "Signal Extractor",
      "purpose": "Reads harvest.json, strips tool noise, tags entries by type (decision, action, direction, observation, status). Resolves entities to canonical IDs. Outputs signal.json (audit trail) + compiled/ markdown directory following Karpathy's LLM Wiki architecture: index.md entry point, entity pages, seed pages, decision pages, direction arcs, blocked items. The compiled/ directory is the sole interface to the Hat Renderer."
    },
    {
      "slug": "hat-renderer",
      "name": "Hat Renderer",
      "purpose": "Reads ONLY the Signal Extractor's compiled/ markdown directory (Claw's acceptance gate — no harvest.json, no raw Slack). Produces the Orchestrator's hat at world-bench/hats/orchestrator/hat.md. Compiles for action, not elegance — prefers selection over paraphrase, explicit source pointers over smooth prose, 'insufficient evidence' over filler. One renderer per consumer in v1."
    }
  ],
  "status": "rendering",
  "created_at": "2026-04-07T12:19:46.736Z",
  "created_at_turn_id": "b09f5d73-f5b0-49d9-82b9-b4d0c69abb7d",
  "ignited_at": "2026-04-07T22:28:13.696Z",
  "ignited_at_turn_id": "5b082735-a9ae-4f37-87a7-efe4cf3d76d0",
  "constraints": {
    "product": [
      "v1 is one hat, not a hat system",
      "no registry, no stack, no swap UI, no multi-consumer machinery",
      "(a) for v1: one Hat Renderer per consumer. (b) is a v0.3 refactor earned by building three real hats, not a v1 design"
    ],
    "process": [
      "shape-cutting is manual until v0.7 — Pav mediates contract alignment between lenses",
      "every lens declares concrete inputContract and outputContract. Real field names, types, cardinality.",
      "Karpathy LLM Wiki pattern is the architectural foundation: raw sources → compiled wiki → presentation",
      "Hat Renderer reads compiled/ only — no harvest.json, no raw Slack. If the hat can't be produced from compiled/ alone, the failure belongs upstream (Claw's acceptance gate)",
      "Hat compiles for action, not elegance: selection over paraphrase, source pointers over smooth prose, 'insufficient evidence' over filler (Claw)",
      "Each hat section carries staleness (per-section newest signal timestamp) and confidence indicators (Claw)"
    ]
  },
  "artifact_spec": {
    "path": "world-bench/hats/orchestrator/hat.md",
    "format": "markdown",
    "sections": [
      "Active Seeds",
      "Recent Decisions",
      "Pav's Latest Direction",
      "Blocked Items",
      "Changelog",
      "Sources"
    ],
    "word_cap": 500,
    "notes": "On-demand rebuild, full pipeline runs every time. Each section includes staleness indicator (newest signal timestamp) and confidence level. Source pointers trace to compiled/ pages for auditability. No raw Slack — compiled/ is the only upstream input."
  }
}
```
