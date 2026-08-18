# MediaForge tool map

**Status:** Gate A proposal<br>
**Baseline:** 51 public tool routes<br>
**First extension:** 4 additional routes marked `Extra`<br>
**Total planned routes:** 55

The 55 routes are commercial and navigational entry points, not 55 separate
implementations. They resolve to four workspaces and a small set of shared
engines.

## Route and identity rules

- Canonical route: `/{locale}/{category}/{localized-tool-slug}`.
- Categories are `video`, `audio`, `pdf` and localized `convert`.
- `toolId` is stable, unique and never localized.
- Localized slugs are aliases resolved through `toolId`.
- A route supplies a workspace preset; it does not select a bespoke page.
- Search synonyms do not create duplicate routes.
- Execution never changes from local to remote without explicit consent.

Examples:

- `/es/video/cortar` and `/en/video/trim`
- `/es/audio/ecualizar` and `/en/audio/equalize`
- `/es/pdf/combinar` and `/en/pdf/merge`
- `/es/convertir/imagenes` and `/en/convert/images`

## Execution modes

| Code | Meaning |
|---|---|
| `L` | Local only |
| `HL` | Hybrid, local by default; remote by limit, format or explicit choice |
| `HR` | Hybrid, remote recommended; local where the device permits it |
| `R` | Remote for the first production-quality implementation |

## Shared engine keys

Every tool inherits common intake/probe, job state and output/download
contracts.

| Key | Shared capability |
|---|---|
| `FF` | FFmpeg probe, demux, encode, filters and mux |
| `VT` | Single-input video transformation graph |
| `CAP` | Screen, camera and microphone capture |
| `AE` | Waveform, Web Audio/AudioWorklet and DSP graph |
| `TL` | Multi-track project, timeline and export DAG |
| `MX` | Canvas/WebGL composition preview and export mapping |
| `TTS` | Production voice synthesis service |
| `STAB` | Two-pass motion analysis and stabilization |
| `ML-A` | Audio stem separation and neural denoise jobs |
| `PDF` | PDF structure, writing, encryption and page editing |
| `PDF-R` | PDF page and embedded-image rendering |
| `OFF` | Office/OCR/layout reconstruction workers |
| `IMG` | Browser image APIs and remote image worker |
| `CVT` | Format matrix, presets and batch shell |
| `ARC` | Sandboxed archive read, write and extraction |
| `FNT` | Font conversion worker |
| `EBK` | Ebook normalization and conversion worker |

## Video — 18 baseline routes plus 1 extra

| Tool ID | ES / EN route | Workspace | Mode | Shared implementation |
|---|---|---|---|---|
| `video-editor` | `/es/video/editar`<br>`/en/video/edit` | Studio | HL | `media-studio:blank-video` · `TL MX AE FF` |
| `screen-recorder` | `/es/video/grabar-pantalla`<br>`/en/video/screen-recorder` | Quick | L | `capture:screen` · `CAP FF` |
| `text-to-speech` | `/es/video/texto-a-voz`<br>`/en/video/text-to-speech` | Quick | R | `speech:synthesize` · `TTS AE` |
| `video-merge` | `/es/video/unir`<br>`/en/video/merge` | Studio | HL | `media-studio:sequential-video` · `TL FF` |
| `video-trim` | `/es/video/cortar`<br>`/en/video/trim` | Quick | HL | `quick-video:trim` · `VT FF` |
| `video-add-audio` | `/es/video/agregar-audio`<br>`/en/video/add-audio` | Studio | HL | `media-studio:audio-track` · `TL AE FF` |
| `video-add-image` | `/es/video/agregar-imagen`<br>`/en/video/add-image` | Studio | HL | `media-studio:image-overlay` · `TL MX FF` |
| `video-add-text` | `/es/video/agregar-texto`<br>`/en/video/add-text` | Studio | HL | `media-studio:text-overlay` · `TL MX FF` |
| `video-remove-logo` | `/es/video/quitar-logo`<br>`/en/video/remove-logo` | Studio | HL | `media-studio:mask-or-crop` · `TL MX FF` |
| `video-crop` | `/es/video/recortar-encuadre`<br>`/en/video/crop` | Quick | HL | `quick-video:crop` · `VT FF` |
| `video-rotate` | `/es/video/girar`<br>`/en/video/rotate` | Quick | HL | `quick-video:rotate` · `VT FF` |
| `video-flip` | `/es/video/voltear`<br>`/en/video/flip` | Quick | HL | `quick-video:flip` · `VT FF` |
| `video-resize` | `/es/video/redimensionar`<br>`/en/video/resize` | Quick | HL | `quick-video:resize` · `VT FF` |
| `video-loop` | `/es/video/repetir`<br>`/en/video/loop` | Quick | HL | `quick-video:loop` · `VT FF` |
| `video-volume` | `/es/video/cambiar-volumen`<br>`/en/video/change-volume` | Quick | HL | `quick-video:volume` · `VT AE FF` |
| `video-speed` | `/es/video/cambiar-velocidad`<br>`/en/video/change-speed` | Quick | HL | `quick-video:speed` · `VT AE FF` |
| `video-stabilize` | `/es/video/estabilizar`<br>`/en/video/stabilize` | Studio | HR | `media-studio:stabilize` · `TL STAB FF` |
| `webcam-recorder` | `/es/video/grabar-webcam`<br>`/en/video/webcam-recorder` | Quick | L | `capture:camera` · `CAP FF` |
| `video-green-screen` · Extra | `/es/video/pantalla-verde`<br>`/en/video/green-screen` | Studio | HL | `media-studio:chroma-key` · `TL MX FF` |

