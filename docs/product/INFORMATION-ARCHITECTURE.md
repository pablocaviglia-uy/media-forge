# MediaForge information architecture

**Status:** Gate A proposal<br>
**Route model:** `/{locale}/{category}/{tool}`<br>
**Supported launch paths:** goal-first, file-first and project-first

## Mental model

The interface exposes five stable object types:

| Object | What the user understands | What it owns |
|---|---|---|
| Asset | A source file | Metadata, availability and a local or remote handle |
| Tool | A focused outcome | Accepted inputs, defaults, controls and help |
| Project | Editable work | Assets, non-destructive operations, history and outputs |
| Job | Work in progress | Execution mode, stage, progress, cancellation and errors |
| Result | A produced file or set | Preview, metadata, download and next actions |

A tool is not an application. It is a route and a preset that opens a project
inside one of four workspaces.

## Global shell

### Desktop navigation

- **New:** opens the global launcher.
- **Home:** intent search, file drop, recent projects and activity.
- **Studio:** creates or resumes a media composition.
- **Documents:** creates or resumes a page-oriented project.
- **Batch:** creates or resumes a multi-file conversion.
- **Projects:** recent, pinned and recoverable local projects.
- **Jobs:** persistent tray for local and remote processing.
- **Help and Settings:** separated from creation navigation.

Quick Tools do not occupy a permanent navigation item. They are opened through
search, file suggestions, recent actions or stable public URLs.

### Mobile navigation

- Top bar: current context and jobs.
- Bottom bar: Home, Projects, New and Jobs.
- `New` opens the launcher full-screen.
- Inspectors become contextual bottom sheets.
- Drag actions always have tap and keyboard-accessible equivalents.

## Sitemap

```text
/{locale}/
├── video/
│   └── {localized-tool-slug}/
├── audio/
│   └── {localized-tool-slug}/
├── pdf/
│   └── {localized-tool-slug}/
├── {localized-convert-slug}/
│   └── {localized-tool-slug}/
├── studio/
│   ├── new/
│   └── project/{project-id}/
├── documents/
│   ├── new/
│   └── project/{project-id}/
├── batch/
│   ├── new/
│   └── project/{project-id}/
├── projects/
├── jobs/
│   └── {job-id}/
├── formats/
│   └── {format-id}/
├── help/
│   └── {article-slug}/
├── privacy/
├── security/
└── about/
```

Public tool routes use localized slugs. Project and job identifiers remain
language-neutral so changing locale never changes ownership or history.

Examples:

- `/es/video/cortar`
- `/en/video/trim`
- `/es/pdf/combinar`
- `/en/pdf/merge`
- `/es/convertir/audio`
- `/en/convert/audio`

Locale changes map between route aliases through a stable internal `toolId`.

## Tool route contract

Every public tool definition provides:

```text
toolId
category
workspace
localized slug, name, summary and help
accepted input kinds and cardinality
output kinds and cardinality
focused control and default values
local, remote or hybrid execution policy
capability and size limits
compatible next actions
```

The page has two modes:

1. **No input:** explains the concrete result in one sentence and asks for a
   valid file, folder or recording source.
2. **Input available:** enters the configured workspace immediately and moves
   explanatory content behind contextual help.

## Home hierarchy

The home deliberately does not render all tools at once.

1. Global intent search: “What do you want to make?”
2. Drop zone and file/folder picker.
3. Suggested actions for the current file selection.
4. Recent projects and recoverable work.
5. Four workspace entry points.
6. A compact browse-all link for users who prefer a catalog.

After files are dropped, generic suggestions are replaced by compatible tasks.
Unsupported tools explain why they are unavailable rather than disappearing
without context.

## Launcher and search

The launcher is shared by the New action and `Cmd/Ctrl+K`.

It searches:

- actions: cut, join, protect, extract;
- outcomes: smaller file, ringtone, pages as images;
- formats: MOV to MP4, PDF to Word;
- colloquial synonyms in the active locale;
- recent tools and presets.

