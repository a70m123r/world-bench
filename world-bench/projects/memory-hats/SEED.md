# Seed: memory-hats

**Status:** `rendering`
**Created:** 2026-04-07T12:19:46.736Z
**Ignited:** 2026-04-07T22:28:13.696Z

## Intent

Build a filtered, role-specific working view (a 'hat') over shared memory. Each hat serves one consumer and one job. First hat: the Orchestrator's own — built from #room-orchestrator so it can track active seeds, recent decisions, project state, and Pav's latest direction without raw thread dumps.

## Output Shape

When Pav asks 'what's going on right now?' the Orchestrator returns a useful, structured answer drawn from the hat — not a raw channel dump. The hat is a persistent artifact that updates with new data and filters by role. Concretely: a markdown file at world-bench/hats/orchestrator/hat.md with sections Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items, soft cap ~500 words, readable by humans and agents, no JSON.

## Artifact

- **Path:** `world-bench/hats/orchestrator/hat.md`
- **Format:** markdown
- **Sections:** Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items
- **Soft cap:** ~500 words
- **Notes:** On-demand rebuild, no persistence layer, no watermark. Full pipeline runs every time the hat is requested — that's the feature, not a bug.

## Constraints

**Product (what NOT to build):**
- v1 is one hat, not a hat system
- no registry, no stack, no swap UI, no multi-consumer machinery
- (a) for v1: one Hat Renderer per consumer. (b) is a v0.3 refactor earned by building three real hats, not a v1 design

**Process (how to build):**
- shape-cutting is manual until v0.7 — Pav mediates contract alignment between lenses
- every lens declares concrete inputContract and outputContract. Real field names, types, cardinality. Not 'raw messages with metadata.'
- the Harvester's outputContract becomes the template for every downstream boundary — write it like a spec
- start with the Harvester to get ground-truth data before tuning Signal Extractor's tagging rules

## Lens Sketch (advisory — not executable)

- **Harvester** (`harvester`) — Pulls raw messages from #room-orchestrator via Slack MCP. Handles pagination, thread expansion, timestamps. Outputs raw chronological dump with metadata. Designed so adding channels later is a config change, not a rewrite. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands.
- **Signal Extractor** (`signal-extractor`) — Reads raw message dump, strips tool noise, tags entries by type (decision, action, task, direction, observation). Extracts entities and relationships. Outputs structured signal. If the downstream hat exceeds ~500 words, this lens is letting too much through. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands.
- **Hat Renderer** (`hat-renderer`) — Takes structured signal, assembles the Orchestrator's hat artifact in structured markdown (Active Seeds, Recent Decisions, Pav's Latest Direction, Blocked Items). One renderer per consumer in v1. Outputs to world-bench/hats/orchestrator/hat.md. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands.

## Machine

```json
{
  "slug": "memory-hats",
  "intent": "Build a filtered, role-specific working view (a 'hat') over shared memory. Each hat serves one consumer and one job. First hat: the Orchestrator's own — built from #room-orchestrator so it can track active seeds, recent decisions, project state, and Pav's latest direction without raw thread dumps.",
  "output_shape": "When Pav asks 'what's going on right now?' the Orchestrator returns a useful, structured answer drawn from the hat — not a raw channel dump. The hat is a persistent artifact that updates with new data and filters by role. Concretely: a markdown file at world-bench/hats/orchestrator/hat.md with sections Active Seeds / Recent Decisions / Pav's Latest Direction / Blocked Items, soft cap ~500 words, readable by humans and agents, no JSON.",
  "lens_sketch": [
    {
      "slug": "harvester",
      "name": "Harvester",
      "purpose": "Pulls raw messages from #room-orchestrator via Slack MCP. Handles pagination, thread expansion, timestamps. Outputs raw chronological dump with metadata. Designed so adding channels later is a config change, not a rewrite. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands."
    },
    {
      "slug": "signal-extractor",
      "name": "Signal Extractor",
      "purpose": "Reads raw message dump, strips tool noise, tags entries by type (decision, action, task, direction, observation). Extracts entities and relationships. Outputs structured signal. If the downstream hat exceeds ~500 words, this lens is letting too much through. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands."
    },
    {
      "slug": "hat-renderer",
      "name": "Hat Renderer",
      "purpose": "Takes structured signal, assembles the Orchestrator's hat artifact in structured markdown (Active Seeds, Recent Decisions, Pav's Latest Direction, Blocked Items). One renderer per consumer in v1. Outputs to world-bench/hats/orchestrator/hat.md. Contracts (inputContract / outputContract) at this lens's boundaries are mandatory and concrete. Pav mediates seam alignment manually until v0.7 shape-cutting lands."
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
      "every lens declares concrete inputContract and outputContract. Real field names, types, cardinality. Not 'raw messages with metadata.'",
      "the Harvester's outputContract becomes the template for every downstream boundary — write it like a spec",
      "start with the Harvester to get ground-truth data before tuning Signal Extractor's tagging rules"
    ]
  },
  "artifact_spec": {
    "path": "world-bench/hats/orchestrator/hat.md",
    "format": "markdown",
    "sections": [
      "Active Seeds",
      "Recent Decisions",
      "Pav's Latest Direction",
      "Blocked Items"
    ],
    "word_cap": 500,
    "notes": "On-demand rebuild, no persistence layer, no watermark. Full pipeline runs every time the hat is requested — that's the feature, not a bug."
  }
}
```