## Audio — 8 baseline routes plus 2 extras

| Tool ID | ES / EN route | Workspace | Mode | Shared implementation |
|---|---|---|---|---|
| `audio-trim` | `/es/audio/cortar`<br>`/en/audio/trim` | Quick | HL | `quick-audio:trim` · `AE FF` |
| `audio-volume` | `/es/audio/cambiar-volumen`<br>`/en/audio/change-volume` | Quick | HL | `quick-audio:volume` · `AE FF` |
| `audio-speed` | `/es/audio/cambiar-velocidad`<br>`/en/audio/change-speed` | Quick | HL | `quick-audio:tempo` · `AE FF` |
| `audio-pitch` | `/es/audio/cambiar-tono`<br>`/en/audio/change-pitch` | Quick | HL | `quick-audio:pitch` · `AE FF` |
| `audio-equalizer` | `/es/audio/ecualizar`<br>`/en/audio/equalize` | Quick | HL | `quick-audio:equalizer` · `AE FF` |
| `audio-reverse` | `/es/audio/invertir`<br>`/en/audio/reverse` | Quick | HL | `quick-audio:reverse` · `AE FF` |
| `voice-recorder` | `/es/audio/grabar-voz`<br>`/en/audio/voice-recorder` | Quick | L | `capture:voice` · `CAP AE FF` |
| `audio-merge` | `/es/audio/unir`<br>`/en/audio/merge` | Studio | HL | `media-studio:sequential-audio` · `TL AE FF` |
| `audio-vocal-separation` · Extra | `/es/audio/separar-voz-y-musica`<br>`/en/audio/separate-vocals` | Studio | R | `audio-ml:two-stems` · `ML-A AE FF` |
| `audio-denoise` · Extra | `/es/audio/eliminar-ruido`<br>`/en/audio/denoise` | Studio | R | `audio-ml:denoise` · `ML-A AE FF` |

## PDF — 17 baseline routes plus 1 extra

| Tool ID | ES / EN route | Workspace | Mode | Shared implementation |
|---|---|---|---|---|
| `pdf-split` | `/es/pdf/dividir`<br>`/en/pdf/split` | Documents | L | `pdf-pages:split` · `PDF` |
| `pdf-merge` | `/es/pdf/combinar`<br>`/en/pdf/merge` | Documents | L | `pdf-pages:merge` · `PDF` |
| `pdf-compress` | `/es/pdf/comprimir`<br>`/en/pdf/compress` | Documents | HR | `pdf-optimize:compress` · `PDF PDF-R IMG` |
| `pdf-unlock` | `/es/pdf/desbloquear`<br>`/en/pdf/unlock` | Documents | L | `pdf-security:decrypt` · `PDF` |
| `pdf-protect` | `/es/pdf/proteger`<br>`/en/pdf/protect` | Documents | L | `pdf-security:encrypt` · `PDF` |
| `pdf-rotate` | `/es/pdf/girar`<br>`/en/pdf/rotate` | Documents | L | `pdf-pages:rotate` · `PDF` |
| `pdf-page-numbers` | `/es/pdf/numerar-paginas`<br>`/en/pdf/add-page-numbers` | Documents | L | `pdf-pages:number` · `PDF` |
| `pdf-to-word` | `/es/pdf/a-word`<br>`/en/pdf/to-word` | Documents | R | `document-convert:pdf-docx` · `OFF` |
| `pdf-to-excel` | `/es/pdf/a-excel`<br>`/en/pdf/to-excel` | Documents | R | `document-convert:pdf-xlsx` · `OFF` |
| `pdf-to-jpg` | `/es/pdf/a-jpg`<br>`/en/pdf/to-jpg` | Documents | L | `pdf-render-images:jpg` · `PDF-R IMG` |
| `pdf-to-png` | `/es/pdf/a-png`<br>`/en/pdf/to-png` | Documents | L | `pdf-render-images:png` · `PDF-R IMG` |
| `pdf-to-html` | `/es/pdf/a-html`<br>`/en/pdf/to-html` | Documents | R | `document-convert:pdf-html` · `OFF PDF-R` |
| `word-to-pdf` | `/es/pdf/word-a-pdf`<br>`/en/pdf/word-to-pdf` | Documents | R | `document-convert:docx-pdf` · `OFF` |
| `jpg-to-pdf` | `/es/pdf/jpg-a-pdf`<br>`/en/pdf/jpg-to-pdf` | Documents | L | `images-to-pdf:jpg` · `IMG PDF` |
| `excel-to-pdf` | `/es/pdf/excel-a-pdf`<br>`/en/pdf/excel-to-pdf` | Documents | R | `document-convert:xlsx-pdf` · `OFF` |
| `powerpoint-to-pdf` | `/es/pdf/powerpoint-a-pdf`<br>`/en/pdf/powerpoint-to-pdf` | Documents | R | `document-convert:pptx-pdf` · `OFF` |
| `png-to-pdf` | `/es/pdf/png-a-pdf`<br>`/en/pdf/png-to-pdf` | Documents | L | `images-to-pdf:png` · `IMG PDF` |
| `pdf-to-powerpoint` · Extra | `/es/pdf/a-powerpoint`<br>`/en/pdf/to-powerpoint` | Documents | R | `document-convert:pdf-pptx` · `OFF` |

