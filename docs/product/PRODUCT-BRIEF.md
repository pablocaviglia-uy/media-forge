# MediaForge product brief

**Status:** Gate A proposal<br>
**Scope:** product structure and UX foundation<br>
**Implementation status:** no production UI changes yet

## Product promise

MediaForge is a coherent workspace for editing, converting and preparing media
and documents. It should make a one-off transformation feel immediate while
still giving a user room to grow into a multi-file project without switching to
another product.

The product will not present itself as a directory of unrelated utilities.
Individual tools remain discoverable and linkable, but they open inside a small
set of consistent workspaces that share files, controls, projects, progress and
results.

The defining promise is:

> Start with a file or a goal, understand the next step immediately, and always
> know where the work is being processed.

## Problem to solve

Online conversion suites commonly grow one landing page and one isolated flow
at a time. Their catalogs become difficult to scan, equivalent controls behave
differently, work is lost when moving between tools, and the user has little
visibility into what happens to an uploaded file.

MediaForge already has a strong local media engine, but its current interface
assumes one screen, one selected file and a short operation list. Expanding the
existing controller with dozens of special cases would reproduce the same
fragmentation the new product is meant to avoid.

## Primary audiences

### Occasional user

Needs one obvious result: trim a clip, convert an audio file, combine PDFs or
extract an archive. This user should not need to understand codecs, timelines
or processing infrastructure.

### Content creator

Frequently combines media, changes aspect ratios, adds text or audio, produces
several outputs and wants predictable reusable controls.

### Power user

Works with batches, presets, exact output settings and logs. This user values
transparent commands, keyboard access and control over local versus remote
execution.

### Privacy-sensitive user

Chooses MediaForge because supported work can stay on the device. If a task
requires remote processing, consent and the file lifecycle must be explicit
before transfer begins.

## Product principles

1. **One product, not a tool directory.** Every route belongs to a shared
   workspace and follows the same input, edit, process and result model.
2. **File-first and goal-first are equal.** A user may search for a task first
   or drop a file first and receive compatible actions.
3. **Progressive disclosure.** Common decisions are visible; codec-level and
   specialist controls are available without dominating the default view.
4. **Preview before commitment.** Editing views show the affected range, page,
   frame or waveform whenever the operation permits it.
5. **Processing is legible.** Local, remote and hybrid modes are named in plain
   language, with consequences shown before a file is transferred.
6. **State is never mysterious.** Ready, processing, paused, cancelled, failed,
   completed and expired states have distinct, recoverable behavior.
7. **Depth without clutter.** Professional capability comes from context,
   shortcuts and consistent inspectors rather than permanently visible panels.
8. **Accessibility is structural.** Keyboard navigation, focus order, semantic
   controls, contrast and reduced motion are designed with each primitive.
9. **Original expression.** Copy, navigation, iconography, component shapes and
   visual hierarchy are created for MediaForge rather than imitating a
   competitor.

## Product model

The public catalog is expressed through four workspace types:

| Workspace | Best for | Defining interaction |
|---|---|---|
| Quick Tools | One focused transformation | Drop, adjust, preview, export |
| Media Studio | Multi-asset audio/video projects | Canvas or waveform plus timeline and inspector |
| Document Workspace | Page-oriented PDF work | Thumbnail selection, ordering and page operations |
| Batch & Convert | Repeated or multi-file output | Table, preset, queue and results |

Tools are presets over these workspaces. For example, `Rotate video` and
`Resize video` both open Quick Tools with a different focused control, while
`Add text to video` opens Media Studio with a text layer ready to add.

## Global experience

### Home

The home is an intent launcher, not a wall of every available tool. Its primary
actions are global search and file drop. Once a file is known, MediaForge
suggests only compatible outcomes. Four workspace entry points and recent local
projects provide secondary navigation.

### Tool route

Every public tool has a stable localized route for sharing and discovery. The
route supplies the workspace with a preset, accepted inputs, focused control,
default output and supporting help. It does not fork the implementation.

### Project

A project owns source assets, non-destructive edits, outputs and processing
history. Quick tasks may remain ephemeral; Studio and Document projects can be
saved locally and reopened. Remote bytes are never implied by the presence of a
project record.

### Jobs and results

All local and remote work appears in one jobs surface with consistent progress,
cancellation, retry and output actions. Results remain attached to their source
task so the user can revise settings instead of starting over.

## Processing modes

### On this device

- Default whenever the browser and selected operation support it.
- No upload.
- Available offline after the required engine has been cached.
- Subject to browser memory, format and performance limits.

### Secure server processing

- Used for large files, Office conversion, specialist formats and operations
  whose quality is not practical in the browser.
- Requires explicit confirmation before the first byte is uploaded.
- Shows retention and deletion behavior in the confirmation and job details.
- Supports resumable upload, cancellation and explicit early deletion.

### Choose for me

- The planner recommends a mode using capability, file size and expected work.
- It never silently changes from local to remote.
- A recommendation explains the relevant trade-off in one sentence.

## In scope for functional parity

- 51 baseline public tool routes across video, audio, PDF and conversion.
- Four shared workspaces and a common project/job model.
- Spanish and English routes and interface copy.
- Local-first processing with clearly authorized remote fallback.
- Responsive layouts, keyboard operation and WCAG AA targets.
- Original visual system, navigation, copy and iconography.
- Four adjacent capabilities tracked as the first post-parity extension.

## Out of scope for the parity milestone

- Advertising.
- Copying a competitor's pricing or quota model.
- A marketplace or third-party plugin API.
- Real-time multiplayer editing.
- Social publishing or public media hosting.
- A mobile-native application.

Accounts, cross-device sync and paid plans may be introduced when they solve a
defined project or infrastructure need. They are not prerequisites for a
coherent tool suite.

## UX outcomes

Gate C usability validation should demonstrate that:

- a first-time user can identify how to begin without reading documentation;
- a common quick task requires no more than three meaningful decisions after
  input selection;
- participants can correctly state whether a sample job is local or remote;
- moving from a quick task to Studio retains the selected asset and edits;
- a failed or cancelled job offers an obvious recovery path;
- equivalent output controls behave the same in every workspace;
- every primary flow is operable with keyboard alone.

## Constraints carried forward

- The current FFmpeg command builders, probes, format catalog and fixtures are
  valuable domain code and should be migrated rather than rewritten.
- Heavy engines must be lazy-loaded; opening the catalog must not download all
  processing runtimes.
- The existing GPL distribution and codec/patent implications require an
  explicit product and legal decision before commercialization.
- The current `raw command` capability remains local-only.
- The shipped application stays intact until the replacement shell can run the
  current operations without regressions.

## Gate A decisions

Approval of this brief means accepting:

1. the four-workspace model;
2. file-first and goal-first entry paths;
3. local-first processing with explicit remote consent;
4. localized tool routes backed by shared implementations;
5. design and prototype approval before production UI implementation.
