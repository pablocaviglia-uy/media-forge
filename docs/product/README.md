# MediaForge product foundation

This directory contains the product and UX foundation for the next version of
MediaForge. It is intentionally separate from the current application: the
documents describe what will be built, but they do not change the shipped UI or
the conversion engine.

## Phase A deliverables

- [Product brief](PRODUCT-BRIEF.md): product promise, audiences, principles,
  scope and measurable UX outcomes.
- [Tool map](TOOL-MAP.md): the 51 baseline tools and four follow-up
  capabilities mapped to shared workspaces and execution modes.
- [Information architecture](INFORMATION-ARCHITECTURE.md): sitemap, route
  model, navigation and canonical end-to-end flows.
- [Low-fidelity wireframes](WIREFRAMES.md): layouts and behavior for the home,
  Quick Tools, Media Studio, Document Workspace and Batch & Convert.
- [Visual directions](VISUAL-DIRECTIONS.md): preliminary Gate B comparison
  between two original visual systems.

## Approval gates

1. **Gate A — product structure:** approve the product brief, tool grouping,
   sitemap and low-fidelity flows.
2. **Gate B — visual direction:** compare two visual systems and approve one.
3. **Gate C — interactive prototype:** validate representative tasks before
   production UI implementation.
4. **Gate D — implemented foundation:** approve the new shell and migration of
   current tools before broad feature expansion.

## Current status

- **Gate A approved:** the product structure and 55-route map are the working
  contract.
- **Gate B approved:** Forge OS is the selected visual direction.
- **Gate C ready for review:** the interactive vertical now includes the new
  shell, intent search, workspace launcher, nine honest catalogue entry
  points, five focused Quick Tools and the first multi-file Studio project:
  merge video. Quick Tools cover trim, crop, rotate, flip and resize video.
  Each one has a local-first preview, purpose-built controls, source/result
  review and recoverable processing states.

The active checkpoint is **Gate C — interactive prototype**. The legacy shell
remains available with `?ui=legacy` while the new foundation is validated.
