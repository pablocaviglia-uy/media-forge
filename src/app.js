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
import { supportsFormat } from './ffmpeg/capabilities.js';
import { buildPlan, planToCommand, operationsFor, operationById, DEFAULT_OPTIONS } from './media/commands.js';
import {
  VIDEO_FORMATS, AUDIO_FORMATS, IMAGE_FORMATS,
  RESOLUTIONS, FRAME_RATES, QUALITIES, AUDIO_BITRATES, SPEED_PRESETS,
  formatById,
} from './media/formats.js';
import { createZip } from './media/zip.js';

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

    this.dom = {
      app: $('#app'),
      queueList: $('#queue-list'),
      queueCount: $('#queue-count'),
      inspector: $('#inspector'),
      empty: $('#empty-state'),
      detail: $('#detail'),
      detailName: $('#detail-name'),
      detailFacts: $('#detail-facts'),
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
    if (prefs.get('autoStart')) this.enqueue(() => this.runQueue());
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

  renderDetail() {
    const job = this.selected;
    this.dom.detail.hidden = !job;
    this.dom.empty.hidden = Boolean(job);
    if (!job) {
      this.releasePreview();
      return;
    }

    this.dom.detailName.textContent = job.name;
    this.dom.detailFacts.textContent = this.describeSource(job);

    this.renderPreview(job);
    this.renderControls(job);
    this.renderCommand();

    const advanced = prefs.get('advanced');
    this.dom.commandBlock.hidden = !advanced || job.status === 'probing';

    const running = job.status === 'running';
    $('[data-action="start-one"]').hidden = running || job.status === 'probing';
    $('[data-action="start-one"]').textContent = job.status === 'done' ? 'Convert again' : 'Convert';
    $('[data-action="cancel-one"]').hidden = !running;
    $('[data-action="download-one"]').hidden = job.status !== 'done';
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

  renderControls(job) {
    const container = this.dom.controls;
    container.textContent = '';
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

  /** Formats the loaded core can actually produce, with the rest left out. */
  usable(formats) {
    return formats
      .filter((format) => supportsFormat(this.capabilities, format))
      .map((format) => ({ value: format.id, label: format.label }));
  }

  buildControl(control, job, advanced) {
    const set = (key, value) => {
      job.options[key] = value;
      if (key === 'format') prefs.set('preset', value);
      this.scheduleCommandPreview();
      this.paintQueue();
    };
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
        if (!options.mute || job.operation !== 'convert') {
          parts.push(this.field('Audio bitrate', this.selectControl(
            AUDIO_BITRATES.map((item) => ({ value: String(item.kbps), label: item.label })),
            String(options.audioBitrate),
            (value) => set('audioBitrate', Number(value))
          )));
        }
        return el('div', { class: 'control-group' }, parts);
      }

      case 'trim': {
        const duration = job.info?.duration;
        const start = this.text(options.trimStart === null ? '' : formatTimestamp(options.trimStart), '0:00', (value) => {
          set('trimStart', value.trim() ? parseTimestamp(value) : null);
        });
        const end = this.text(options.trimEnd === null ? '' : formatTimestamp(options.trimEnd), duration ? formatDuration(duration) : 'end', (value) => {
          set('trimEnd', value.trim() ? parseTimestamp(value) : null);
        });
        return el('div', { class: 'control-group' }, [
          el('span', { class: 'control-label', text: 'Trim' }),
          el('div', { class: 'control-row' }, [
            el('label', { class: 'control-inline' }, [el('span', { text: 'From' }), start]),
            el('label', { class: 'control-inline' }, [el('span', { text: 'To' }), end]),
          ]),
          el('span', { class: 'control-hint', text: 'Leave either blank for the start or the end. Seconds, or m:ss.' }),
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

  async runQueue() {
    this.stopRequested = false;
    for (const job of this.jobs) {
      if (this.stopRequested) break;
      if (job.status !== 'ready' && job.status !== 'queued') continue;
      await this.runJob(job);
    }
  }

  async runJob(job) {
    if (!job.info || job.status === 'running') return;

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
    on(window, 'pagehide', () => prefs.flush());

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
        if (job) {
          // Reset here rather than only inside `runJob`: the run is queued
          // behind whatever else is using the engine, and until it starts the
          // row would otherwise still show the previous result's full bar.
          job.progress = 0;
          job.remaining = null;
          job.status = 'queued';
          this.paintQueue();
          this.enqueue(() => this.runJob(job));
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
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

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
    if (typing) return;

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
