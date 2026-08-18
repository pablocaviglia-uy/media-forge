# MediaForge low-fidelity wireframes

**Status:** Gate A proposal<br>
**Purpose:** validate hierarchy and interaction before visual styling<br>
**Visual language:** deliberately neutral; color, typography and final branding
belong to Gate B

## Shared desktop shell

```text
┌──────────────┬──────────────────────────────────────────────────────────┐
│ MEDIAFORGE   │ Search an action, format or tool…                 ⌘ K   │
│              ├──────────────────────────────────────────────────────────┤
│ ＋ New       │ Current project        On this device   ↶  ↷   Jobs (2)│
│ Home         ├──────────────────────────────────────────────────────────┤
│ Studio       │                                                          │
│ Documents    │                     WORKSPACE                            │
│ Batch        │                                                          │
│ Projects     │                                                          │
│              │                                                          │
│──────────────│                                                          │
│ Help         ├──────────────────────────────────────────────────────────┤
│ Settings     │ Exporting interview.mp4 · 63%            Details   ×    │
└──────────────┴──────────────────────────────────────────────────────────┘
```

The current processing location remains visible in the workspace header. Jobs
belong to the global shell rather than to the page that started them.

## Home

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ MEDIAFORGE                                   Projects  Jobs  Settings    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ What do you want to make?                                               │
│ [ Describe an action: “join these videos”                         ⌘K ] │
│                                                                         │
│ ┌──────────────────────────────────┐  ┌───────────────────────────────┐ │
│ │ Drop files to begin              │  │ Continue                     │ │
│ │                                  │  │ Podcast edit       12 min    │ │
│ │ Choose files · Choose a folder   │  │ Combined report    yesterday │ │
│ └──────────────────────────────────┘  └───────────────────────────────┘ │
│                                                                         │
│ Workspaces                                                              │
│ Quick action    Media Studio    Documents    Batch & Convert            │
│                                                                         │
│ Recent activity                                           View projects │
└─────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- Dropping files replaces generic workspace choices with compatible outcomes.
- Search accepts tasks, formats and outcome language.
- Browse-all is available but secondary.
- Recent work is local by default and identifies unavailable source files.

## Global launcher

```text
┌──────────────────────────────────────────────────────────────────┐
│ Find a tool or outcome                                      Esc │
│ [ remove pages from a PDF                                      ] │
│                                                                  │
│ All   Video   Audio   Image   PDF   Documents                     │
│                                                                  │
│ SPLIT PDF                                        On this device  │
│ Create separate documents from pages or ranges.                  │
│                                                                  │
│ EXTRACT PAGES                                    On this device  │
│ Create one PDF containing only the selected pages.               │
└──────────────────────────────────────────────────────────────────┘
```

Rows show an outcome and execution mode. They do not use category-colored
promotional cards.

## Quick Tools: trim video

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ ‹ Home   Trim video   clip.mov · 01:42       On this device      ↶  ↷ │
├──────────────────────────────────────────────┬──────────────────────────┤
│                                              │ SETTINGS                 │
│                                              │ Start       00:12.500    │
│                  PREVIEW                     │ End         00:48.200    │
│                                              │                          │
│             Original  |  Result              │ Output                   │
│                                              │ MP4 · H.264              │
│────── editable range / filmstrip ────────────│ Advanced options         │
│ 00:12.500                         00:48.200   │                          │
├──────────────────────────────────────────────┴──────────────────────────┤
│ 35.7 seconds · estimated 18 MB      Change action       Create result  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- The tool exposes one dominant control and a large preview.
- `Change action` preserves the selected asset.
- Output options are consistent with Batch and Studio export.
- Completion replaces the estimate with source/result comparison and offers
  download, revise, compress, convert and continue in Studio.

## Media Studio

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Untitled project   Saved locally   On this device   ↶  ↷       Export  │
├────────────────┬─────────────────────────────────┬───────────────────────┤
│ ASSETS         │                                 │ INSPECTOR             │
│ ＋ Import       │                                 │ Transform             │
│                │             CANVAS              │ Position / scale      │
│ interview.mov  │                                 │ Opacity               │
│ title.png      │                                 │ Crop                  │
│ music.wav      │                                 │ Advanced              │
├────────────────┴─────────────────────────────────┴───────────────────────┤
│ ▶  00:13.42                 Fit canvas                   Timeline zoom  │
├──────────────────────────────────────────────────────────────────────────┤
│ V2  [ title ]                         [ image ]                          │
│ V1  [──────── clip 01 ─────────][──── clip 02 ────]                     │
│ A1  [────────────── music ─────────────────────────]                    │
│     00:00           00:10           00:20           00:30               │
└──────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- Assets can be inserted without requiring drag.
- Selecting a clip focuses the inspector and its accessible list equivalent.
- Export creates an immutable job snapshot; the project remains editable.
- Timeline commands describe history in plain language.

