/**
 * Application controller. Owns the queue, the engine and every piece of UI
 * wiring. Deliberately one class rather than a component framework: the whole
 * app is a list, a form and a log, and this keeps the dependency count at zero.
 *
 * The one rule the rest of the code depends on is that FFmpeg is a single
 * instance that does one thing at a time. Probing a newly added file and
 * converting a queued one both go through the same worker, so everything that
 * touches the engine is put on one chain and waits its turn. Without that, a
 * file dropped while a conversion is running would have its probe silently
 * swallowed — or worse, land in the same in-memory filesystem the conversion
 * is reading from.
 */

import {
  $, el, on, debounce, raf,
  formatBytes, formatDuration, formatBitrate, parseTimestamp, formatTimestamp,
  truncateName, copyText, downloadFile,
} from './ui/dom.js';
import { prefs, resolveTheme } from './storage/prefs.js';
import { createEngine, isolationStatus } from './ffmpeg/client.js';
import { createScrubber } from './ui/scrubber.js';
import { supportsFormat } from './ffmpeg/capabilities.js';
import { buildPlan, planToCommand, operationsFor, operationById, DEFAULT_OPTIONS } from './media/commands.js';
import {
  VIDEO_FORMATS, AUDIO_FORMATS, IMAGE_FORMATS,
  RESOLUTIONS, FRAME_RATES, QUALITIES, AUDIO_BITRATES, SPEED_PRESETS,
  AUDIO_ENCODERS, FLAC_COMPRESSION,
  formatById, audioFidelity, remuxTargets,
} from './media/formats.js';
import { createZip } from './media/zip.js';
import {
  defaultResizeResolution,
  describeFocusedQuickTransformation,
  describeTrimRange,
  focusedQuickTool,
  normalizeFocusedQuickOptions,
  quickVideoFormat,
  supportsFocusedQuickTool,
  trimRange,
  trimOptionsForRun,
} from './media/quick-tools.js';

/**
 * Where the app refuses rather than letting FFmpeg run out of heap.
 *
 * The compiled core is a 32-bit WebAssembly module with a 2 GB ceiling, and
 * both the input and the output live inside it at once, alongside whatever
 * the codec needs to work. In practice the wall is far below 2 GB, and hitting
 * it produces "Array buffer allocation failed" or a dead worker rather than
 * anything a person could act on. Better to say so before starting.
 */
const REFUSE_BYTES = 500 * 1024 * 1024;
const WARN_BYTES = 150 * 1024 * 1024;