`pdf-unlock` removes encryption only when the user supplies a valid password; it
does not attempt to defeat or recover passwords.

## Conversion — 8 baseline routes

| Tool ID | ES / EN route | Workspace | Mode | Shared implementation |
|---|---|---|---|---|
| `audio-converter` | `/es/convertir/audio`<br>`/en/convert/audio` | Batch | HL | `batch-convert:audio` · `CVT AE FF` |
| `video-converter` | `/es/convertir/video`<br>`/en/convert/video` | Batch | HL | `batch-convert:video` · `CVT VT FF` |
| `image-converter` | `/es/convertir/imagenes`<br>`/en/convert/images` | Batch | HL | `batch-convert:image` · `CVT IMG` |
| `document-converter` | `/es/convertir/documentos`<br>`/en/convert/documents` | Batch | R | `batch-convert:document` · `CVT OFF` |
| `font-converter` | `/es/convertir/fuentes`<br>`/en/convert/fonts` | Batch | R | `batch-convert:font` · `CVT FNT` |
| `archive-converter` | `/es/convertir/archivos-comprimidos`<br>`/en/convert/archives` | Batch | HR | `batch-convert:archive` · `CVT ARC` |
| `ebook-converter` | `/es/convertir/ebooks`<br>`/en/convert/ebooks` | Batch | R | `batch-convert:ebook` · `CVT EBK` |
| `archive-extractor` | `/es/convertir/extraer-archivos`<br>`/en/convert/extract-archives` | Batch | HL | `batch-convert:extract` · `CVT ARC` |

## Workspace totals

| Workspace | Baseline | Extras | Total routes |
|---|---:|---:|---:|
| Quick Tools | 18 | 0 | 18 |
| Media Studio | 8 | 3 | 11 |
| Document Workspace | 17 | 1 | 18 |
| Batch & Convert | 8 | 0 | 8 |
| **Total** | **51** | **4** | **55** |

The baseline catalog count is defined by category, while workspace counts are
defined by interaction model. Text-to-speech, for example, remains in the Video
category for parity but opens a focused Quick Tool that produces audio.

## Reuse rules

| Public routes | Single implementation |
|---|---|
| Video trim, crop, rotate, flip, resize, loop, volume and speed | `quick-video` with different `VT` presets |
| Audio trim, volume, speed, pitch, equalizer and reverse | `quick-audio` with different `AE` nodes |
| Editor, merge video, add audio, image and text | One Media Studio with different initial projects |
| Remove logo and green screen | One compositor/mask system with different focused panels |
| Screen, webcam and voice recorders | One permissions/capture controller with different sources |
| Merge audio | Media Studio in audio mode, not a second timeline |
| Vocal separation and denoise | One remote ML job contract with different models/outputs |
| Split, merge, rotate, number, protect and unlock PDF | One document model and operation history |
| PDF to JPG/PNG | One page renderer with a different image codec |
| JPG/PNG to PDF | One images-to-PDF operation with input restrictions |
| PDF/Office conversions | One remote document conversion service with target adapters |
| Eight converter routes | One batch shell and one origin/target format registry |
| Convert/extract archives | One sandboxed archive engine with different recipes |

## Current MediaForge capabilities outside the parity count

Existing features remain available even if they are not individual baseline
routes:

- remux/repackage without re-encoding;
- extract audio;
- animated GIF;
- target-size video compression;
- frame and poster extraction;
- raw FFmpeg arguments, kept in an explicitly local Expert/Lab surface.

These are differentiators, not reasons to alter the parity count.

## Registry validation requirements

The eventual source registry must automatically assert:

- exactly 55 unique `toolId` values;
- exactly four entries marked `extra`;
- baseline category counts of 18 video, 8 audio, 17 PDF and 8 conversion;
- unique routes inside each locale;
- Spanish and English routes for every entry;
- required workspace, implementation key, preset, input, output and execution
  policy fields;
- no `HL`, `HR` or `R` route can upload before reaching an explicit consent
  state.