## Document Workspace

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Contract package · 24 pages         On this device   ↶  ↷      Export  │
├────────────────┬────────────────────────────────────┬────────────────────┤
│ DOCUMENTS      │ PAGES                              │ INSPECTOR          │
│ ＋ Add          │                                    │ Page 7             │
│                │ [ 1 ] [ 2 ] [ 3 ] [ 4 ]            │ Rotation      0°   │
│ contract.pdf   │ [ 5 ] [ 6 ] [ 7 ] [ 8 ]            │ Size          A4   │
│ annexes.pdf    │ [ 9 ] [10 ] [11 ] [12 ]            │                    │
│                │                                    │ Rotate             │
│                │ 3 pages selected                   │ Extract            │
│                │                                    │ Remove             │
├────────────────┴────────────────────────────────────┴────────────────────┤
│ 3 selected              Move   Rotate   Extract   Remove                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- Document boundaries remain visible after combining sources.
- Pointer reordering has Move before/after and numeric alternatives.
- Destructive-looking actions modify the project, never the original.
- A large single-page preview can temporarily replace the page board.

## Batch & Convert

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Image conversion                      On this device       Start 12     │
├────────────────┬─────────────────────────────────────────────────────────┤
│ PRESETS        │ FILES                                                   │
│ Web optimized  │ □ Name         Input    Output    Size       Status     │
│ High quality   │ □ cover.png    PNG      WebP      8.2 MB     Ready      │
│ Mobile audio   │ □ photo.tif    TIFF     WebP      42 MB      Warning    │
│ ＋ Save preset  │ □ logo.svg     SVG      —         120 KB     Error      │
│                │                                                         │
│ DESTINATION    │ Add files   Add folder   Remove                         │
│ Downloads      │                                                         │
├────────────────┴─────────────────────────────────────────────────────────┤
│ 12 files · 380 MB → approx. 94 MB             1 requires attention     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- Preflight happens before processing and reports row-level incompatibilities.
- One failed file does not stop or hide successful outputs.
- The same output control vocabulary is used by Quick Tools and Studio.
- On small screens, rows become expandable summaries instead of a squeezed
  desktop table.

## First remote-processing confirmation

```text
┌───────────────────────────────────────────────────────────────┐
│ Process on a secure server                                   │
│                                                               │
│ This conversion needs components unavailable in your browser. │
│                                                               │
│ File          interview.mov · 1.8 GB                          │
│ Reason        codec unavailable locally                       │
│ Retention     deleted automatically after the stated period   │
│ Alternative   local mode with reduced format support          │
│                                                               │
│ Cancel                                  Upload and continue   │
└───────────────────────────────────────────────────────────────┘
```

Retention copy must use a concrete value from the eventual backend policy. A
placeholder is not acceptable in production.

## Mobile composition rules

```text
┌───────────────────────────────┐
│ MediaForge          Jobs (2)  │
│ [ Search an action…         ] │
├───────────────────────────────┤
│                               │
│       CURRENT SURFACE         │
│                               │
├───────────────────────────────┤
│ Home   Projects   ＋   Jobs   │
└───────────────────────────────┘
```

- Quick Tool inspector sections become bottom sheets.
- Studio keeps the canvas above a horizontally scrollable timeline and uses
  tabs for Assets, Timeline and Inspector.
- Document shows a three-column page grid where possible and a sticky selection
  action bar.
- Batch shows expandable rows with preset and destination summaries above them.
- No essential action depends on hover or drag.

## Shared state behavior

| State | Wireframe expectation |
|---|---|
| Empty | Outcome sentence, accepted input and one primary start action. |
| Analyzing | Skeleton in the final layout plus a named real stage. |
| Editing | Preview, parameters and action remain stable in position. |
| Processing | Job moves to the shell tray; workspace stays navigable. |
| Error | Inline cause, recovery action and optional technical detail. |
| Complete | Result preview, source comparison, download and next actions. |

## Gate A validation questions

1. Does Home feel like an intent launcher rather than a catalog?
2. Is the distinction among Quick, Studio, Documents and Batch predictable?
3. Can a user identify local versus remote execution without opening help?
4. Is the primary action evident in each workspace?
5. Can every drag interaction be completed through explicit controls?
6. Does moving between related tools preserve the user's asset and edits?