Results are compact rows, not promotional cards. A result shows the outcome,
accepted input, workspace and processing mode. Optional facets filter by media
type, goal and local/remote availability without replacing direct search.

## Canonical flows

### File-first

```text
Import
  → validate and probe
  → show compatible outcomes
  → select a tool
  → open its configured workspace
  → edit and preview
  → confirm execution mode
  → process
  → inspect result
  → download or continue with another action
```

### Goal-first

```text
Search or open a tool URL
  → show accepted input
  → import
  → validate and probe
  → edit and preview
  → process
  → result
```

### Project-first

```text
Open a recent project
  → restore non-destructive state
  → reconnect source files when required
  → continue editing
  → export a new snapshot
```

### Quick Tool to Studio

```text
Complete or preview a quick edit
  → choose “Continue in Studio”
  → preserve source, trim, transform and output intent
  → represent the quick operation as editable timeline state
```

### Remote execution

```text
Planner identifies remote requirement
  → explain why and name the file
  → show retention and local alternative
  → receive explicit consent
  → resumable upload
  → queued processing
  → result and optional immediate deletion
```

MediaForge must never switch from local to remote silently.

## Workspace responsibilities

### Quick Tools

- One dominant transformation.
- Large preview or page/waveform representation.
- Contextual inspector with essential settings.
- Advanced output settings collapsed by default.
- Source/result comparison and chained next actions.

### Media Studio

- Asset library, canvas, inspector and timeline.
- Multiple tracks and assets.
- Non-destructive command history.
- Export creates a job snapshot; editing may continue.
- Timeline also has a semantic list representation.

### Document Workspace

- Source document rail and page board.
- Range and multiple selection.
- Reordering by pointer, keyboard and explicit commands.
- Inspector acts on the current page or selection.
- Originals stay immutable.

### Batch & Convert

- File table, preset, destination and preflight.
- Validation and estimated output per file.
- Independent statuses and retries.
- Successful results remain downloadable when other rows fail.

## Shared state contract

| State | Required behavior |
|---|---|
| Empty | Name the result, accepted input and primary way to begin. |
| Analyzing | Show the actual stage, file identity and cancellation. |
| Editing | Preserve source, expose preview and keep the primary action visible. |
| Processing | Move the job to the global tray without blocking navigation. |
| Error | Preserve project state, explain recovery and expose copyable details. |
| Complete | Preview result, compare metadata and offer download plus next actions. |
| Expired | Preserve the recipe while explaining that remote bytes are gone. |

## Responsive behavior

- At desktop widths, the shell may expose a navigation rail, central workspace
  and contextual inspector simultaneously.
- On tablets, navigation collapses and inspectors overlay without covering the
  primary preview permanently.
- On phones, one surface owns the viewport; contextual areas become tabs or
  bottom sheets and primary actions remain in a bottom action bar.
- Tables become expandable rows instead of horizontally compressed grids.
- Timeline horizontal scrolling is intentional; the rest of the application
  must not require horizontal page scrolling.

## Accessibility contract

- WCAG 2.2 AA is the target.
- Every pointer manipulation has an explicit control alternative.
- Timeline and page order are available as semantic lists.
- Waveforms always have numeric time inputs.
- Progress announcements are throttled live-region updates.
- Focus returns to its trigger after dialogs and sheets close.
- Errors receive focus through a summary linked to affected fields.
- Controls work at 200% zoom and at 320 CSS pixels.
- Touch targets are at least 44 by 44 CSS pixels.
- Color is never the only carrier of state.

## Navigation acceptance checks

- A source asset survives changing between compatible tools.
- Browser Back returns to the prior context without discarding edits.
- Changing locale preserves the selected project and tool identity.
- Jobs remain visible while the user navigates to another workspace.
- A deep-linked tool works with and without an existing compatible asset.
- Search can find every baseline tool through its name and at least one outcome
  phrase.