const STATUS_LABELS = {
  probing: 'Reading',
  ready: 'Ready',
  queued: 'Queued',
  running: 'Converting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

let nextJobId = 1;

export class App {
  constructor() {
    this.engine = createEngine();

    // Queue state.
    this.jobs = [];
    this.selectedId = null;
    this.running = null; // the Running handle of the job in flight
    this.runningId = null;
    this.stopRequested = false;

    // Everything that talks to the worker goes through here, in order.
    this.chain = Promise.resolve();

    // Session bookkeeping.
    this.capabilities = null;
    this.engineDetails = null;
    this.previewUrl = null;
    this.quickSourcePreview = null;
    this.quickOutputPreview = null;
    this.scrubber = null;

    this.dom = {
      app: $('#app'),
      queueList: $('#queue-list'),
      queueCount: $('#queue-count'),
      inspector: $('#inspector'),
      empty: $('#empty-state'),
      detail: $('#detail'),
      detailName: $('#detail-name'),
      detailFacts: $('#detail-facts'),
      quickFootSummary: $('#quick-foot-summary'),
      preview: $('#preview'),
      controls: $('#controls'),
      commandBlock: $('#command-block'),
      commandText: $('#command-text'),
      logPane: $('#logpane'),
      logBody: $('#log-body'),
      statusEngine: $('#status-engine'),
      statusQueue: $('#status-queue'),
      statusOffline: $('#status-offline'),
      engineNote: $('#engine-note'),
      dropOverlay: $('#drop-overlay'),
      fileInput: $('#file-input'),
      settings: $('#settings-sheet'),
      confirmSheet: $('#confirm-sheet'),
      toasts: $('#toasts'),
      startAll: $('[data-action="start-all"]'),
      downloadAll: $('[data-action="download-all"]'),
    };

    this.paintQueue = raf(() => this.renderQueue());
    this.paintDetail = raf(() => this.renderDetail());
    this.scheduleCommandPreview = debounce(() => this.renderCommand(), 120);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async start() {
    this.applyPreferences(Object.keys(prefs.all()));
    prefs.subscribe((_, changed) => this.applyPreferences(changed));

    this.bindGlobalEvents();
    this.bindDropZone();
    this.bindSettings();
    this.bindConfirmSheet();
    this.bindResizers();
    this.renderQueue();
    this.updateOfflineBadge();

    // Bringing up 32 MB of WebAssembly takes a moment and the page should be
    // usable — droppable, at least — while it happens.
    this.loadEngine();
  }

  async loadEngine() {
    this.dom.statusEngine.textContent = 'Starting FFmpeg…';
    try {
      const details = await this.engine.load();
      this.engineDetails = details;
      this.capabilities = details.capabilities;

      const threads = details.threads ? 'multi-threaded' : 'single-threaded';
      this.dom.statusEngine.textContent = `FFmpeg ${details.capabilities.version || ''} · ${threads}`.trim();
      this.dom.engineNote.prepend(
        el('span', { text: `FFmpeg ${details.capabilities.version} runs here, in this tab. ` })
      );
      this.paintDetail();
    } catch (error) {
      this.dom.statusEngine.textContent = 'FFmpeg failed to start';
      this.toast(`FFmpeg could not start: ${error.message}`, { kind: 'error', duration: 10000 });
    }
  }

  /* ------------------------------------------------------------------ *
   * Preferences
   * ------------------------------------------------------------------ */

  applyPreferences(changed) {
    const values = prefs.all();
    const root = document.documentElement;

    if (changed.includes('theme')) root.dataset.theme = resolveTheme(values.theme);
    if (changed.includes('accent')) root.dataset.accent = values.accent;
    if (changed.includes('queueOpen')) this.dom.app.dataset.queue = values.queueOpen ? 'shown' : 'hidden';
    if (changed.includes('logOpen')) this.dom.app.dataset.log = values.logOpen ? 'shown' : 'hidden';
    if (changed.includes('advanced')) this.paintDetail();
    if (changed.includes('queueWidth')) root.style.setProperty('--queue-width', `${values.queueWidth}px`);
    if (changed.includes('logWidth')) root.style.setProperty('--log-width', `${values.logWidth}px`);

    for (const [action, pressed] of [['toggle-queue', values.queueOpen], ['toggle-log', values.logOpen]]) {
      const button = $(`[data-action="${action}"]`);
      if (button) button.setAttribute('aria-pressed', String(Boolean(pressed)));
    }
  }

  cycleTheme() {
    const current = resolveTheme();
    prefs.set('theme', current === 'dark' ? 'light' : 'dark');
  }

  /* ------------------------------------------------------------------ *
   * Adding files
   * ------------------------------------------------------------------ */

  /**
   * A dropped folder arrives as a tree of entries rather than a file list, and
   * people drop folders of clips constantly. Walking it is a few lines and
   * saves them selecting forty files by hand.
   */
  async collectFiles(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return Array.from(dataTransfer.files || []);

    const files = [];
    const walk = async (entry, path = '') => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push(path ? new File([file], `${path}/${file.name}`, { type: file.type }) : file);
        return;
      }
      const reader = entry.createReader();
      for (;;) {
        // `readEntries` returns at most a hundred at a time and signals the
        // end with an empty batch, not by returning everything at once.
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path ? `${path}/${entry.name}` : entry.name);
      }
    };

    for (const entry of entries) await walk(entry);
    return files;
  }

  addFiles(files) {
    const accepted = [];
    const refused = [];

    for (const file of files) {
      if (!file.size) continue;
      if (file.size > REFUSE_BYTES) {
        refused.push(file);
        continue;
      }
      const job = {
        id: String(nextJobId++),
        file,
        name: file.name,
        size: file.size,
        info: null,
        status: 'probing',
        operation: 'convert',
        options: { ...DEFAULT_OPTIONS, format: prefs.get('preset') },
        progress: 0,
        speed: null,
        remaining: null,
        outputs: null,
        error: null,
        log: [],
      };
      this.jobs.push(job);
      accepted.push(job);
    }

    if (refused.length) {
      this.toast(
        `${refused.length === 1 ? `${truncateName(refused[0].name)} is` : `${refused.length} files are`} too large. ` +
          `FFmpeg runs inside this tab and cannot hold more than about ${formatBytes(REFUSE_BYTES)}.`,
        { kind: 'error', duration: 9000 }
      );
    }
    if (!accepted.length) return;

    if (!this.selectedId) this.selectedId = accepted[0].id;
    this.paintQueue();
    this.paintDetail();

    for (const job of accepted) this.enqueue(() => this.probeJob(job));
    // Focused tools need one explicit choice/confirmation. Auto-start remains
    // useful for the generic converter, but must not rotate or resize a file
    // merely because it has just finished probing.
    if (prefs.get('autoStart')) this.enqueue(() => this.runQueue({ skipFocused: true }));
  }

  /** Serialise everything that uses the worker; it can only do one thing. */
  enqueue(task) {
    this.chain = this.chain.then(task).catch((error) => {
      if (!error?.cancelled) console.warn('[media-forge]', error);
    });
    return this.chain;
  }

  async probeJob(job) {
    if (!this.jobs.includes(job)) return;
    try {
      job.info = await this.engine.probe(job.file);
      job.status = 'ready';

      const quickTool = focusedQuickTool(job.forgeToolId);
      if (quickTool && supportsFocusedQuickTool(quickTool.id, job.info)) {
        job.operation = quickTool.operation;
        this.initialiseQuickTool(job, quickTool);
      } else if (quickTool) {
        job.forgeToolId = null;
        this.toast(`${quickTool.title} necesita un archivo de video. Abrimos el conversor general para este archivo.`, {
          duration: 7000,
        });
      }

      // A file with no stream FFmpeg recognises is not a conversion waiting to
      // happen; it is a file the user picked by mistake.
      if (!job.info.hasVideo && !job.info.hasAudio) {
        job.status = 'failed';
        job.error = 'No video or audio track. Is this really a media file?';
      } else if (!job.info.hasVideo) {
        // Offering "convert to MP4" for an MP3 is worse than useless.
        job.operation = 'extract-audio';
        job.options.audioFormat = job.info.audio?.codec === 'mp3' ? 'm4a' : 'mp3';
      }

      if (job.size > WARN_BYTES) {
        this.toast(
          `${truncateName(job.name)} is ${formatBytes(job.size)}. This will be slow, and may run out of memory.`,
          { duration: 8000 }
        );
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.forgeToolId = null;
    }
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  async removeJob(job) {
    if (!job) return;
    // Removing a file mid-conversion throws away however many minutes of the
    // user's processor it has already spent, and there is no undo.
    if (this.runningId === job.id) {
      const sure = await this.confirm({
        title: 'Stop converting?',
        message: `${job.name} is ${Math.round(job.progress * 100)}% converted. Removing it now throws that away.`,
        confirmLabel: 'Stop and remove',
        danger: true,
      });
      if (!sure) return;
      this.cancelRunning();
    }

    const index = this.jobs.indexOf(job);
    if (index < 0) return;
    this.jobs.splice(index, 1);
    if (this.selectedId === job.id) this.selectedId = this.jobs[Math.min(index, this.jobs.length - 1)]?.id || null;
    this.paintQueue();
    this.paintDetail();
  }

  /* ------------------------------------------------------------------ *
   * The queue
   * ------------------------------------------------------------------ */

  get selected() {
    return this.jobs.find((job) => job.id === this.selectedId) || null;
  }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.paintQueue();
    this.paintDetail();
  }

  renderQueue() {
    const list = this.dom.queueList;
    list.textContent = '';

    for (const job of this.jobs) {
      const row = el('div', {
        class: `queue-row${job.id === this.selectedId ? ' is-current' : ''}`,
        dataset: { job: job.id, status: job.status },
      });

      row.append(
        el('button', { type: 'button', class: 'queue-item', dataset: { job: job.id } }, [
          el('span', { class: 'queue-item-name', text: truncateName(job.name, 34), title: job.name }),
          el('span', { class: 'queue-item-meta', text: this.describeJob(job) }),
        ]),
        el('span', { class: 'queue-dot', attrs: { 'aria-hidden': 'true' } }),
        el('button', {
          type: 'button',
          class: 'queue-remove',
          dataset: { action: 'remove', job: job.id },
          attrs: { 'aria-label': `Remove ${job.name}` },
          html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
        })
      );

      if (job.status === 'running') {
        row.append(el('div', { class: 'queue-progress' }, [
          el('div', { class: 'queue-progress-bar', style: `width:${Math.round(job.progress * 100)}%` }),
        ]));
      }

      list.append(row);
    }

    const done = this.jobs.filter((job) => job.status === 'done');
    this.dom.queueCount.textContent = this.jobs.length
      ? `${this.jobs.length} file${this.jobs.length === 1 ? '' : 's'}`
      : 'Nothing queued';
    this.dom.app.dataset.empty = String(this.jobs.length === 0);
    this.dom.startAll.disabled = !this.jobs.some((job) => job.status === 'ready' || job.status === 'queued');
    this.dom.downloadAll.disabled = done.length === 0;

    const running = this.jobs.filter((job) => job.status === 'running').length;
    this.dom.statusQueue.textContent = this.jobs.length
      ? `${done.length} done${running ? ', 1 converting' : ''} of ${this.jobs.length}`
      : '';
  }

  describeJob(job) {
    if (job.status === 'failed') return job.error ? truncateName(job.error, 44) : 'Failed';
    if (job.status === 'running') {
      const percent = Math.round(job.progress * 100);
      const left = job.remaining !== null ? ` · ${formatDuration(job.remaining)} left` : '';
      return `${percent}%${left}`;
    }
    if (job.status === 'done') return `${formatBytes(job.outputSize || 0)} · ${STATUS_LABELS.done}`;
    if (job.status === 'probing') return STATUS_LABELS.probing;

    const info = job.info;
    if (!info) return formatBytes(job.size);
    const bits = [formatBytes(job.size)];
    if (info.duration) bits.push(formatDuration(info.duration));
    if (info.video) bits.push(`${info.video.width}×${info.video.height}`);
    else if (info.audio) bits.push(`${(info.audio.sampleRate / 1000).toFixed(1)} kHz`);
    return bits.join(' · ');
  }

  /* ------------------------------------------------------------------ *
   * The inspector
   * ------------------------------------------------------------------ */

  initialiseQuickTool(job, tool) {
    if (job.quickToolInitialised === tool.id) return;
    job.options.format = quickVideoFormat(job.options.format);
    job.options.trimStart = null;
    job.options.trimEnd = null;
    job.options.fps = 'source';

    if (tool.id === 'video-rotate') {
      job.options.rotate = tool.defaultOptions.rotate;
      job.options.flip = 'none';
      job.options.resolution = 'source';
    } else if (tool.id === 'video-flip') {
      job.options.rotate = 0;
      job.options.flip = tool.defaultOptions.flip;
      job.options.resolution = 'source';
    } else if (tool.id === 'video-resize') {
      job.options.rotate = 0;
      job.options.flip = 'none';
      job.options.resolution = defaultResizeResolution(job.info);
      if (!job.options.resolution) {
        job.validationError = 'Este video ya está en el tamaño mínimo disponible.';
      }
    }

    job.quickToolInitialised = tool.id;
  }

  quickToolFor(job) {
    if (!job) return null;
    const tool = focusedQuickTool(job.forgeToolId);
    if (!tool) return null;
    if (job.status === 'probing') return tool;
    return supportsFocusedQuickTool(tool.id, job.info) ? tool : null;
  }

  renderDetail() {
    const job = this.selected;
    const quickTool = this.quickToolFor(job);
    this.dom.detail.hidden = !job;
    this.dom.empty.hidden = Boolean(job);
    if (!job) {
      this.dom.detail.dataset.workspace = 'converter';
      this.dom.detail.dataset.status = 'empty';
      this.dom.quickFootSummary.hidden = true;
      this.releasePreview();
      this.releaseQuickSourcePreview();
      this.releaseQuickOutputPreview();
      this.releaseScrubber();
      return;
    }

    this.dom.detail.dataset.workspace = quickTool ? 'quick-tool' : 'converter';
    this.dom.detail.dataset.status = job.status === 'done' && job.dirtySinceOutput ? 'ready' : job.status;
    if (quickTool) this.dom.detail.dataset.tool = quickTool.id;
    else delete this.dom.detail.dataset.tool;

    // Selecting a different file means the timeline belongs to a file that is
    // no longer on screen, and its `<video>` is still holding the old one open.
    if (this.scrubber && this.scrubber.jobId !== job.id) this.releaseScrubber();
    if (this.quickSourcePreview && this.quickSourcePreview.jobId !== job.id) this.releaseQuickSourcePreview();
    if (this.quickOutputPreview && this.quickOutputPreview.jobId !== job.id) this.releaseQuickOutputPreview();

    this.dom.detailName.textContent = quickTool?.title || job.name;
    this.dom.detailFacts.textContent = quickTool
      ? `${job.name} · ${this.describeSource(job)}`
      : this.describeSource(job);

    if (quickTool) {
      this.releasePreview();
      this.dom.preview.replaceChildren();
      delete this.dom.preview.dataset.job;
    } else {
      this.releaseQuickSourcePreview();
      this.releaseQuickOutputPreview();
      this.renderPreview(job);
    }
    this.renderControls(job);
    this.renderCommand();
    this.renderQuickFooter(job, quickTool);

    const advanced = prefs.get('advanced');
    this.dom.commandBlock.hidden = !advanced || job.status === 'probing';

    this.renderDetailActions(job, quickTool);
    this.restoreQuickFocus(job);
  }

  restoreQuickFocus(job) {
    if (job.pendingQuickTab) {
      const action = job.pendingQuickTab === 'result' ? 'preview-result' : 'preview-source';
      this.dom.controls.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
      delete job.pendingQuickTab;
      return;
    }

    const pending = job.pendingQuickFocus;
    if (!pending) return;
    const candidates = Array.from(this.dom.controls.querySelectorAll('[data-quick-option]'));
    const exact = candidates.find((node) => (
      node.dataset.quickOption === pending.key && node.dataset.quickValue === pending.value
    ));
    const field = exact || candidates.find((node) => node.dataset.quickOption === pending.key);
    field?.focus({ preventScroll: true });
    delete job.pendingQuickFocus;
  }

  renderDetailActions(job, quickTool) {
    const start = this.dom.detail.querySelector('[data-action="start-one"]');
    const cancel = this.dom.detail.querySelector('[data-action="cancel-one"]');
    const download = this.dom.detail.querySelector('[data-action="download-one"]');
    const remove = this.dom.detail.querySelector('[data-action="remove-one"]');
    const running = job.status === 'running';
    const queued = job.status === 'queued';

    start.hidden = running || queued || job.status === 'probing' || !job.info;
    start.disabled = quickTool ? !this.quickJobRunnable(job, quickTool) : false;
    start.textContent = quickTool
      ? (job.status === 'done'
          ? (job.dirtySinceOutput ? 'Actualizar resultado' : 'Crear otra versión')
          : (job.outputs?.length ? 'Reintentar' : 'Crear resultado'))
      : (job.status === 'done' ? 'Convert again' : 'Convert');
    cancel.hidden = !running;
    cancel.textContent = quickTool ? 'Cancelar' : 'Cancel';
    download.hidden = !job.outputs?.length;
    download.textContent = quickTool
      ? (job.dirtySinceOutput || job.status !== 'done' ? 'Descargar versión anterior' : 'Descargar resultado')
      : 'Download';
    remove.textContent = quickTool ? 'Quitar archivo' : 'Remove';

    const downloadIsPrimary = Boolean(quickTool && job.status === 'done' && !job.dirtySinceOutput && job.outputs?.length);
    start.classList.toggle('primary-button', !downloadIsPrimary);
    start.classList.toggle('text-button', downloadIsPrimary);
    download.classList.toggle('primary-button', downloadIsPrimary);
    download.classList.toggle('text-button', !downloadIsPrimary);
  }

  describeSource(job) {
    const info = job.info;
    if (job.status === 'probing') return 'Reading the file…';
    if (!info) return formatBytes(job.size);

    const parts = [formatBytes(job.size)];
    if (info.formatLabel || info.format) parts.push(info.formatLabel || info.format);
    if (info.duration) parts.push(formatDuration(info.duration));
    if (info.video) {
      parts.push(`${info.video.codec} ${info.video.width}×${info.video.height}`);
      if (info.video.fps) parts.push(`${info.video.fps} fps`);
    }
    if (info.audio) {
      const channels = info.audio.channels === 1 ? 'mono' : info.audio.channels === 2 ? 'stereo' : `${info.audio.channels} channels`;
      parts.push(`${info.audio.codec} ${channels}`);
    }
    if (info.bitrate) parts.push(formatBitrate(info.bitrate));
    return parts.join(' · ');
  }

  releasePreview() {
    if (!this.previewUrl) return;
    URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  releaseQuickOutputPreview() {
    if (!this.quickOutputPreview) return;
    const { media } = this.quickOutputPreview;
    media.pause();
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(this.quickOutputPreview.url);
    this.quickOutputPreview = null;
  }

  pauseQuickOutputPreview() {
    this.quickOutputPreview?.media.pause();
  }

  releaseQuickSourcePreview() {
    if (!this.quickSourcePreview) return;
    const { media, url } = this.quickSourcePreview;
    media.pause();
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(url);
    this.quickSourcePreview = null;
  }

  pauseQuickSourcePreview() {
    this.quickSourcePreview?.media.pause();
  }

  quickOutputPreviewFor(job) {
    const output = job.outputs?.[0];
    if (!output) return el('p', { class: 'preview-note', text: 'El resultado todavía no está disponible.' });
    if (this.quickOutputPreview?.jobId === job.id && this.quickOutputPreview.blob === output.blob) {
      return this.quickOutputPreview.node;
    }

    this.releaseQuickOutputPreview();
    const url = URL.createObjectURL(output.blob);
    const media = el('video', {
      class: 'quick-result-media',
      src: url,
      controls: true,
      playsInline: true,
      preload: 'metadata',
    });
    const fallback = el('p', {
      class: 'preview-note',
      hidden: true,
      text: 'El resultado está listo, pero este navegador no puede reproducir este formato. Podés descargarlo normalmente.',
    });
    const node = el('div', { class: 'quick-result-preview' }, [media, fallback]);
    media.addEventListener('error', () => {
      media.hidden = true;
      fallback.hidden = false;
    });
    this.quickOutputPreview = { jobId: job.id, blob: output.blob, url, node, media };
    return node;
  }

  quickTransformDimensions(job, options = job.options) {
    const video = job.info?.video;
    if (!video?.width || !video?.height) return null;

    const metadataRotation = ((Number(video.rotation) || 0) % 360 + 360) % 360;
    let width = video.width;
    let height = video.height;
    if (metadataRotation === 90 || metadataRotation === 270) [width, height] = [height, width];
    const source = { width, height };

    const requestedRotation = ((Number(options.rotate) || 0) % 360 + 360) % 360;
    if (requestedRotation === 90 || requestedRotation === 270) [width, height] = [height, width];

    const target = RESOLUTIONS.find((item) => item.id === options.resolution);
    if (target?.height) {
      const capWidth = Math.round(((target.height * 16) / 9) / 2) * 2;
      const scale = Math.min(1, capWidth / width, target.height / height);
      width = Math.max(2, Math.round((width * scale) / 2) * 2);
      height = Math.max(2, Math.round((height * scale) / 2) * 2);
    }

    return { source, output: { width, height } };
  }

  quickTransformDescription(job, tool) {
    return describeFocusedQuickTransformation(tool.id, job.options, job.info) || tool.title;
  }

  quickSourcePreviewFor(job, tool) {
    if (this.quickSourcePreview?.jobId !== job.id) {
      this.releaseQuickSourcePreview();
      const url = URL.createObjectURL(job.file);
      const media = el('video', {
        class: 'quick-transform-media',
        src: url,
        playsInline: true,
        preload: 'metadata',
        loop: true,
        attrs: { 'aria-label': `Vista previa de ${job.name}` },
      });
      const overlay = el('span', { class: 'quick-transform-overlay' });
      const play = el('button', {
        type: 'button',
        class: 'text-button quick-transform-play',
        text: 'Reproducir vista previa',
      });
      const stage = el('div', {
        class: 'quick-transform-stage',
        attrs: { 'aria-label': 'Vista previa de la transformación' },
      }, [media, overlay, play]);

      const syncPlayLabel = () => {
        play.textContent = media.paused ? 'Reproducir vista previa' : 'Pausar vista previa';
      };
      play.addEventListener('click', () => {
        if (media.paused) media.play().catch(syncPlayLabel);
        else media.pause();
      });
      media.addEventListener('play', syncPlayLabel);
      media.addEventListener('pause', syncPlayLabel);
      media.addEventListener('error', () => {
        overlay.textContent = 'Vista previa no disponible · el procesamiento local sigue funcionando';
        play.hidden = true;
      });
      this.quickSourcePreview = { jobId: job.id, url, media, overlay, play, stage };
    }

    const preview = this.quickSourcePreview;
    const rotation = tool.id === 'video-rotate' ? Number(job.options.rotate) || 0 : 0;
    const flip = tool.id === 'video-flip' ? job.options.flip : 'none';
    preview.media.style.setProperty('--quick-rotation', `${rotation}deg`);
    preview.media.style.setProperty('--quick-flip-x', flip === 'horizontal' ? '-1' : '1');
    preview.media.style.setProperty('--quick-flip-y', flip === 'vertical' ? '-1' : '1');
    preview.stage.dataset.sideways = String(rotation === 90 || rotation === 270);
    preview.stage.dataset.focus = 'input';
    preview.overlay.textContent = this.quickTransformDescription(job, tool);

    const locked = job.status === 'running' || job.status === 'queued';
    preview.stage.inert = locked;
    preview.stage.setAttribute('aria-disabled', String(locked));
    preview.play.disabled = locked;
    if (locked) preview.media.pause();
    return preview.stage;
  }

  /**
   * The timeline for a job, built once and kept.
   *
   * `paintDetail` rebuilds the inspector on every change to any option, and a
   * scrubber rebuilt that often would be unusable: it owns a `<video>` and an
   * object URL, so each rebuild would re-fetch the file, leak the previous URL,
   * and — worst of the three — throw away the zoom and the selection someone
   * was in the middle of setting. So it is cached against the job it belongs
   * to, and only replaced when that changes.
   */
  scrubberFor(job) {
    if (this.scrubber?.jobId === job.id) {
      this.scrubber.control.setDisabled?.(job.status === 'running' || job.status === 'queued');
      return this.scrubber.control.node;
    }

    this.releaseScrubber();
    const range = trimRange(job.info, job.options);
    const control = createScrubber({
      file: job.file,
      info: job.info,
      initialSelection: range.to === null ? null : { from: range.from, to: range.to },
      mediaControls: job.forgeToolId === 'video-trim',
      locale: job.forgeToolId === 'video-trim' ? 'es' : 'en',
      onChange: ({ from, to }) => {
        // Written straight into the options rather than through `set`, because
        // the whole point of holding on to the control is not repainting the
        // panel it is sitting in while a handle is still being dragged.
        job.options.trimStart = from > 0 ? from : null;
        job.options.trimEnd = to < job.info.duration ? to : null;
        job.previewMode = 'source';
        job.validationError = null;
        if (job.status === 'done') job.dirtySinceOutput = true;
        this.scheduleCommandPreview();
        this.paintQueue();
        this.updateQuickRangeSummary(job);
      },
    });

    this.scrubber = { jobId: job.id, control };
    control.setDisabled?.(job.status === 'running' || job.status === 'queued');
    return control.node;
  }

  releaseScrubber() {
    this.scrubber?.control.destroy();
    this.scrubber = null;
  }

  /**
   * The preview plays the *source*, using the browser's own decoder rather
   * than FFmpeg. For an MKV or an AVI the browser will decline, and that is
   * fine — it costs nothing to try and the controls do not depend on it.
   */
  renderPreview(job) {
    const container = this.dom.preview;
    if (container.dataset.job === job.id && container.firstChild) return;

    this.releasePreview();
    container.textContent = '';
    container.dataset.job = job.id;
    if (job.status === 'probing') return;

    this.previewUrl = URL.createObjectURL(job.file);
    const media = el(job.info?.hasVideo ? 'video' : 'audio', {
      class: 'preview-media',
      src: this.previewUrl,
      controls: true,
      preload: 'metadata',
    });
    media.addEventListener('error', () => {
      container.textContent = '';
      container.append(
        el('p', {
          class: 'preview-note',
          text: 'This browser cannot play this format. FFmpeg can still convert it.',
        })
      );
    });
    container.append(media);
  }

  /* ------------------------------------------------------------------ *
   * Controls
   * ------------------------------------------------------------------ */

  quickInvalidMessage(tool) {
    switch (tool?.focus) {
      case 'trim':
        return 'El inicio y el final tienen que dejar al menos un instante de video seleccionado.';
      case 'rotate':
        return 'Elegí un giro de 90°, 180° o 270°.';
      case 'flip':
        return 'Elegí si querés voltear el video en horizontal o en vertical.';
      case 'resize':
        return 'Elegí un tamaño que reduzca realmente este video.';
      default:
        return 'Revisá los ajustes antes de crear el resultado.';
    }
  }

  quickJobRunnable(job, tool = this.quickToolFor(job)) {
    if (!tool || !job?.info) return false;
    if (tool.focus === 'trim') return Boolean(trimOptionsForRun(job.info, job.options));
    return Boolean(normalizeFocusedQuickOptions(tool.id, job.options, job.info));
  }

  quickStatusCopy(job) {
    const tool = this.quickToolFor(job);
    const isTrim = tool?.focus === 'trim';
    if (job.validationError) {
      return { title: isTrim ? 'Revisá el recorte' : 'Revisá los ajustes', detail: job.validationError };
    }
    if (job.status === 'probing') {
      return { title: 'Analizando el archivo', detail: 'Leyendo duración, formato y pistas sin subir nada.' };
    }
    if (job.status === 'queued') {
      return { title: 'En cola', detail: 'El resultado empezará cuando el motor quede libre.' };
    }
    if (job.status === 'running') {
      const percent = Math.round(job.progress * 100);
      const remaining = job.remaining !== null ? ` · ${formatDuration(job.remaining)} restantes` : '';
      return { title: `Creando resultado · ${percent}%`, detail: `Procesamiento local${remaining}` };
    }
    if (job.status === 'done') {
      if (job.dirtySinceOutput) {
        return {
          title: 'Cambios sin procesar',
          detail: 'El resultado disponible corresponde a los ajustes anteriores.',
        };
      }
      return {
        title: 'Resultado listo',
        detail: `${formatBytes(job.outputSize || 0)} · listo para revisar o descargar.`,
      };
    }
    if (job.status === 'failed') {
      const previous = job.outputs?.length ? ' El resultado anterior sigue disponible.' : '';
      return {
        title: 'No pudimos crear el resultado',
        detail: `${job.error || 'Revisá los ajustes e intentá de nuevo.'}${previous}`,
      };
    }
    if (job.status === 'cancelled') {
      const previous = job.outputs?.length ? ' El resultado anterior sigue disponible.' : '';
      return {
        title: 'Procesamiento cancelado',
        detail: `Tus ajustes siguen intactos y podés volver a intentarlo.${previous}`,
      };
    }
    return { title: 'Listo para procesar', detail: 'El resultado se creará en este dispositivo.' };
  }

  quickProcessingCard(job) {
    const copy = this.quickStatusCopy(job);
    const visualStatus = job.validationError ? 'failed' : (job.dirtySinceOutput ? 'ready' : job.status);
    const progress = el('progress', {
      class: 'quick-progress',
      max: 1,
      value: job.status === 'done' ? 1 : job.progress || 0,
      hidden: job.status !== 'running' && job.status !== 'queued',
    });
    return el('div', {
      class: 'quick-processing-card',
      dataset: { status: visualStatus },
      attrs: { 'aria-live': 'polite' },
    }, [
      el('strong', { text: copy.title, dataset: { quickProgressTitle: '' } }),
      el('span', { text: copy.detail, dataset: { quickProgressDetail: '' } }),
      progress,
    ]);
  }

  quickFormatNote(formatId) {
    return ({
      'mp4-h264': 'La opción más compatible para reproducir, compartir y editar.',
      'webm-vp8': 'Formato abierto para la web; suele generar archivos más grandes.',
      'mkv-h264': 'Contenedor flexible para conservar pistas y metadatos.',
      'mov-h264': 'Pensado para flujos de edición que usan QuickTime.',
    })[formatId] || '';
  }

  quickResolutionOptions() {
    return RESOLUTIONS.map((item) => ({
      value: item.id,
      label: item.id === 'source' ? 'Igual que el original' : item.label,
    }));
  }

  quickQualityOptions() {
    const labels = { high: 'Alta', balanced: 'Equilibrada', small: 'Archivo liviano' };
    return QUALITIES.map((item) => ({ value: item.id, label: labels[item.id] || item.label }));
  }

  quickOutputSection(job, { includeResolution = true } = {}) {
    const formatControl = this.selectControl(
      this.usable(VIDEO_FORMATS.filter((item) => item.kind === 'video')),
      job.options.format,
      (value) => this.setJobOption(job, 'format', value)
    );
    formatControl.dataset.quickOption = 'format';
    const format = this.field('Formato de salida', formatControl, this.quickFormatNote(job.options.format));

    const advancedFields = el('div', { class: 'quick-output-fields' });
    if (includeResolution) {
      const resolutionControl = this.selectControl(
        this.quickResolutionOptions(),
        job.options.resolution,
        (value) => this.setJobOption(job, 'resolution', value)
      );
      resolutionControl.dataset.quickOption = 'resolution';
      advancedFields.append(this.field('Resolución', resolutionControl, 'Nunca se agranda un video más chico.'));
    }
    const qualityControl = this.selectControl(
      this.quickQualityOptions(),
      job.options.quality,
      (value) => this.setJobOption(job, 'quality', value)
    );
    qualityControl.dataset.quickOption = 'quality';
    advancedFields.append(this.field('Calidad', qualityControl));
    if (job.info?.hasAudio) {
      const muteControl = this.checkbox(
        job.options.mute,
        'Quitar el audio',
        (value) => this.setJobOption(job, 'mute', value)
      );
      muteControl.querySelector('input').dataset.quickOption = 'mute';
      advancedFields.append(el('div', { class: 'control' }, [
        muteControl,
      ]));
    }

    const advanced = el('details', {
      class: 'quick-advanced',
      open: Boolean(job.quickAdvancedOpen),
    }, [
      el('summary', { text: 'Opciones avanzadas' }),
      advancedFields,
    ]);
    advanced.addEventListener('toggle', () => {
      job.quickAdvancedOpen = advanced.open;
    });

    const section = el('section', { class: 'quick-inspector-section' }, [
      el('h3', { text: 'Resultado' }),
      el('div', { class: 'quick-output-fields' }, [format]),
      advanced,
    ]);
    const locked = job.status === 'running' || job.status === 'queued';
    for (const input of section.querySelectorAll('input, select, button')) input.disabled = locked;
    return section;
  }

  wireQuickTabs(job, sourceTab, resultTab) {
    const tabs = [sourceTab, resultTab];
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        job.pendingQuickTab = tab.dataset.action === 'preview-result' ? 'result' : 'source';
      });
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const enabled = tabs.filter((candidate) => !candidate.disabled);
        if (enabled.length < 2) return;
        const current = enabled.indexOf(tab);
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = enabled.length - 1;
        else next = (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
        event.preventDefault();
        enabled[next].click();
      });
    }
  }

  renderQuickToolControls(job, tool) {
    if (tool.id !== 'video-trim') {
      this.renderQuickTransformControls(job, tool);
      return;
    }
    const container = this.dom.controls;
    const hasInfo = Boolean(job.info);
    if (hasInfo) job.options.format = quickVideoFormat(job.options.format);
    const resultAvailable = Boolean(job.outputs?.length);
    if (!resultAvailable && job.previewMode === 'result') job.previewMode = 'source';
    const showingResult = resultAvailable && job.previewMode === 'result';
    if (!showingResult) this.pauseQuickOutputPreview();
    const panelId = `quick-preview-panel-${job.id}`;
    const sourceTabId = `quick-preview-source-${job.id}`;
    const resultTabId = `quick-preview-result-${job.id}`;

    const sourceTab = el('button', {
      id: sourceTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? '' : ' is-active'}`,
      text: 'Original',
      tabIndex: showingResult ? -1 : 0,
      dataset: { action: 'preview-source' },
      attrs: { role: 'tab', 'aria-selected': String(!showingResult), 'aria-controls': panelId },
    });
    const resultTab = el('button', {
      id: resultTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? ' is-active' : ''}`,
      text: resultAvailable && (job.dirtySinceOutput || job.status !== 'done') ? 'Resultado anterior' : 'Resultado',
      disabled: !resultAvailable,
      tabIndex: showingResult ? 0 : -1,
      dataset: { action: 'preview-result' },
      attrs: { role: 'tab', 'aria-selected': String(showingResult), 'aria-controls': panelId },
    });
    this.wireQuickTabs(job, sourceTab, resultTab);

    const previewContent = el('div', {
      id: panelId,
      class: 'quick-preview-content',
      attrs: { role: 'tabpanel', 'aria-labelledby': showingResult ? resultTabId : sourceTabId },
    });
    if (!hasInfo) {
      previewContent.append(this.quickProcessingCard(job));
    } else if (showingResult) {
      this.scrubber?.control.setDisabled?.(true);
      previewContent.append(this.quickOutputPreviewFor(job));
    } else if (Number.isFinite(job.info.duration) && job.info.duration > 0) {
      previewContent.append(this.scrubberFor(job));
    } else {
      previewContent.append(el('p', {
        class: 'preview-note',
        text: 'No pudimos medir la duración de este video. Usá el conversor general para procesarlo.',
      }));
    }

    const canvas = el('section', { class: 'quick-canvas' }, [
      el('header', { class: 'quick-preview-head' }, [
        el('div', { class: 'quick-preview-copy' }, [
          el('strong', { text: job.name }),
          el('span', {
            text: showingResult
              ? `${formatBytes(job.outputSize || 0)} · resultado procesado`
              : (hasInfo ? this.describeSource(job) : 'Preparando la vista previa…'),
          }),
          el('small', { text: 'Local · el archivo no sale de este dispositivo' }),
        ]),
        el('div', {
          class: 'quick-preview-switch',
          attrs: { role: 'tablist', 'aria-label': 'Vista previa' },
        }, [sourceTab, resultTab]),
      ]),
      previewContent,
    ]);

    const inspector = el('aside', { class: 'quick-inspector', attrs: { 'aria-label': 'Ajustes del recorte' } });
    if (!hasInfo) {
      inspector.append(el('section', { class: 'quick-inspector-section' }, [
        el('h3', { text: 'Preparando el recorte' }),
        el('p', { text: 'Cuando termine el análisis vas a poder elegir el inicio, el final y el formato de salida.' }),
        this.quickProcessingCard(job),
      ]));
    } else {
      const range = describeTrimRange(job.info, job.options);
      const trimSection = el('section', { class: 'quick-inspector-section' }, [
        el('h3', { text: 'Recorte' }),
        el('p', { text: 'Mové los extremos del timeline o escribí un tiempo exacto.' }),
        el('div', { class: 'quick-range-grid' }, [
          el('div', { class: 'quick-range-value' }, [
            el('span', { text: 'Inicio' }),
            el('output', { text: range.from, dataset: { quickRange: 'from' } }),
          ]),
          el('div', { class: 'quick-range-value' }, [
            el('span', { text: 'Final' }),
            el('output', { text: range.to || '—', dataset: { quickRange: 'to' } }),
          ]),
          el('div', { class: 'quick-range-value quick-range-duration' }, [
            el('span', { text: 'Duración del resultado' }),
            el('output', { text: range.duration || '—', dataset: { quickRange: 'duration' } }),
          ]),
        ]),
      ]);

      const outputSection = this.quickOutputSection(job);

      inspector.append(trimSection, outputSection, el('section', { class: 'quick-inspector-section' }, [
        this.quickProcessingCard(job),
      ]));
    }

    const layout = el('div', {
      class: 'quick-tool-layout',
      attrs: { 'aria-busy': String(job.status === 'probing' || job.status === 'queued' || job.status === 'running') },
    }, [canvas, inspector]);
    container.append(layout);
    this.updateQuickRangeSummary(job);
  }

  quickTransformChoiceConfig(job, tool) {
    if (tool.id === 'video-rotate') {
      return {
        key: 'rotate',
        title: 'Orientación',
        description: 'Elegí cómo querés girar el cuadro.',
        columns: 3,
        items: [
          { value: 90, label: '90° derecha', meta: 'Horario' },
          { value: 180, label: '180°', meta: 'Media vuelta' },
          { value: 270, label: '90° izquierda', meta: 'Antihorario' },
        ],
      };
    }
    if (tool.id === 'video-flip') {
      return {
        key: 'flip',
        title: 'Dirección del espejo',
        description: 'Invertí el cuadro de izquierda a derecha o de arriba hacia abajo.',
        columns: 2,
        items: [
          { value: 'horizontal', label: 'Horizontal', meta: 'Izquierda ↔ derecha' },
          { value: 'vertical', label: 'Vertical', meta: 'Arriba ↕ abajo' },
        ],
      };
    }

    const items = RESOLUTIONS
      .filter((resolution) => resolution.height !== null)
      .filter((resolution) => normalizeFocusedQuickOptions(
        tool.id,
        { resolution: resolution.id },
        job.info
      ))
      .map((resolution) => {
        const dimensions = this.quickTransformDimensions(job, {
          ...job.options,
          resolution: resolution.id,
        });
        return {
          value: resolution.id,
          label: resolution.label,
          meta: dimensions ? `${dimensions.output.width}×${dimensions.output.height}` : `Hasta ${resolution.height}p`,
          preset: true,
        };
      });
    return {
      key: 'resolution',
      title: 'Tamaño máximo',
      description: 'Mostramos sólo tamaños que realmente reducen este video.',
      columns: 2,
      variant: 'presets',
      items,
    };
  }

  quickChoiceGrid(job, config) {
    const locked = job.status === 'running' || job.status === 'queued';
    const grid = el('div', {
      class: 'quick-choice-grid',
      dataset: {
        columns: String(config.columns),
        ...(config.variant ? { variant: config.variant } : {}),
      },
      attrs: { role: 'radiogroup', 'aria-label': config.title },
    });
    for (const item of config.items) {
      const active = String(job.options[config.key]) === String(item.value);
      const button = el('button', {
        type: 'button',
        class: `quick-choice${active ? ' is-active' : ''}`,
        disabled: locked,
        tabIndex: active ? 0 : -1,
        dataset: {
          ...(item.preset ? { preset: '' } : {}),
          quickOption: config.key,
          quickValue: String(item.value),
        },
        attrs: { role: 'radio', 'aria-checked': String(active) },
      }, [
        el('strong', { text: item.label }),
        el('small', { text: item.meta }),
      ]);
      button.addEventListener('click', () => this.setJobOption(job, config.key, item.value));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(grid.querySelectorAll('[role="radio"]'));
        const current = buttons.indexOf(button);
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else {
          const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
          next = (current + (forward ? 1 : -1) + buttons.length) % buttons.length;
        }
        event.preventDefault();
        buttons[next].click();
      });
      grid.append(button);
    }
    return grid;
  }

  quickDimensionSummary(job) {
    const dimensions = this.quickTransformDimensions(job);
    if (!dimensions) return null;
    return el('div', { class: 'quick-dimension-summary' }, [
      el('div', {}, [
        el('span', { text: 'Original' }),
        el('strong', { text: `${dimensions.source.width}×${dimensions.source.height}` }),
      ]),
      el('span', { class: 'quick-dimension-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
      el('div', {}, [
        el('span', { text: 'Resultado estimado' }),
        el('output', { text: `${dimensions.output.width}×${dimensions.output.height}` }),
      ]),
    ]);
  }

  renderQuickTransformControls(job, tool) {
    const container = this.dom.controls;
    const hasInfo = Boolean(job.info);
    if (hasInfo) job.options.format = quickVideoFormat(job.options.format);
    const resultAvailable = Boolean(job.outputs?.length);
    if (!resultAvailable && job.previewMode === 'result') job.previewMode = 'source';
    const showingResult = resultAvailable && job.previewMode === 'result';
    const panelId = `quick-preview-panel-${job.id}`;
    const sourceTabId = `quick-preview-source-${job.id}`;
    const resultTabId = `quick-preview-result-${job.id}`;

    const sourceTab = el('button', {
      id: sourceTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? '' : ' is-active'}`,
      text: 'Vista previa',
      tabIndex: showingResult ? -1 : 0,
      dataset: { action: 'preview-source' },
      attrs: { role: 'tab', 'aria-selected': String(!showingResult), 'aria-controls': panelId },
    });
    const resultTab = el('button', {
      id: resultTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? ' is-active' : ''}`,
      text: resultAvailable && (job.dirtySinceOutput || job.status !== 'done') ? 'Resultado anterior' : 'Resultado',
      disabled: !resultAvailable,
      tabIndex: showingResult ? 0 : -1,
      dataset: { action: 'preview-result' },
      attrs: { role: 'tab', 'aria-selected': String(showingResult), 'aria-controls': panelId },
    });
    this.wireQuickTabs(job, sourceTab, resultTab);

    const previewContent = el('div', {
      id: panelId,
      class: 'quick-preview-content',
      attrs: { role: 'tabpanel', 'aria-labelledby': showingResult ? resultTabId : sourceTabId },
    });
    if (!hasInfo) {
      previewContent.append(this.quickProcessingCard(job));
    } else if (showingResult) {
      this.pauseQuickSourcePreview();
      previewContent.append(this.quickOutputPreviewFor(job));
    } else {
      this.pauseQuickOutputPreview();
      previewContent.append(this.quickSourcePreviewFor(job, tool));
    }

    const canvas = el('section', { class: 'quick-canvas' }, [
      el('header', { class: 'quick-preview-head' }, [
        el('div', { class: 'quick-preview-copy' }, [
          el('strong', { text: job.name }),
          el('span', {
            text: showingResult
              ? `${formatBytes(job.outputSize || 0)} · resultado procesado`
              : (hasInfo ? `${this.describeSource(job)} · ${this.quickTransformDescription(job, tool)}` : 'Preparando la vista previa…'),
          }),
          el('small', { text: 'Local · el archivo no sale de este dispositivo' }),
        ]),
        el('div', {
          class: 'quick-preview-switch',
          attrs: { role: 'tablist', 'aria-label': 'Vista previa' },
        }, [sourceTab, resultTab]),
      ]),
      previewContent,
    ]);

    const inspector = el('aside', {
      class: 'quick-inspector',
      attrs: { 'aria-label': `Ajustes de ${tool.title.toLowerCase()}` },
    });
    if (!hasInfo) {
      inspector.append(el('section', { class: 'quick-inspector-section' }, [
        el('h3', { text: `Preparando: ${tool.title}` }),
        el('p', { text: 'Cuando termine el análisis vas a poder elegir el cambio y revisar la salida.' }),
        this.quickProcessingCard(job),
      ]));
    } else {
      const config = this.quickTransformChoiceConfig(job, tool);
      const focusSection = el('section', { class: 'quick-inspector-section' }, [
        el('h3', { text: config.title }),
        el('p', { text: config.description }),
      ]);
      if (config.items.length) focusSection.append(this.quickChoiceGrid(job, config));
      else focusSection.append(el('p', {
        class: 'preview-note',
        text: 'Este video ya está en el tamaño mínimo que ofrecen los presets seguros.',
      }));
      const dimensions = this.quickDimensionSummary(job);
      if (dimensions) focusSection.append(dimensions);

      inspector.append(
        focusSection,
        this.quickOutputSection(job, { includeResolution: tool.id !== 'video-resize' }),
        el('section', { class: 'quick-inspector-section' }, [this.quickProcessingCard(job)])
      );
    }

    container.append(el('div', {
      class: 'quick-tool-layout',
      attrs: { 'aria-busy': String(job.status === 'probing' || job.status === 'queued' || job.status === 'running') },
    }, [canvas, inspector]));
  }

  updateQuickRangeSummary(job) {
    const tool = this.quickToolFor(job);
    if (!job?.info || this.selectedId !== job.id || tool?.focus !== 'trim') return;
    const range = describeTrimRange(job.info, job.options);
    for (const key of ['from', 'to', 'duration']) {
      const output = this.dom.controls.querySelector(`[data-quick-range="${key}"]`);
      if (output) output.textContent = range[key] || '—';
    }
    this.renderQuickFooter(job, tool);

    this.renderDetailActions(job, tool);
  }

  updateQuickProgress(job) {
    if (this.selectedId !== job.id || !this.quickToolFor(job)) return;
    const card = this.dom.controls.querySelector('.quick-processing-card');
    if (card) {
      const copy = this.quickStatusCopy(job);
      card.dataset.status = job.validationError ? 'failed' : (job.dirtySinceOutput ? 'ready' : job.status);
      const title = card.querySelector('[data-quick-progress-title]');
      const detail = card.querySelector('[data-quick-progress-detail]');
      const progress = card.querySelector('progress');
      if (title) title.textContent = copy.title;
      if (detail) detail.textContent = copy.detail;
      if (progress) {
        progress.hidden = job.status !== 'running' && job.status !== 'queued';
        progress.value = job.progress || 0;
      }
    }
    this.renderQuickFooter(job, this.quickToolFor(job));
  }

  renderQuickFooter(job, tool) {
    const summary = this.dom.quickFootSummary;
    if (!tool || !job) {
      summary.hidden = true;
      summary.replaceChildren();
      return;
    }

    summary.hidden = false;
    const range = job.info && tool.focus === 'trim' ? describeTrimRange(job.info, job.options) : null;
    const transformation = job.info && tool.focus !== 'trim'
      ? describeFocusedQuickTransformation(tool.id, job.options, job.info)
      : null;
    const copy = this.quickStatusCopy(job);
    const showStatus = job.status !== 'ready' || Boolean(job.validationError);
    summary.replaceChildren(
      el('strong', {
        text: showStatus
          ? copy.title
          : (tool.focus === 'trim' ? `${range?.duration || '—'} seleccionados` : (transformation || 'Elegí un ajuste')),
      }),
      el('span', { text: showStatus ? copy.detail : 'Procesamiento local · original intacto' })
    );
  }

  renderControls(job) {
    const container = this.dom.controls;
    container.textContent = '';
    const quickTool = this.quickToolFor(job);
    if (quickTool) {
      this.renderQuickToolControls(job, quickTool);
      return;
    }
    if (job.status === 'probing') return;

    const operations = operationsFor(job.info);
    if (!operations.some((operation) => operation.id === job.operation)) job.operation = operations[0].id;
    const operation = operationById(job.operation);

    container.append(
      this.field('What to do', this.selectControl(
        operations.map((item) => ({ value: item.id, label: item.label })),
        job.operation,
        (value) => {
          job.operation = value;
          this.paintDetail();
        }
      ), operation.summary)
    );

    const advanced = prefs.get('advanced');
    for (const control of operation.controls) {
      const built = this.buildControl(control, job, advanced);
      if (built) container.append(built);
    }

    const notice = this.fidelityNotice(job);
    if (notice) container.append(notice);
  }

  /**
   * The audio format this job will actually produce, or null if it produces
   * none. Not the same as the format the user picked: choosing MP4 means AAC,
   * choosing WebM means Vorbis, and choosing FLAC in the Convert menu routes
   * to the audio builder entirely.
   */
  audioTarget(job) {
    const { options } = job;
    if (job.operation === 'extract-audio') return formatById(options.audioFormat);
    if (job.operation !== 'convert') return null;

    const target = formatById(options.format);
    if (!target) return null;
    if (target.kind === 'audio') return target;
    if (options.mute || !job.info?.hasAudio) return null;

    const encoder = target.encoders[1];
    return AUDIO_FORMATS.find((format) => AUDIO_ENCODERS[format.id] === encoder) || null;
  }

  /**
   * Warn before wrapping lossy audio in a lossless container.
   *
   * This is the most common mistake people make with FLAC, and it is invisible
   * without being told: the conversion succeeds, the file gets several times
   * larger, and not one bit of what the MP3 discarded comes back. The app
   * already knows both halves — the source codec from the probe and the target
   * from the menu — so there is no excuse for letting it happen silently.
   */
  fidelityNotice(job) {
    const target = this.audioTarget(job);
    if (!target?.lossless) return null;

    const source = job.info?.audio?.codec;
    if (audioFidelity(source) !== 'lossy') return null;

    return el('p', {
      class: 'notice',
      text:
        `This file's audio is ${source.toUpperCase()}, which already threw information away to get small. ` +
        `Saving it as ${target.label} cannot bring any of it back — it only makes the file several times larger. ` +
        `${target.label} is worth it when the source is a CD, a master, or another lossless file.`,
    });
  }

  field(label, control, hint) {
    return el('label', { class: 'control' }, [
      el('span', { class: 'control-label', text: label }),
      control,
      hint ? el('span', { class: 'control-hint', text: hint }) : null,
    ]);
  }

  selectControl(options, value, onChange) {
    const node = el('select', { class: 'control-input' },
      options.map((option) => el('option', { value: option.value, text: option.label, disabled: option.disabled }))
    );
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  number(value, { min, max, step = 1, suffix }, onChange) {
    const input = el('input', {
      class: 'control-input control-number',
      type: 'number',
      value: String(value),
      attrs: { min: String(min), max: String(max), step: String(step) },
    });
    input.addEventListener('input', () => onChange(Number(input.value)));
    return suffix ? el('span', { class: 'control-pair' }, [input, el('span', { class: 'control-suffix', text: suffix })]) : input;
  }

  text(value, placeholder, onChange) {
    const input = el('input', { class: 'control-input', type: 'text', value, placeholder, spellcheck: false });
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  checkbox(checked, label, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('span', { class: 'control-switch' }, [input, el('span', { text: label })]);
  }

  setJobOption(job, key, value) {
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingQuickFocus = { key, value: String(value) };
    }
    job.options[key] = value;
    job.previewMode = 'source';
    job.validationError = null;
    if (job.status === 'done') job.dirtySinceOutput = true;
    if (key === 'format') prefs.set('preset', value);
    this.scheduleCommandPreview();
    this.paintQueue();
    if (this.quickToolFor(job) && this.selectedId === job.id) this.paintDetail();
  }

  /** Formats the loaded core can actually produce, with the rest left out. */
  usable(formats) {
    return formats
      .filter((format) => supportsFormat(this.capabilities, format))
      .map((format) => ({ value: format.id, label: format.label }));
  }

  buildControl(control, job, advanced) {
    const set = (key, value) => this.setJobOption(job, key, value);
    const options = job.options;

    switch (control) {
      case 'format':
        return this.field('Convert to', this.selectControl(
          [...this.usable(VIDEO_FORMATS), ...this.usable(AUDIO_FORMATS)],
          options.format,
          (value) => {
            set('format', value);
            this.paintDetail();
          }
        ), formatById(options.format)?.note);

      case 'audioFormat':
        return this.field('Save as', this.selectControl(this.usable(AUDIO_FORMATS), options.audioFormat, (value) => {
          set('audioFormat', value);
          this.paintDetail();
        }), formatById(options.audioFormat)?.note);

      case 'remuxTarget': {
        // Built from the file rather than from the format table: which
        // containers can hold these streams untouched depends on what the
        // streams are, so the menu is different for every file. No capability
        // filter, because copying asks the core for no encoder at all — which
        // is exactly how HEVC and VP9 get out of here despite having no usable
        // encoder in this build.
        const targets = remuxTargets(job.info, job.name);
        if (!targets.length) return null;

        const chosen = targets.find((container) => container.id === options.remuxTarget) || targets[0];
        const streams = [
          job.info?.hasVideo ? job.info.video.codec : null,
          job.info?.hasAudio ? job.info.audio.codec : null,
        ].filter(Boolean).join(' and ');

        return this.field('Repackage as', this.selectControl(
          targets.map((container) => ({ value: container.id, label: container.label })),
          chosen.id,
          (value) => {
            set('remuxTarget', value);
            this.paintDetail();
          }
        ), chosen.note || `Keeps the ${streams} exactly as it is.`);
      }

      case 'imageFormat':
        return this.field('Image format', this.selectControl(this.usable(IMAGE_FORMATS), options.imageFormat, (value) => set('imageFormat', value)));

      case 'resolution':
        if (!job.info?.hasVideo) return null;
        return this.field('Resolution', this.selectControl(
          RESOLUTIONS.map((item) => ({ value: item.id, label: item.label })),
          options.resolution,
          (value) => set('resolution', value)
        ), 'Never enlarged — a smaller source stays its own size.');

      case 'fps':
        if (!job.info?.hasVideo) return null;
        return this.field('Frame rate', this.selectControl(
          FRAME_RATES.map((item) => ({ value: item.id, label: item.label })),
          options.fps,
          (value) => set('fps', value)
        ));

      case 'quality': {
        if (!job.info?.hasVideo) return null;
        const quality = this.field('Quality', this.selectControl(
          QUALITIES.map((item) => ({ value: item.id, label: item.label })),
          options.quality,
          (value) => set('quality', value)
        ), QUALITIES.find((item) => item.id === options.quality)?.note);

        if (!advanced) return quality;
        return el('div', { class: 'control-group' }, [
          quality,
          this.field('Encoder speed', this.selectControl(
            SPEED_PRESETS.map((preset) => ({ value: preset, label: preset })),
            options.speed,
            (value) => set('speed', value)
          ), 'Slower settings compress better. In a browser tab, much slower.'),
        ]);
      }

      case 'audio': {
        if (!job.info?.hasAudio) return null;
        const parts = [];
        if (job.operation === 'convert') {
          parts.push(el('div', { class: 'control' }, [
            this.checkbox(options.mute, 'Remove the sound', (value) => {
              set('mute', value);
              this.paintDetail();
            }),
          ]));
        }

        const target = this.audioTarget(job);
        const silent = options.mute && job.operation === 'convert';

        // A bitrate means nothing to a lossless encoder — FLAC and WAV ignore
        // it entirely — so offering one would be a control that does nothing
        // whatever the user picks.
        if (!silent && !target?.lossless) {
          parts.push(this.field('Audio bitrate', this.selectControl(
            AUDIO_BITRATES.map((item) => ({ value: String(item.kbps), label: item.label })),
            String(options.audioBitrate),
            (value) => set('audioBitrate', Number(value))
          )));
        }

        // FLAC's own knob. Behind the advanced switch because the honest
        // answer for almost everyone is to leave it where it is.
        if (!silent && target?.id === 'flac' && advanced) {
          parts.push(this.field(
            'Compression effort',
            this.number(options.flacCompression, { min: FLAC_COMPRESSION.min, max: FLAC_COMPRESSION.max }, (value) => set('flacCompression', value)),
            `${FLAC_COMPRESSION.min} to ${FLAC_COMPRESSION.max}. The audio is identical at every level — only the search for a smaller file changes. Past ${FLAC_COMPRESSION.default} the gain is under a percent for several times the work.`
          ));
        }

        return parts.length ? el('div', { class: 'control-group' }, parts) : null;
      }

      case 'trim': {
        const duration = job.info?.duration;

        // A timeline, when there is something to see and something to measure
        // against. Typing timestamps works and is miserable: you cannot tell
        // what you picked until after the conversion. The fields stay below it
        // for when the number is already known.
        const scrubber = job.info?.hasVideo && Number.isFinite(duration) && duration > 0
          ? this.scrubberFor(job)
          : null;

        const start = this.text(options.trimStart === null ? '' : formatTimestamp(options.trimStart), '0:00', (value) => {
          set('trimStart', value.trim() ? parseTimestamp(value) : null);
        });
        const end = this.text(options.trimEnd === null ? '' : formatTimestamp(options.trimEnd), duration ? formatDuration(duration) : 'end', (value) => {
          set('trimEnd', value.trim() ? parseTimestamp(value) : null);
        });
        return el('div', { class: 'control-group' }, [
          el('span', { class: 'control-label', text: 'Trim' }),
          scrubber,
          el('div', { class: 'control-row' }, [
            el('label', { class: 'control-inline' }, [el('span', { text: 'From' }), start]),
            el('label', { class: 'control-inline' }, [el('span', { text: 'To' }), end]),
          ]),
          el('span', {
            class: 'control-hint',
            text: scrubber
              ? 'Drag the handles, or hold ⌘ and scroll to zoom in. Arrows step a frame, with Shift a second and with Alt ten milliseconds; I and O set the ends, Space loops the selection.'
              : 'Leave either blank for the start or the end. Seconds, or m:ss.',
          }),
        ]);
      }

      case 'rotate': {
        if (!job.info?.hasVideo || !advanced) return null;
        return el('div', { class: 'control-group' }, [
          this.field('Rotate', this.selectControl(
            [
              { value: '0', label: 'Not at all' },
              { value: '90', label: '90° clockwise' },
              { value: '180', label: '180°' },
              { value: '270', label: '90° anticlockwise' },
            ],
            String(options.rotate),
            (value) => set('rotate', Number(value))
          )),
          this.field('Flip', this.selectControl(
            [
              { value: 'none', label: 'Not at all' },
              { value: 'horizontal', label: 'Left to right' },
              { value: 'vertical', label: 'Top to bottom' },
            ],
            options.flip,
            (value) => set('flip', value)
          )),
        ]);
      }

      case 'gifFps':
        return this.field('Frames per second', this.number(options.gifFps, { min: 1, max: 50 }, (value) => set('gifFps', value)),
          'Fewer frames, smaller file. Twelve is usually enough.');

      case 'gifWidth':
        return this.field('Width', this.number(options.gifWidth, { min: 32, max: 1920, step: 10, suffix: 'px' }, (value) => set('gifWidth', value)),
          'The height follows the aspect ratio.');

      case 'dither':
        return el('div', { class: 'control' }, [
          this.checkbox(options.dither, 'Dither', (value) => set('dither', value)),
          el('span', { class: 'control-hint', text: 'Trades a grainy texture for smoother gradients across 256 colours.' }),
        ]);

      case 'targetSize':
        return this.field('Target size', this.number(options.targetSize, { min: 0.1, max: 2000, step: 0.1, suffix: 'MB' }, (value) => set('targetSize', value)),
          'Two passes. The result lands near this, not exactly on it.');

      case 'frameInterval':
        return this.field('One frame every', this.number(options.frameInterval, { min: 0.04, max: 600, step: 0.1, suffix: 'seconds' }, (value) => set('frameInterval', value)));

      case 'at':
        return this.field('At', this.text(formatTimestamp(options.at), '0:00', (value) => set('at', parseTimestamp(value) ?? 0)),
          'Where in the clip to take the picture from.');

      case 'rawArguments':
        return this.field('Arguments', this.text(options.rawArguments, '-i $in -c copy $out.mkv', (value) => set('rawArguments', value)),
          '$in is your file. $out is the result — write the extension you want after it.');

      default:
        return null;
    }
  }

  renderCommand() {
    const job = this.selected;
    if (!job || !job.info) return;
    const quickTool = this.quickToolFor(job);
    if (quickTool && !this.quickJobRunnable(job, quickTool)) {
      this.dom.commandText.textContent = this.quickInvalidMessage(quickTool);
      this.dom.commandText.dataset.invalid = 'true';
      return;
    }
    try {
      const plan = buildPlan({ name: job.name, info: job.info }, job.operation, job.options);
      this.dom.commandText.textContent = planToCommand(plan);
      this.dom.commandText.dataset.invalid = 'false';
    } catch (error) {
      this.dom.commandText.textContent = error.message;
      this.dom.commandText.dataset.invalid = 'true';
    }
  }

  /* ------------------------------------------------------------------ *
   * Converting
   * ------------------------------------------------------------------ */

  validateQuickJob(job, { notify = true } = {}) {
    const tool = this.quickToolFor(job);
    if (!tool) return true;
    if (!job.info) return false;

    const normalised = tool.focus === 'trim'
      ? trimOptionsForRun(job.info, job.options)
      : normalizeFocusedQuickOptions(tool.id, job.options, job.info);
    if (!normalised) {
      job.validationError = this.quickInvalidMessage(tool);
      if (notify) this.toast(job.validationError, { kind: 'error', duration: 6500 });
      this.paintDetail();
      return false;
    }

    // Write exactly the validated values into the command options. Focused
    // tools deliberately own only their primary transformation, so unrelated
    // settings from a previous generic conversion cannot leak into the result.
    Object.assign(job.options, normalised);
    if (tool.focus === 'rotate') job.options.flip = 'none';
    if (tool.focus === 'flip') job.options.rotate = 0;
    if (tool.focus === 'resize') {
      job.options.rotate = 0;
      job.options.flip = 'none';
    }

    // A Quick Video job must never inherit MP3/FLAC from the converter's last
    // global preset. Keep an existing video target, otherwise use the broadest
    // supported default.
    job.options.format = quickVideoFormat(job.options.format);
    job.validationError = null;
    return true;
  }

  async runQueue({ skipFocused = false } = {}) {
    this.stopRequested = false;
    // Iterate the identities that were pending when this run started. The live
    // array can change while `runJob` is awaiting FFmpeg — for example, when a
    // completed row before the running one is removed. Iterating that mutated
    // array would advance past the next job. `runJob` still checks membership,
    // so a job removed from this snapshot is safely ignored.
    for (const job of [...this.jobs]) {
      if (this.stopRequested) break;
      if (job.status !== 'ready' && job.status !== 'queued') continue;
      if (skipFocused && focusedQuickTool(job.forgeToolId)) continue;
      await this.runJob(job);
    }
  }

  async runJob(job) {
    // A queued task closes over its job object. It may have been removed while
    // waiting for the single FFmpeg instance; never spend CPU on a file the
    // user has already dismissed. Requiring a pending status also makes stale
    // tasks idempotent: if "Process queue" consumes a job before an individual
    // task for that same job gets its turn, the latter sees `done` and exits.
    if (!this.jobs.includes(job) || !job.info || !['ready', 'queued'].includes(job.status)) return;
    if (!this.validateQuickJob(job, { notify: job.status !== 'queued' })) {
      if (job.status === 'queued') job.status = 'ready';
      this.paintQueue();
      this.paintDetail();
      return;
    }

    let plan;
    try {
      plan = buildPlan({ name: job.name, info: job.info }, job.operation, job.options);
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      this.paintQueue();
      this.paintDetail();
      return;
    }

    job.status = 'running';
    job.progress = 0;
    job.error = null;
    job.log = [];
    if (this.quickToolFor(job)) {
      job.previewMode = 'source';
      if (this.quickOutputPreview?.jobId === job.id) this.releaseQuickOutputPreview();
    }
    this.runningId = job.id;
    const startedAt = performance.now();
    this.paintQueue();
    this.paintDetail();

    const running = this.engine.start(plan, job.file, {
      onProgress: (message) => {
        job.progress = message.fraction;
        job.speed = message.speed;
        // The estimate comes from the clock rather than from FFmpeg's own
        // `speed=`, which is wildly optimistic while the encoder warms up —
        // it will happily claim 3× on the first block of a job that finishes
        // at 0.9×. Elapsed-over-fraction is noisier at the very start and
        // correct by the middle, so it is only shown once there is enough of
        // the job behind us to mean anything.
        const elapsed = (performance.now() - startedAt) / 1000;
        job.remaining = message.fraction > 0.05 ? (elapsed * (1 - message.fraction)) / message.fraction : null;
        this.paintQueue();
        this.updateQuickProgress(job);
      },
      onStep: (message) => {
        this.appendLog(`— ${plan.steps[message.step].label} —`);
      },
      onLog: (lines) => {
        job.log.push(...lines);
        this.appendLog(lines.slice(-60).join('\n'));
      },
    });
    this.running = running;

    try {
      const { outputs } = await running.finished;
      job.outputs = outputs.map((output) => ({
        name: output.name,
        blob: new Blob([output.bytes], { type: plan.mime }),
      }));
      job.outputSize = job.outputs.reduce((total, output) => total + output.blob.size, 0);
      job.downloadName = plan.downloadName;
      job.status = 'done';
      job.progress = 1;
      job.dirtySinceOutput = false;
      if (this.quickToolFor(job)) job.previewMode = 'result';

      const seconds = (performance.now() - startedAt) / 1000;
      this.appendLog(`Finished in ${formatDuration(seconds)} · ${formatBytes(job.outputSize)}`);
    } catch (error) {
      job.status = error.cancelled ? 'cancelled' : 'failed';
      job.error = error.cancelled ? 'Cancelled' : error.message;
      if (!error.cancelled) this.appendLog(`Failed: ${error.message}`);
    } finally {
      this.running = null;
      this.runningId = null;
      this.paintQueue();
      this.paintDetail();
    }
  }

  cancelRunning() {
    this.stopRequested = true;
    this.running?.cancel();
  }

  appendLog(text) {
    if (!text) return;
    const body = this.dom.logBody;
    body.textContent = `${body.textContent}${body.textContent ? '\n' : ''}${text}`;
    // Keeping every line of a long encode would grow without bound, and the
    // interesting part is always the end.
    const lines = body.textContent.split('\n');
    if (lines.length > 600) body.textContent = lines.slice(-600).join('\n');
    body.scrollTop = body.scrollHeight;
  }

  /* ------------------------------------------------------------------ *
   * Downloads
   * ------------------------------------------------------------------ */

  async downloadJob(job) {
    if (!job.outputs?.length) return;
    if (job.outputs.length === 1) {
      downloadFile(job.downloadName, job.outputs[0].blob);
      return;
    }
    // Frame extraction produces a directory's worth of images, and handing
    // someone forty separate download prompts is not a feature.
    const zip = await createZip(job.outputs.map((output) => ({ name: output.name, blob: output.blob })));
    downloadFile(job.downloadName, zip);
  }

  async downloadAll() {
    const done = this.jobs.filter((job) => job.status === 'done' && job.outputs?.length);
    if (!done.length) return;
    if (done.length === 1 && done[0].outputs.length === 1) {
      await this.downloadJob(done[0]);
      return;
    }

    const entries = done.flatMap((job) =>
      job.outputs.length === 1
        ? [{ name: job.downloadName, blob: job.outputs[0].blob }]
        : job.outputs.map((output) => ({ name: `${job.downloadName.replace(/\.zip$/, '')}/${output.name}`, blob: output.blob }))
    );

    this.toast('Packing…', { duration: 1500 });
    downloadFile('media-forge.zip', await createZip(entries));
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  bindGlobalEvents() {
    on(document, 'click', (event) => this.onClick(event));
    on(document, 'keydown', (event) => this.onKeydown(event));
    on(window, 'online', () => this.updateOfflineBadge());
    on(window, 'offline', () => this.updateOfflineBadge());
    on(window, 'pagehide', (event) => {
      prefs.flush();
      // A page entering the back/forward cache keeps its DOM alive. Destroying
      // media here would restore a timeline whose listeners and blob URL are
      // gone when the user comes back.
      if (event.persisted) return;
      this.releaseQuickSourcePreview();
      this.releaseQuickOutputPreview();
      this.releasePreview();
      this.releaseScrubber();
    });
    on(window, 'pageshow', (event) => {
      if (!event.persisted) return;
      this.paintQueue();
      this.paintDetail();
    });

    on(this.dom.fileInput, 'change', () => {
      this.addFiles(Array.from(this.dom.fileInput.files || []));
      this.dom.fileInput.value = '';
    });

    // A conversion in flight is minutes of the user's processor time; losing it
    // to a stray ⌘W deserves at least a question.
    on(window, 'beforeunload', (event) => {
      if (!this.runningId) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  updateOfflineBadge() {
    this.dom.statusOffline.hidden = navigator.onLine;
  }

  onClick(event) {
    const jobButton = event.target.closest('.queue-item');
    if (jobButton) {
      this.select(jobButton.dataset.job);
      return;
    }

    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (this.runAction(target.dataset.action, target, event)) event.preventDefault();
  }

  /** @returns {boolean} true when the action was handled. */
  runAction(action, target) {
    const job = this.selected;

    switch (action) {
      case 'add-files':
        this.dom.fileInput.click();
        return true;
      case 'load-sample':
        this.enqueue(() => this.makeSampleClip());
        return true;
      case 'toggle-queue':
        prefs.set('queueOpen', !prefs.get('queueOpen'));
        return true;
      case 'toggle-log':
        prefs.set('logOpen', !prefs.get('logOpen'));
        return true;
      case 'toggle-theme':
        this.cycleTheme();
        return true;
      case 'settings':
        this.dom.settings.showModal();
        this.syncSettings();
        return true;
      case 'start-all':
        this.enqueue(() => this.runQueue());
        return true;
      case 'start-one':
        if (job && !['probing', 'queued', 'running'].includes(job.status) && this.validateQuickJob(job)) {
          // Reset here rather than only inside `runJob`: the run is queued
          // behind whatever else is using the engine, and until it starts the
          // row would otherwise still show the previous result's full bar.
          job.progress = 0;
          job.remaining = null;
          job.status = 'queued';
          job.previewMode = 'source';
          this.releaseQuickOutputPreview();
          this.paintQueue();
          this.paintDetail();
          this.enqueue(() => this.runJob(job));
        }
        return true;
      case 'preview-source':
        if (job) {
          job.previewMode = 'source';
          this.paintDetail();
        }
        return true;
      case 'preview-result':
        if (job?.outputs?.length) {
          job.previewMode = 'result';
          this.paintDetail();
        }
        return true;
      case 'cancel-one':
        this.cancelRunning();
        return true;
      case 'download-one':
        if (job) this.downloadJob(job);
        return true;
      case 'download-all':
        this.downloadAll();
        return true;
      case 'remove':
        this.removeJob(this.jobs.find((item) => item.id === target.dataset.job));
        return true;
      case 'remove-one':
        if (job) this.removeJob(job);
        return true;
      case 'clear-done':
        this.jobs = this.jobs.filter((item) => item.status !== 'done');
        if (!this.jobs.some((item) => item.id === this.selectedId)) this.selectedId = this.jobs[0]?.id || null;
        this.paintQueue();
        this.paintDetail();
        return true;
      case 'copy-command':
        copyText(this.dom.commandText.textContent).then((ok) => this.toast(ok ? 'Copied.' : 'Could not copy.'));
        return true;
      case 'copy-log':
        copyText(this.dom.logBody.textContent).then((ok) => this.toast(ok ? 'Copied.' : 'Could not copy.'));
        return true;
      default:
        return false;
    }
  }

  onKeydown(event) {
    const meta = event.metaKey || event.ctrlKey;
    const interactive = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName) || event.target.isContentEditable;

    if (meta && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      this.dom.fileInput.click();
      return;
    }
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      this.enqueue(() => this.runQueue());
      return;
    }
    if (meta && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      prefs.set('queueOpen', !prefs.get('queueOpen'));
      return;
    }
    if (meta && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      prefs.set('logOpen', !prefs.get('logOpen'));
      return;
    }
    if (meta && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      this.cycleTheme();
      return;
    }
    if (meta && event.key === ',') {
      event.preventDefault();
      this.dom.settings.showModal();
      this.syncSettings();
      return;
    }
    if (interactive) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const index = this.jobs.findIndex((job) => job.id === this.selectedId);
      const next = this.jobs[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        this.select(next.id);
      }
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && this.selected) {
      event.preventDefault();
      this.removeJob(this.selected);
    }
  }

  /* ------------------------------------------------------------------ *
   * Drag and drop
   * ------------------------------------------------------------------ */

  bindDropZone() {
    let depth = 0;

    on(window, 'dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      depth += 1;
      this.dom.dropOverlay.hidden = false;
    });
    on(window, 'dragover', (event) => event.preventDefault());
    on(window, 'dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.dom.dropOverlay.hidden = true;
    });
    on(window, 'drop', async (event) => {
      event.preventDefault();
      depth = 0;
      this.dom.dropOverlay.hidden = true;
      const files = await this.collectFiles(event.dataTransfer);
      this.addFiles(files);
    });
  }

  /* ------------------------------------------------------------------ *
   * The sample clip
   * ------------------------------------------------------------------ */

  /**
   * FFmpeg can generate video out of nothing, so the "try it" button does not
   * need a file committed to the repository — the engine synthesises three
   * seconds of test pattern and a tone, and the result goes into the queue
   * like any other file. It also proves the core works, which is the first
   * thing anyone wants to know.
   */
  async makeSampleClip() {
    try {
      await this.engine.load();
      const plan = {
        steps: [{
          label: 'Making a clip',
          args: [
            '-hide_banner', '-loglevel', 'info', '-stats',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-shortest', 'output.mp4',
          ],
        }],
        inputNames: [],
        outputs: ['output.mp4'],
        mime: 'video/mp4',
        downloadName: 'test-clip.mp4',
        duration: 5,
      };

      const { outputs } = await this.engine.start(plan, null).finished;
      const file = new File([outputs[0].bytes], 'test-clip.mp4', { type: 'video/mp4' });
      this.addFiles([file]);
    } catch (error) {
      this.toast(`Could not make a clip: ${error.message}`, { kind: 'error' });
    }
  }

  /* ------------------------------------------------------------------ *
   * Resizers
   * ------------------------------------------------------------------ */

  bindResizers() {
    for (const handle of document.querySelectorAll('[data-resize]')) {
      on(handle, 'pointerdown', (event) => {
        const which = handle.dataset.resize;
        const key = which === 'queue' ? 'queueWidth' : 'logWidth';
        const startX = event.clientX;
        const startWidth = prefs.get(key);
        handle.setPointerCapture(event.pointerId);

        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          prefs.set(key, startWidth + (which === 'queue' ? delta : -delta));
        };
        const stop = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', stop);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', stop);
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings sheet
   * ------------------------------------------------------------------ */

  bindSettings() {
    for (const control of this.dom.settings.querySelectorAll('[data-pref]')) {
      on(control, 'change', () => {
        const key = control.dataset.pref;
        prefs.set(key, control.type === 'checkbox' ? control.checked : control.value);
      });
    }
  }

  syncSettings() {
    const values = prefs.all();
    for (const control of this.dom.settings.querySelectorAll('[data-pref]')) {
      const value = values[control.dataset.pref];
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = String(value);
    }

    const details = this.engineDetails;
    $('#settings-engine').textContent = details
      ? `FFmpeg ${details.capabilities.version}, ${details.threads ? 'multi-threaded' : 'single-threaded'}, ` +
        `with ${details.capabilities.encoders.length} encoders compiled in.`
      : 'FFmpeg has not finished starting.';

    // Isolation is necessary for the threaded core but not sufficient: the
    // threaded build also has to have been vendored. Saying "isolated, so it
    // is multi-threaded" would be wrong on a checkout that only has the
    // single-threaded one, which is every default checkout.
    const { crossOriginIsolated, sharedArrayBuffer } = isolationStatus();
    const isolated = crossOriginIsolated && sharedArrayBuffer;
    $('#settings-isolation').textContent = details?.threads
      ? 'This page is cross-origin isolated, so the faster multi-threaded core is in use.'
      : isolated
        ? 'This page is cross-origin isolated, but only the single-threaded core is vendored here. ' +
          'Run `node tools/fetch-core.mjs --mt` to add the faster one.'
        : 'This page is not cross-origin isolated, so the single-threaded core is in use. ' +
          'GitHub Pages cannot send the two headers that would change that.';
  }

  /* ------------------------------------------------------------------ *
   * Confirmation
   * ------------------------------------------------------------------ */

  bindConfirmSheet() {
    this.confirmResolve = null;
    on(this.dom.confirmSheet, 'close', () => {
      this.confirmResolve?.(false);
      this.confirmResolve = null;
    });
  }

  confirm({ title, message = '', confirmLabel = 'Confirm', danger = false }) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const accept = $('[data-action="confirm-accept"]');
    accept.textContent = confirmLabel;
    accept.classList.toggle('danger-button', danger);

    return new Promise((resolve) => {
      this.confirmResolve = resolve;
      const finish = (value) => {
        this.confirmResolve = null;
        this.dom.confirmSheet.close();
        resolve(value);
      };
      accept.onclick = () => finish(true);
      $('[data-action="confirm-cancel"]').onclick = () => finish(false);
      this.dom.confirmSheet.showModal();
    });
  }

  /* ------------------------------------------------------------------ *
   * Toasts
   * ------------------------------------------------------------------ */

  toast(message, { kind = 'info', duration = 3200, action = null } = {}) {
    const node = el('div', { class: `toast${kind === 'error' ? ' toast-error' : ''}` }, [
      el('span', { text: message }),
      action ? el('button', { type: 'button', class: 'toast-action', text: action.label }) : null,
    ]);
    if (action) node.querySelector('.toast-action').addEventListener('click', () => {
      action.run();
      node.remove();
    });

    this.dom.toasts.append(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 200);
    }, duration);
    return node;
  }
}
