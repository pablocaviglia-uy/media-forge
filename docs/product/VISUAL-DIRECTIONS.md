# MediaForge visual directions

**Status:** preliminary Gate B input<br>
**Decision:** not approved yet<br>
**Current recommendation:** Forge OS

These directions apply the same Gate A architecture. Gate B will compare them
on exactly the same screens so visual preference is not confused with different
functionality.

## Direction A — Forge OS

A digital precision workshop: calm, technical and trustworthy, with the source
and result as the most prominent objects.

### Character

- Canvas-first layouts; chrome supports the work rather than advertising tools.
- Flat, purposeful surfaces separated mainly by tone and one-pixel borders.
- Density adapts by workspace: comfortable in Quick Tools, compact in Studio
  and Batch.
- One verdigris/teal brand accent; categories do not receive rainbow colors.
- Processing location is expressed as provenance: `On this device`, `Temporary
  server` or `Offline`.
- Monochrome 20-pixel icon system with consistent 1.5–1.75-pixel strokes.
- Eight-pixel spacing rhythm and 8–12-pixel radii.
- Motion is direct: approximately 120 ms feedback, 180 ms panels and 240 ms
  workspace changes, always respecting reduced motion.

### Conceptual palette

| Role | Light | Dark |
|---|---|---|
| Canvas | `#F2F4F3` | `#0C1110` |
| Panel | `#FCFDFC` | `#141B19` |
| Raised | white/mineral | `#1A2421` |
| Ink | `#151A19` | `#ECF3F0` |
| Muted | `#66716E` | cool mineral gray |
| Brand accent | `#0B8F7E` | `#39D2B4` |

Remote processing uses a separate cool blue. Green remains a completion or
availability state rather than becoming a second brand color.

### Strengths

- Strong coherence across Studio, Batch and technical workflows.
- Distinct expression of the local-first promise.
- Scales to high information density without becoming a dashboard of cards.
- Evolves the current teal identity instead of discarding all recognition.

### Risk

It can feel too technical. Plain-language presets, spacious Quick Tools and
collapsed advanced controls are required counterweights.

## Direction B — Open Desk

A premium editorial desk: lighter, warmer and more guided, with tasks expressed
as verbs and outcomes.

### Character

- More whitespace and fewer permanent panels.
- Warm paper-like surfaces and night-blue ink.
- Cobalt primary accent with discreet mint for local processing.
- Rounded 24-pixel icon system and 14–18-pixel surface radii.
- Contextual drawers hide specialist controls.
- Light mode is the primary expression; Studio receives a purpose-designed
  dark variant.

### Conceptual palette

| Role | Light | Dark |
|---|---|---|
| Canvas | `#F3F0E8` | `#111722` |
| Panel | `#FEFDF9` | `#192130` |
| Raised | warm white | `#222C3D` |
| Ink | `#202A3A` | `#F4F1E8` |
| Muted | `#697080` | cool slate |
| Brand accent | `#3857D6` | `#8297FF` |

### Strengths

- Very approachable for occasional Quick Tool and PDF users.
- Strong editorial hierarchy and friendly onboarding.
- Particularly natural for page-oriented document work.

### Risk

Studio and Batch need a denser variant that may begin to feel like a separate
product. Excessive paper cards would also recreate the catalog problem this
redesign is meant to solve.

## Comparison

| Criterion | Forge OS | Open Desk |
|---|---|---|
| Quick Tools | Very good | Excellent |
| Media Studio | Excellent | Good |
| Document Workspace | Very good | Excellent |
| Batch & Convert | Excellent | Good |
| Scale to 55 routes | Excellent | Very good |
| Initial approachability | Medium | High |
| Local-first identity | Very strong | Moderate |

Forge OS is recommended because the hardest coherence problem lies in Studio
and Batch. Its technical authority can be softened; making Open Desk dense
without fragmenting its identity is harder.

## What can be preserved from v1

- Semantic canvas/recessed/panel/floating surface hierarchy.
- Primary, muted and subtle text roles.
- Normal and strong borders.
- Success, warning and danger semantics.
- UI and mono typography roles.
- Reduced-motion support and direct easing.
- Queue, progress, resizable panels, inspector, preview, controls, notices,
  command/log surfaces, sheets, toasts, drop overlay and scrubber behavior.
- Reproducible icon generation pipeline and offline theme preferences.

## What should be reconsidered

- Thirty-pixel controls and 11-pixel primary labels.
- Five user-selected brand accents before a core identity exists.
- Mixed filled and outlined icon styles.
- A logo that communicates video conversion more than a broader forge.
- A card grid as the primary catalog surface.

## Gate B comparison set

Both directions should be rendered on the same three compositions:

1. Home/catalog desktop.
2. Trim video desktop.
3. Trim video mobile.

The direction is approved only after light/dark and responsive behavior are
reviewed on those identical flows.
