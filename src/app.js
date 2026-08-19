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
import { createPersistentId } from './storage/ids.js';
import { createProjectStore, isQuotaExceededError } from './storage/projects.js';
import { createEngine, isolationStatus } from './ffmpeg/client.js';
import { createScrubber } from './ui/scrubber.js';
import { createCropper } from './ui/cropper.js';
import { createMergeSequence } from './ui/merge-sequence.js';
import { createAudioMixTimeline } from './ui/audio-mix-timeline.js';
import { supportsFormat } from './ffmpeg/capabilities.js';
import {
  buildJoinVideosPlan,
  buildAddAudioPlan,
  buildPlan,
  planToCommand,
  operationsFor,
  operationById,
  DEFAULT_OPTIONS,
} from './media/commands.js';
import {
  VIDEO_FORMATS, AUDIO_FORMATS, IMAGE_FORMATS,
  RESOLUTIONS, FRAME_RATES, QUALITIES, AUDIO_BITRATES, SPEED_PRESETS,
  AUDIO_ENCODERS, FLAC_COMPRESSION,
  formatById, audioFidelity, remuxTargets,
} from './media/formats.js';
import { createZip } from './media/zip.js';
import {
  CROP_ASPECT_PRESETS,
  LOOP_COUNT_PRESETS,
  PLAYBACK_RATE_PRESETS,
  VIDEO_LOOP_LIMITS,
  VOLUME_GAIN_LIMITS,
  VOLUME_GAIN_PRESETS,
  cropRectForAspect,
  defaultResizeResolution,
  defaultVideoLoopOptions,
  describeFocusedQuickTransformation,
  describeTrimRange,
  focusedQuickOutputDuration,
  focusedQuickPreflight,
  focusedQuickTool,
  fullCropRect,
  maxLoopCountFor,
  normalizePlaybackRate,
  normalizeFocusedQuickOptions,
  normalizeVolumeGain,
  playableMediaDuration,
  quickVideoFormat,
  supportsFocusedQuickTool,
  trimRange,
  trimOptionsForRun,
  visibleVideoDimensions,
} from './media/quick-tools.js';
import {
  MERGE_OPERATION,
  MERGE_MAX_CLIPS,
  MERGE_SAFE_BYTES,
  MERGE_TOOL_ID,
  createMergeClip,
  createMergeEditState,
  createMergeSnapshot,
  markMergeEdited,
  markMergeExported,
  mergeHasUnexportedChanges,
  mergeProjectInfo,
  mergeTotalBytes,
  mergeTotalDuration,
  reorderMergeClips,
  validateMergeClips,
} from './media/merge.js';
import {
  ADD_AUDIO_OPERATION,
  ADD_AUDIO_LIMITS,
  ADD_AUDIO_TOOL_ID,
  addAudioHasUnexportedChanges,
  addAudioPreflight,
  addAudioProjectSource,
  addAudioTotalBytes,
  addAudioVideoTimelineStart,
  createAddAudioAsset,
  createAddAudioEditState,
  createAddAudioSnapshot,
  markAddAudioEdited,
  markAddAudioExported,
  normalizeAddAudioOptions,
  validateAddAudioProject,
} from './media/add-audio.js';
import { audioTrackDuration, videoTrackDuration } from './media/probe.js';

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
const READ_ONLY_STORAGE_ISSUES = new Set([
  'newer-schema',
  'unsupported-schema',
  'invalid-record',
  'invalid-project-kind',
  'missing-asset-record',
]);

const assetBasename = (name) => String(name || '').split(/[\\/]/).pop();

const STATUS_LABELS = {
  probing: 'Reading',
  ready: 'Ready',
  queued: 'Queued',
  running: 'Converting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export class App {
  constructor() {
    this.engine = createEngine();
    this.projectStore = createProjectStore();

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
    this.cropper = null;
    this.mergeSourcePreview = null;
    this.mergeSequence = null;
    this.audioMixPreview = null;
    this.audioMixTimeline = null;
    this.pickerIntent = null;
    this.nextPickerToken = 1;

    // Project persistence is deliberately independent from the FFmpeg queue.
    // IndexedDB writes are serialised here so an older, slower Blob commit can
    // never land after a newer edit or resurrect a project that was removed.
    this.projectsHydrated = false;
    this.projectSaveTimer = null;
    this.projectSaveDeadline = null;
    this.projectSaveRevision = 0;
    this.projectDeleteRevision = 0;
    this.projectSaveChain = Promise.resolve();
    this.projectStorageRevision = null;
    this.projectStorageState = 'saving';
    this.projectStorageIssue = null;
    this.projectStorageUnavailable = false;
    this.projectStorageReadOnly = false;
    this.projectExternalChange = false;
    this.ignoreProjectBroadcast = false;
    this.unsubscribeProjectStore = null;

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
      statusStorage: $('#status-storage'),
      engineNote: $('#engine-note'),
      dropOverlay: $('#drop-overlay'),
      fileInput: $('#file-input'),
      settings: $('#settings-sheet'),
      confirmSheet: $('#confirm-sheet'),
      toasts: $('#toasts'),
      startAll: $('[data-action="start-all"]'),
      downloadAll: $('[data-action="download-all"]'),
    };

    this.paintQueue = raf(() => {
      this.renderQueue();
      this.scheduleProjectSave();
    });
    this.paintDetail = raf(() => {
      this.renderDetail();
      this.scheduleProjectSave();
    });
    this.scheduleCommandPreview = debounce(() => this.renderCommand(), 120);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async start() {
    this.applyPreferences(Object.keys(prefs.all()));
    prefs.subscribe((_, changed) => {
      this.applyPreferences(changed);
      if (changed.includes('persistProjects')) this.onProjectPersistencePreference();
    });

    this.setProjectStorageState('saving', 'Recuperando proyectos…');
    this.renderQueue();
    this.updateOfflineBadge();

    await this.restoreLocalProjects();
    // File and tool intents are bound only after hydration. Otherwise a fast
    // click during the IndexedDB read could create an in-memory job which the
    // restored workspace would replace a moment later.
    this.bindGlobalEvents();
    this.bindDropZone();
    this.bindSettings();
    this.bindConfirmSheet();
    this.bindResizers();
    this.renderQueue();
    this.renderDetail();

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
   * Local projects
   * ------------------------------------------------------------------ */

  projectPersistenceEnabled() {
    return Boolean(prefs.get('persistProjects'));
  }

  setProjectStorageState(state, message) {
    this.projectStorageState = state;
    const badge = this.dom?.statusStorage;
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = message || {
      saving: 'Guardando proyectos…',
      saved: 'Proyectos guardados',
      error: 'Guardado local incompleto',
      off: 'Guardado local desactivado',
    }[state] || '';
  }

  /**
   * Produce a cheap signature of durable state. Paints happen for every
   * FFmpeg progress frame; filtering runtime-only values here prevents those
   * frames from turning into hundreds of IndexedDB transactions.
   */
  projectStateSignature() {
    const runtimeKeys = new Set([
      'progress', 'speed', 'remaining', 'log',
      'pendingMergeSnapshot', 'pendingAddAudioSnapshot',
      'pendingQuickFocus', 'pendingQuickTab', 'pendingMergeFocus',
      'pendingAddAudioFocus', 'cropPreviewUnavailable',
    ]);
    const seenBlobs = new WeakMap();
    let nextBlob = 1;
    return JSON.stringify({ selectedId: this.selectedId, jobs: this.jobs }, (key, value) => {
      if (runtimeKeys.has(key)) return undefined;
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        if (!seenBlobs.has(value)) seenBlobs.set(value, nextBlob++);
        return {
          $blob: seenBlobs.get(value),
          name: typeof File !== 'undefined' && value instanceof File ? value.name : undefined,
          size: value.size,
          type: value.type,
          lastModified: typeof File !== 'undefined' && value instanceof File ? value.lastModified : undefined,
        };
      }
      return value;
    });
  }

  clearProjectSaveTimers() {
    if (this.projectSaveTimer) clearTimeout(this.projectSaveTimer);
    if (this.projectSaveDeadline) clearTimeout(this.projectSaveDeadline);
    this.projectSaveTimer = null;
    this.projectSaveDeadline = null;
  }

  scheduleProjectSave({ immediate = false, force = false } = {}) {
    if (
      !this.projectsHydrated
      || this.projectExternalChange
      || this.projectStorageUnavailable
      || this.projectStorageReadOnly
      || !prefs.get('persistProjects')
    ) return;

    let signature;
    try {
      signature = this.projectStateSignature();
    } catch {
      // A malformed third-party File implementation must not break the app.
      signature = null;
    }
    if (!force && signature !== null && signature === this.lastScheduledProjectSignature) {
      // `pagehide` promotes the last debounced edit to an immediate commit.
      // The signature is intentionally identical here; returning without
      // clearing the timer would let navigation kill the only pending save.
      if (immediate && (this.projectSaveTimer || this.projectSaveDeadline)) {
        this.clearProjectSaveTimers();
        this.setProjectStorageState('saving');
        this.commitProjectSave(this.projectSaveRevision);
      }
      return;
    }
    this.lastScheduledProjectSignature = signature;
    this.projectSaveRevision += 1;
    this.setProjectStorageState('saving');

    if (immediate) {
      this.clearProjectSaveTimers();
      this.commitProjectSave(this.projectSaveRevision);
      return;
    }

    if (this.projectSaveTimer) clearTimeout(this.projectSaveTimer);
    this.projectSaveTimer = setTimeout(() => {
      this.clearProjectSaveTimers();
      this.commitProjectSave(this.projectSaveRevision);
    }, 450);
    if (!this.projectSaveDeadline) {
      this.projectSaveDeadline = setTimeout(() => {
        this.clearProjectSaveTimers();
        this.commitProjectSave(this.projectSaveRevision);
      }, 1500);
    }
  }

  commitProjectSave(requestRevision = this.projectSaveRevision) {
    if (
      !this.projectsHydrated
      || this.projectStorageUnavailable
      || this.projectStorageReadOnly
      || !prefs.get('persistProjects')
    ) return this.projectSaveChain;

    this.projectSaveChain = this.projectSaveChain
      .catch(() => {})
      .then(async () => {
        if (!prefs.get('persistProjects') || this.projectExternalChange) return null;
        const result = await this.projectStore.saveWorkspace(this.jobs, {
          selectedId: this.selectedId,
          expectedStorageRevision: this.projectStorageRevision,
          allowMetadataFallback: true,
        });
        if (Number.isInteger(result?.storageRevision)) {
          this.projectStorageRevision = result.storageRevision;
        }
        this.projectStorageIssue = result?.issues?.length ? result.issues : null;
        const issueCodes = new Set((result?.issues || []).map((issue) => issue.code));
        const previousOutputPreserved = issueCodes.has('quota-last-output-preserved');
        if (!prefs.get('persistProjects')) {
          this.setProjectStorageState('off');
          return result;
        }
        if (requestRevision === this.projectSaveRevision) {
          this.setProjectStorageState(
            result?.metadataOnly ? 'error' : 'saved',
            result?.metadataOnly
              ? (previousOutputPreserved ? 'Resultado nuevo sólo en esta sesión' : 'Proyecto guardado · faltan archivos')
              : 'Proyectos guardados',
          );
        }
        if (result?.metadataOnly) {
          this.toast(previousOutputPreserved
            ? 'No había espacio para guardar el resultado nuevo. El anterior sigue protegido; descargá el nuevo antes de cerrar.'
            : 'Guardamos la edición, pero no había espacio para copiar todos los archivos. Al volver vas a poder reconectarlos.', {
            kind: 'error', duration: 9000,
          });
        }
        return result;
      })
      .catch((error) => {
        this.lastScheduledProjectSignature = null;
        this.projectStorageIssue = error;
        if (error?.code === 'conflict') {
          this.projectExternalChange = true;
          this.clearProjectSaveTimers();
          this.setProjectStorageState('error', 'Cambios abiertos en otro tab');
          this.toast('Otro tab guardó cambios primero. Recargá esta página para no sobrescribirlos.', {
            kind: 'error', duration: 9000,
          });
          return null;
        }
        if (error?.code === 'storage-unavailable') this.projectStorageUnavailable = true;
        const quota = isQuotaExceededError(error);
        this.setProjectStorageState('error', quota ? 'Sin espacio para guardar archivos' : 'Guardado local no disponible');
        this.toast(
          quota
            ? 'El navegador no tiene espacio suficiente. El proyecto sigue abierto, pero descargá el resultado antes de cerrar.'
            : `No pudimos guardar el proyecto localmente: ${error.message}`,
          { kind: 'error', duration: 9000 },
        );
        return null;
      });
    return this.projectSaveChain;
  }

  subscribeToProjectStore() {
    if (this.unsubscribeProjectStore) return;
    this.unsubscribeProjectStore = this.projectStore.subscribe?.((event) => {
      if (!this.projectsHydrated || this.ignoreProjectBroadcast || event?.local) return;
      this.projectExternalChange = true;
      this.clearProjectSaveTimers();
      this.setProjectStorageState('error', 'Cambios abiertos en otro tab');
      this.toast('Otro tab actualizó los proyectos locales. Recargá esta página antes de seguir editando.', {
        duration: 8000,
      });
    }) || null;
  }

  async restoreLocalProjects() {
    try {
      await this.projectStore.open();
      this.subscribeToProjectStore();

      const restored = await this.projectStore.loadWorkspace();
      this.jobs = Array.isArray(restored?.jobs) ? restored.jobs : [];
      this.selectedId = this.jobs.some((job) => job.id === restored?.selectedId)
        ? restored.selectedId
        : (this.jobs[0]?.id || null);
      if (Number.isInteger(restored?.storageRevision)) {
        this.projectStorageRevision = restored.storageRevision;
      }
      this.projectsHydrated = true;
      this.projectStorageUnavailable = false;
      const blockingIssues = (restored?.issues || [])
        .filter((issue) => READ_ONLY_STORAGE_ISSUES.has(issue.code));
      this.projectStorageReadOnly = blockingIssues.length > 0;
      this.lastScheduledProjectSignature = this.projectStateSignature();

      const needsRelink = this.jobs.filter((job) => job.needsRelink).length;
      const issueCount = Array.isArray(restored?.issues) ? restored.issues.length : 0;
      if (this.projectStorageReadOnly) {
        this.setProjectStorageState('error', 'Proyectos locales en modo protegido');
        this.toast('Encontramos datos locales de otra versión o incompletos. No los modificaremos; actualizá MediaForge o borrá el almacenamiento local desde Configuración.', {
          kind: 'error', duration: 10000,
        });
      } else if (!prefs.get('persistProjects')) {
        this.setProjectStorageState('off');
      } else if (needsRelink || issueCount) {
        this.setProjectStorageState('error', `${needsRelink || issueCount} proyecto${(needsRelink || issueCount) === 1 ? '' : 's'} para revisar`);
      } else {
        this.setProjectStorageState('saved', this.jobs.length ? `${this.jobs.length} proyecto${this.jobs.length === 1 ? '' : 's'} recuperado${this.jobs.length === 1 ? '' : 's'}` : 'Proyectos guardados');
      }

      for (const job of this.jobs) this.resumeRestoredProject(job);
      if (this.jobs.length) {
        this.toast(`${this.jobs.length} proyecto${this.jobs.length === 1 ? '' : 's'} recuperado${this.jobs.length === 1 ? '' : 's'} en este navegador.`, {
          duration: 4500,
        });
      }
    } catch (error) {
      this.projectsHydrated = true;
      this.projectStorageIssue = error;
      this.projectStorageUnavailable = error?.code === 'storage-unavailable';
      this.setProjectStorageState(
        prefs.get('persistProjects') ? 'error' : 'off',
        prefs.get('persistProjects') ? 'Guardado local no disponible' : undefined,
      );
      // Persistence is an enhancement: conversion must remain fully usable in
      // private/restricted contexts where IndexedDB cannot be opened.
      if (prefs.get('persistProjects')) {
        this.toast(`Los proyectos funcionarán sólo durante esta sesión: ${error.message}`, {
          kind: 'error', duration: 8500,
        });
      }
    }
  }

  async retryProjectPersistence() {
    if (!prefs.get('persistProjects')) return;
    this.setProjectStorageState('saving', 'Reintentando almacenamiento local…');
    try {
      await this.projectStore.open();
      this.subscribeToProjectStore();
      const restored = await this.projectStore.loadWorkspace();
      if (!Number.isInteger(restored?.storageRevision)) {
        const error = new Error('No pudimos verificar la versión de los proyectos guardados.');
        error.code = 'storage-unavailable';
        throw error;
      }
      if (!prefs.get('persistProjects')) {
        this.setProjectStorageState('off');
        return;
      }

      // A failed initial open means the current jobs are session-only. Adopt
      // the durable revision first, then merge both sets before writing; a
      // blind save with expectedRevision=null could otherwise erase projects
      // that were already in IndexedDB when the transient failure occurred.
      const liveIds = new Set(this.jobs.map((job) => job.id));
      const recovered = (restored.jobs || []).filter((job) => !liveIds.has(job.id));
      this.jobs.push(...recovered);
      if (!this.selectedId || !this.jobs.some((job) => job.id === this.selectedId)) {
        this.selectedId = this.jobs.some((job) => job.id === restored.selectedId)
          ? restored.selectedId
          : (this.jobs[0]?.id || null);
      }
      this.projectStorageRevision = restored.storageRevision;
      this.projectStorageUnavailable = false;
      this.projectStorageIssue = restored.issues?.length ? restored.issues : null;
      this.projectStorageReadOnly = (restored.issues || [])
        .some((issue) => READ_ONLY_STORAGE_ISSUES.has(issue.code));
      for (const job of recovered) this.resumeRestoredProject(job);
      this.lastScheduledProjectSignature = null;
      this.paintQueue();
      this.paintDetail();
      if (this.projectStorageReadOnly) {
        this.setProjectStorageState('error', 'Proyectos locales en modo protegido');
        this.toast('El almacenamiento contiene proyectos de otra versión o incompletos. No los sobrescribimos.', {
          kind: 'error', duration: 9000,
        });
        return;
      }
      this.scheduleProjectSave({ immediate: true, force: true });
      await this.projectSaveChain;
      if (recovered.length) {
        this.toast(`Recuperamos ${recovered.length} proyecto${recovered.length === 1 ? '' : 's'} guardado${recovered.length === 1 ? '' : 's'} antes de reactivar las copias.`);
      }
    } catch (error) {
      this.projectStorageUnavailable = true;
      this.projectStorageIssue = error;
      this.setProjectStorageState('error', 'Guardado local no disponible');
      this.toast(`El guardado seguirá sólo en esta sesión: ${error.message}`, {
        kind: 'error', duration: 8500,
      });
    }
  }

  resumeRestoredProject(job) {
    if (!job || job.needsRelink) return;
    if (job.outputs?.length) job.previewMode = 'result';
    if (this.isMergeJob(job)) {
      this.syncMergeProject(job);
      const pending = job.clips.filter((clip) => clip.file && !clip.info);
      if (pending.length) {
        job.status = 'probing';
        this.enqueue(() => this.probeMergeClips(job, pending));
      }
      return;
    }
    if (this.isAddAudioJob(job)) {
      this.syncAddAudioProject(job);
      for (const asset of [job.video, job.audio].filter(Boolean)) {
        if (asset.file && !asset.info) this.enqueue(() => this.probeAddAudioAsset(job, asset));
      }
      return;
    }
    if (job.file && !job.info) {
      job.status = 'probing';
      this.enqueue(() => this.probeJob(job));
      return;
    }
    if (job.outputs?.length && focusedQuickTool(job.forgeToolId)) this.syncQuickDirty(job);
  }

  onProjectPersistencePreference() {
    if (!this.projectsHydrated) return;
    if (prefs.get('persistProjects')) {
      if (this.projectStorageReadOnly) {
        this.setProjectStorageState('error', 'Proyectos locales en modo protegido');
        this.syncStorageSettings();
        return;
      }
      if (this.projectStorageUnavailable || !Number.isInteger(this.projectStorageRevision)) {
        // Explicitly toggling persistence back on is the retry gesture for a
        // private/restricted context whose first IndexedDB open failed.
        return this.retryProjectPersistence();
      }
      this.scheduleProjectSave({ immediate: true, force: true });
    } else {
      this.clearProjectSaveTimers();
      this.setProjectStorageState('off');
    }
    this.syncStorageSettings();
  }

  async syncStorageSettings() {
    const summary = $('#settings-storage-summary');
    const quota = $('#settings-storage-quota');
    const persistence = $('#settings-storage-persistence');
    if (!summary || !quota || !persistence) return;

    summary.textContent = prefs.get('persistProjects')
      ? (this.projectStorageState === 'error' ? 'El guardado local necesita atención.' : 'El guardado automático está activo.')
      : 'El guardado automático está desactivado.';
    try {
      const estimate = await this.projectStore.estimate();
      quota.textContent = Number.isFinite(estimate?.usage) && Number.isFinite(estimate?.quota)
        ? `${formatBytes(estimate.usage)} usados de aproximadamente ${formatBytes(estimate.quota)} disponibles para este origen.`
        : 'El navegador no informa cuánto espacio local queda disponible.';
      persistence.textContent = estimate?.persisted
        ? 'El navegador confirmó que conservará estos datos salvo que los borres.'
        : 'El navegador puede liberar estos datos si necesita espacio; podés solicitar protección.';
    } catch (error) {
      quota.textContent = 'No pudimos consultar el espacio local disponible.';
      persistence.textContent = error.message;
    }
  }

  async requestPersistentProjectStorage() {
    try {
      const result = await this.projectStore.requestPersistence();
      this.toast(result?.persisted
        ? 'El navegador confirmó la protección de los proyectos locales.'
        : 'El navegador no concedió protección permanente; el guardado local sigue funcionando.');
    } catch (error) {
      this.toast(`No pudimos solicitar protección: ${error.message}`, { kind: 'error' });
    }
    this.syncStorageSettings();
  }

  async clearLocalProjects() {
    const sure = await this.confirm({
      title: '¿Borrar todos los proyectos locales?',
      message: 'Se quitarán la cola, los archivos copiados y los resultados guardados en este navegador. Los archivos originales no se modifican.',
      confirmLabel: 'Borrar proyectos',
      danger: true,
    });
    if (!sure) return;
    if (this.runningId) this.cancelRunning();
    this.releaseQuickSourcePreview();
    this.releaseQuickOutputPreview();
    this.releasePreview();
    this.releaseScrubber();
    this.releaseCropper();
    this.releaseMergeSourcePreview();
    this.releaseMergeSequence();
    this.releaseAudioMixPreview();
    this.releaseAudioMixTimeline();
    this.clearPickerIntent();
    this.jobs = [];
    this.selectedId = null;
    this.clearProjectSaveTimers();
    this.setProjectStorageState('saving', 'Borrando proyectos…');
    try {
      // A large Blob transaction may still be in flight when the user opens
      // Settings and chooses “Borrar todo”. Queue the clear behind it so the
      // same tab cannot race its own revision and leave the just-saved bytes
      // behind after the UI has already emptied the workspace.
      const clearing = this.projectSaveChain
        .catch(() => {})
        .then(() => this.projectStore.clear({
          expectedStorageRevision: this.projectStorageRevision,
        }));
      this.projectSaveChain = clearing.catch(() => {});
      const result = await clearing;
      this.projectExternalChange = false;
      this.projectStorageReadOnly = false;
      this.projectStorageUnavailable = false;
      this.projectStorageIssue = null;
      this.projectStorageRevision = Number.isInteger(result?.storageRevision)
        ? result.storageRevision
        : this.projectStorageRevision;
      this.lastScheduledProjectSignature = this.projectStateSignature();
      this.setProjectStorageState(prefs.get('persistProjects') ? 'saved' : 'off', prefs.get('persistProjects') ? 'Sin proyectos guardados' : undefined);
      this.toast('Borramos todos los proyectos locales.');
    } catch (error) {
      this.projectStorageIssue = error;
      if (error?.code === 'conflict') this.projectExternalChange = true;
      this.setProjectStorageState('error');
      this.toast(
        error?.code === 'conflict'
          ? 'Otro tab cambió los proyectos antes del borrado. No eliminamos sus datos; recargá para revisar el estado actual.'
          : `No pudimos borrar el almacenamiento local: ${error.message}`,
        { kind: 'error' },
      );
    }
    this.paintQueue();
    this.paintDetail();
    this.syncStorageSettings();
  }

  deletePersistedProject(projectId) {
    if (!this.projectsHydrated || this.projectStorageReadOnly || !projectId) return this.projectSaveChain;
    const deleteRevision = ++this.projectDeleteRevision;
    this.setProjectStorageState('saving', 'Borrando proyecto…');
    this.projectSaveChain = this.projectSaveChain
      .catch(() => {})
      .then(async () => {
        const result = await this.projectStore.deleteProject(projectId, {
          expectedStorageRevision: this.projectStorageRevision,
        });
        if (Number.isInteger(result?.storageRevision)) this.projectStorageRevision = result.storageRevision;
        if (deleteRevision === this.projectDeleteRevision && prefs.get('persistProjects')) {
          this.setProjectStorageState('saved', this.jobs.length ? 'Proyectos guardados' : 'Sin proyectos guardados');
        }
        return result;
      })
      .catch((error) => {
        this.projectStorageIssue = error;
        if (error?.code === 'conflict') {
          this.projectExternalChange = true;
          this.clearProjectSaveTimers();
          this.setProjectStorageState('error', 'Cambios abiertos en otro tab');
          this.toast('Otro tab cambió estos proyectos. Recargá antes de volver a borrar o editar.', {
            kind: 'error', duration: 8000,
          });
        } else {
          this.setProjectStorageState('error');
        }
        return null;
      });
    return this.projectSaveChain;
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
        files.push(path ? new File([file], `${path}/${file.name}`, {
          type: file.type,
          lastModified: file.lastModified,
        }) : file);
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

  setPickerIntent(intent) {
    this.pickerIntent = {
      ...intent,
      token: this.nextPickerToken++,
    };
    return this.pickerIntent;
  }

  clearPickerIntent() {
    this.pickerIntent = null;
  }

  consumePickerIntent() {
    const intent = this.pickerIntent;
    this.pickerIntent = null;
    return intent;
  }

  addFiles(files, { forceNewJobs = false } = {}) {
    if (forceNewJobs) this.clearPickerIntent();
    const pickerIntent = forceNewJobs ? null : this.consumePickerIntent();
    if (pickerIntent?.kind === 'merge-append') {
      const mergeTarget = this.jobs.find((job) => job.id === pickerIntent.projectId);
      if (this.isMergeJob(mergeTarget)) this.appendMergeFiles(mergeTarget, files);
      else this.toast('Ese proyecto ya no está disponible.', { kind: 'error' });
      return;
    }
    if (pickerIntent?.kind === 'add-audio-asset') {
      const project = this.jobs.find((job) => job.id === pickerIntent.projectId);
      if (files.length > 1) this.toast('Este proyecto usa una sola fuente por pista; agregamos únicamente el primer archivo.');
      if (this.isAddAudioJob(project)) this.replaceAddAudioAsset(project, pickerIntent.role, files[0]);
      else this.toast('Ese proyecto ya no está disponible.', { kind: 'error' });
      return;
    }
    if (pickerIntent?.kind === 'project-relink') {
      const project = this.jobs.find((job) => job.id === pickerIntent.projectId);
      if (project) this.relinkProject(project, files);
      else this.toast('Ese proyecto ya no está disponible.', { kind: 'error' });
      return;
    }

    const accepted = [];
    const refused = [];

    for (const file of files) {
      if (!file.size) continue;
      if (file.size > REFUSE_BYTES) {
        refused.push(file);
        continue;
      }
      const job = {
        id: createPersistentId('job'),
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
    // A source File is irreplaceable without another user gesture. Start its
    // IndexedDB transaction now instead of leaving a refresh-sized debounce
    // window in which only the in-memory job exists.
    this.scheduleProjectSave({ immediate: true, force: true });

    for (const job of accepted) this.enqueue(() => this.probeJob(job));
    // Focused tools need one explicit choice/confirmation. Auto-start remains
    // useful for the generic converter, but must not rotate or resize a file
    // merely because it has just finished probing.
    if (prefs.get('autoStart')) this.enqueue(() => this.runQueue({ skipFocused: true }));
  }

  isMergeJob(job) {
    return Boolean(job && Array.isArray(job.clips) && job.operation === MERGE_OPERATION);
  }

  isAddAudioJob(job) {
    return Boolean(
      job
      && job.kind === 'video-add-audio'
      && job.operation === ADD_AUDIO_OPERATION
      && job.video?.role === 'video'
    );
  }

  missingProjectAssets(job) {
    if (!job) return [];
    if (this.isMergeJob(job)) {
      return job.clips
        .filter((clip) => !clip.file)
        .map((clip) => ({ owner: clip, role: 'clip', id: clip.id, name: clip.name, size: clip.size, lastModified: clip.lastModified }));
    }
    if (this.isAddAudioJob(job)) {
      return [job.video, job.audio]
        .filter((asset) => asset && !asset.file)
        .map((asset) => ({ owner: asset, role: asset.role, id: asset.id, name: asset.name, size: asset.size, lastModified: asset.lastModified }));
    }
    // Some queue/domain tests and embedders use minimal status-only records.
    // Absence of a `file` field is not itself a persisted relink marker; a
    // hydrated metadata-only project has the field explicitly set to null.
    if (!Object.prototype.hasOwnProperty.call(job, 'file')) return [];
    return job.file ? [] : [{ owner: job, role: 'source', id: job.id, name: job.name, size: job.size, lastModified: job.lastModified }];
  }

  openRelinkPicker(job) {
    const missing = this.missingProjectAssets(job);
    if (!missing.length) return;
    this.setPickerIntent({ kind: 'project-relink', projectId: job.id });
    this.dom.fileInput.accept = this.isAddAudioJob(job)
      ? 'video/*,audio/*'
      : (job.info?.hasAudio && !job.info?.hasVideo ? 'audio/*' : 'video/*,audio/*');
    this.dom.fileInput.multiple = missing.length > 1;
    this.dom.fileInput.click();
  }

  relinkProject(job, files) {
    const missing = this.missingProjectAssets(job);
    const remaining = [...missing];
    const matches = [];
    for (const file of Array.from(files || [])) {
      let index = remaining.findIndex((asset) => (
        asset.name === file.name
        && Number(asset.size) === Number(file.size)
        && (!asset.lastModified || Number(asset.lastModified) === Number(file.lastModified))
      ));
      if (index < 0) {
        index = remaining.findIndex((asset) => (
          assetBasename(asset.name) === assetBasename(file.name)
          && Number(asset.size) === Number(file.size)
          && (!asset.lastModified || Number(asset.lastModified) === Number(file.lastModified))
        ));
      }
      if (index < 0) {
        index = remaining.findIndex((asset) => (
          assetBasename(asset.name) === assetBasename(file.name)
          && Number(asset.size) === Number(file.size)
        ));
      }
      if (index < 0) {
        index = remaining.findIndex((asset) => (
          Number(asset.size) === Number(file.size)
          && asset.lastModified
          && Number(asset.lastModified) === Number(file.lastModified)
        ));
      }
      if (index < 0) continue;
      matches.push([remaining.splice(index, 1)[0], file]);
    }

    if (!matches.length) {
      this.toast('El archivo no coincide con ninguna fuente pendiente. Revisá el nombre y el tamaño.', {
        kind: 'error', duration: 7500,
      });
      return;
    }

    if (this.isMergeJob(job)) {
      const pending = [];
      for (const [missingAsset, file] of matches) {
        const clip = missingAsset.owner;
        clip.file = file;
        clip.name = file.name;
        clip.size = file.size;
        clip.lastModified = file.lastModified;
        clip.info = null;
        clip.status = 'pending';
        clip.error = null;
        delete clip.needsRelink;
        pending.push(clip);
      }
      job.needsRelink = this.missingProjectAssets(job).length > 0;
      this.syncMergeProject(job);
      if (pending.length) this.enqueue(() => this.probeMergeClips(job, pending));
    } else if (this.isAddAudioJob(job)) {
      for (const [missingAsset, file] of matches) {
        const asset = missingAsset.owner;
        asset.file = file;
        asset.name = file.name;
        asset.size = file.size;
        asset.lastModified = file.lastModified;
        asset.info = null;
        asset.status = 'pending';
        asset.error = null;
        delete asset.needsRelink;
        this.enqueue(() => this.probeAddAudioAsset(job, asset));
      }
      job.needsRelink = this.missingProjectAssets(job).length > 0;
      this.syncAddAudioProject(job);
    } else {
      const file = matches[0][1];
      job.file = file;
      job.name = file.name;
      job.size = file.size;
      job.lastModified = file.lastModified;
      job.info = null;
      job.status = 'probing';
      job.error = null;
      delete job.needsRelink;
      this.enqueue(() => this.probeJob(job));
    }

    this.scheduleProjectSave({ immediate: true, force: true });
    this.paintQueue();
    this.paintDetail();
    if (remaining.length) {
      this.toast(`Reconectamos ${matches.length}; todavía faltan ${remaining.length} fuente${remaining.length === 1 ? '' : 's'}.`);
    } else {
      this.toast('Fuentes reconectadas. Estamos verificándolas antes de continuar.');
    }
  }

  mergeFilesWithinLimits(files, job = null) {
    const accepted = [];
    let count = job?.clips?.length || 0;
    let bytes = job ? mergeTotalBytes(job.clips) : 0;
    let refusedCount = 0;
    let refusedBytes = 0;

    for (const file of Array.from(files || [])) {
      if (!file?.size) continue;
      if (count >= MERGE_MAX_CLIPS) {
        refusedCount += 1;
        continue;
      }
      if (bytes + file.size > MERGE_SAFE_BYTES) {
        refusedBytes += 1;
        continue;
      }
      accepted.push(file);
      count += 1;
      bytes += file.size;
    }

    if (refusedCount) {
      this.toast(`Podés unir hasta ${MERGE_MAX_CLIPS} videos por proyecto. Los demás no se agregaron.`, {
        kind: 'error', duration: 7500,
      });
    }
    if (refusedBytes) {
      this.toast(`El proyecto puede usar hasta ${formatBytes(MERGE_SAFE_BYTES)} en total. Los archivos que superaban ese límite no se agregaron.`, {
        kind: 'error', duration: 8500,
      });
    }
    return accepted;
  }

  addMergeProject(files, toolId = MERGE_TOOL_ID) {
    const clips = this.mergeFilesWithinLimits(files)
      .map((file) => createMergeClip(file));
    if (!clips.length) return null;

    const editState = createMergeEditState();
    const job = {
      id: createPersistentId('job'),
      kind: 'video-merge',
      forgeToolId: toolId,
      clips,
      selectedClipId: clips[0].id,
      file: clips[0].file,
      name: 'Videos unidos',
      size: mergeTotalBytes(clips),
      info: mergeProjectInfo(clips),
      status: 'probing',
      operation: MERGE_OPERATION,
      options: {
        ...DEFAULT_OPTIONS,
        format: 'mp4-h264',
        resolution: 'source',
        fps: 'source',
        quality: 'balanced',
        speed: 'veryfast',
        mute: false,
        mergeFit: 'contain',
      },
      progress: 0,
      speed: null,
      remaining: null,
      outputs: null,
      error: null,
      validationError: null,
      log: [],
      previewMode: 'source',
      ...editState,
    };
    this.jobs.push(job);
    this.selectedId = job.id;
    this.syncMergeProject(job);
    this.paintQueue();
    this.paintDetail();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.enqueue(() => this.probeMergeClips(job, clips));
    return job;
  }

  appendMergeFiles(job, files) {
    if (!this.isMergeJob(job) || ['queued', 'running'].includes(job.status)) {
      if (this.isMergeJob(job)) this.toast('Esperá a que termine la unión antes de agregar más videos.');
      return [];
    }
    const added = this.mergeFilesWithinLimits(files, job)
      .map((file) => createMergeClip(file));
    if (!added.length) return [];

    job.clips.push(...added);
    job.selectedClipId = added[0].id;
    Object.assign(job, markMergeEdited(job));
    job.previewMode = 'source';
    this.syncMergeProject(job);
    this.paintQueue();
    this.paintDetail();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.enqueue(() => this.probeMergeClips(job, added));
    return added;
  }

  syncMergeProject(job) {
    if (!this.isMergeJob(job)) return;
    job.size = mergeTotalBytes(job.clips);
    job.info = mergeProjectInfo(job.clips);
    job.file = job.clips[0]?.file || null;
    job.name = job.clips.length === 1 ? 'Unir 1 video' : `Unir ${job.clips.length} videos`;
    job.dirtySinceOutput = mergeHasUnexportedChanges(job);
    const validation = validateMergeClips(job.clips);
    job.validationError = validation.error;

    if (!['queued', 'running'].includes(job.status)) {
      const waiting = job.clips.some((clip) => clip.status === 'pending' || clip.status === 'probing');
      job.status = waiting
        ? 'probing'
        : (job.outputs?.length ? 'done' : 'ready');
    }
  }

  async probeMergeClips(job, clips) {
    if (!this.jobs.includes(job)) return;
    for (const clip of clips) {
      if (!this.jobs.includes(job) || !job.clips.includes(clip)) continue;
      clip.status = 'probing';
      this.syncMergeProject(job);
      this.paintQueue();
      if (job.id === this.selectedId) this.paintDetail();
      try {
        clip.info = await this.engine.probe(clip.file);
        if (!clip.info?.hasVideo) {
          clip.status = 'failed';
          clip.error = 'El archivo no contiene una pista de video.';
        } else if (!Number.isFinite(clip.info.duration) || clip.info.duration <= 0) {
          clip.status = 'failed';
          clip.error = 'No pudimos determinar una duración utilizable.';
        } else {
          clip.status = 'ready';
          clip.error = null;
        }
      } catch (error) {
        clip.status = 'failed';
        clip.error = error.message;
      }
      this.syncMergeProject(job);
      this.paintQueue();
      if (job.id === this.selectedId) this.paintDetail();
    }
  }

  addAudioProject(videoFile, toolId = ADD_AUDIO_TOOL_ID) {
    if (!videoFile?.size) return null;
    const estimatedWorkingBytes = videoFile.size * 2;
    if (
      videoFile.size > ADD_AUDIO_LIMITS.maxInputBytes
      || estimatedWorkingBytes > ADD_AUDIO_LIMITS.maxWorkingBytes
    ) {
      this.toast(
        `Ese video necesita más de ${formatBytes(ADD_AUDIO_LIMITS.maxWorkingBytes)} de memoria de trabajo. Elegí uno más liviano.`,
        { kind: 'error', duration: 8500 },
      );
      return null;
    }

    const video = createAddAudioAsset(videoFile, 'video');
    const job = {
      id: createPersistentId('job'),
      kind: 'video-add-audio',
      forgeToolId: toolId,
      operation: ADD_AUDIO_OPERATION,
      video,
      audio: null,
      file: videoFile,
      name: videoFile.name,
      size: videoFile.size,
      info: null,
      status: 'probing',
      options: {
        ...DEFAULT_OPTIONS,
        format: 'mp4-h264',
        resolution: 'source',
        fps: 'source',
        quality: 'balanced',
        speed: 'veryfast',
        mute: false,
      },
      progress: 0,
      speed: null,
      remaining: null,
      outputs: null,
      error: null,
      validationError: null,
      log: [],
      previewMode: 'source',
      addAudioTouchedOptions: {},
      ...createAddAudioEditState(),
    };
    this.jobs.push(job);
    this.selectedId = job.id;
    this.syncAddAudioProject(job);
    this.paintQueue();
    this.paintDetail();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.enqueue(() => this.probeAddAudioAsset(job, video));
    return job;
  }

  addAudioFilesWithinLimits(job, role, file) {
    if (!file?.size) return false;
    const candidate = {
      ...job,
      [role]: { file, size: file.size, info: null },
    };
    const preflight = addAudioPreflight(candidate, candidate.options);
    const exceedsMemory = preflight.inputBytes > ADD_AUDIO_LIMITS.maxInputBytes
      || preflight.estimatedWorkingBytes > ADD_AUDIO_LIMITS.maxWorkingBytes;
    if (exceedsMemory || (!preflight.ok && preflight.code !== 'missing-files')) {
      this.toast(
        exceedsMemory
          ? `Video, audio y resultado estimado superarían el límite seguro local de ${formatBytes(ADD_AUDIO_LIMITS.maxWorkingBytes)}.`
          : preflight.message,
        { kind: 'error', duration: 8500 },
      );
      return false;
    }
    return true;
  }

  replaceAddAudioAsset(job, role, file) {
    if (!this.isAddAudioJob(job) || !['video', 'audio'].includes(role)) return null;
    if (['queued', 'running'].includes(job.status)) {
      this.toast('Esperá a que termine el procesamiento antes de reemplazar una fuente.');
      return null;
    }
    if (!this.addAudioFilesWithinLimits(job, role, file)) return null;

    const asset = createAddAudioAsset(file, role);
    job[role] = asset;
    if (role === 'video') {
      job.file = file;
      job.name = file.name;
    }
    Object.assign(job, markAddAudioEdited(job));
    job.previewMode = 'source';
    if (this.audioMixPreview?.jobId === job.id) this.releaseAudioMixPreview();
    this.syncAddAudioProject(job);
    this.paintQueue();
    this.paintDetail();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.enqueue(() => this.probeAddAudioAsset(job, asset));
    return asset;
  }

  removeAddAudioTrack(job) {
    if (!this.isAddAudioJob(job) || ['queued', 'running'].includes(job.status) || !job.audio) return;
    job.audio = null;
    Object.assign(job, markAddAudioEdited(job));
    job.previewMode = 'source';
    if (this.audioMixPreview?.jobId === job.id) this.releaseAudioMixPreview();
    this.syncAddAudioProject(job);
    this.scheduleCommandPreview();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  syncAddAudioProject(job) {
    if (!this.isAddAudioJob(job)) return;
    job.file = job.video?.file || null;
    job.name = job.video?.name || 'Video con audio';
    job.size = addAudioTotalBytes(job);
    job.info = job.video?.info || null;
    job.dirtySinceOutput = addAudioHasUnexportedChanges(job);
    const validation = validateAddAudioProject(job, job.options);
    job.validationError = validation.message;
    job.validationCode = validation.code;

    if (!['queued', 'running'].includes(job.status)) {
      const waiting = [job.video, job.audio].filter(Boolean)
        .some((asset) => asset.status === 'pending' || asset.status === 'probing');
      job.status = waiting
        ? 'probing'
        : (job.outputs?.length ? 'done' : 'ready');
    }
  }

  async probeAddAudioAsset(job, asset) {
    if (!this.jobs.includes(job) || job[asset.role] !== asset) return;
    asset.status = 'probing';
    asset.error = null;
    this.syncAddAudioProject(job);
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();

    try {
      const info = await this.engine.probe(asset.file);
      // Replacing or removing a source while its probe waited in the serial
      // queue makes this result obsolete. Never write it into the new asset.
      if (!this.jobs.includes(job) || job[asset.role] !== asset) return;
      asset.info = info;
      if (asset.role === 'video' && !info?.hasVideo) {
        asset.status = 'failed';
        asset.error = 'El archivo no contiene una pista de video.';
      } else if (asset.role === 'audio' && !info?.hasAudio) {
        asset.status = 'failed';
        asset.error = 'El archivo no contiene una pista de audio.';
      } else if (asset.role === 'video' && !videoTrackDuration(info)) {
        asset.status = 'failed';
        asset.error = 'No pudimos determinar la duración del video.';
      } else if (asset.role === 'audio' && !audioTrackDuration(info)) {
        asset.status = 'failed';
        asset.error = 'No pudimos determinar la duración del audio.';
      } else {
        asset.status = 'ready';
        asset.error = null;
        if (asset.role === 'video') {
          const choices = { ...job.options };
          // Dynamic defaults belong to the current primary video. Replacing a
          // video with a silent one should become full-volume replacement,
          // while an explicit gain or mode chosen by the user stays intact.
          for (const key of ['mixMode', 'addedGain']) {
            if (!job.addAudioTouchedOptions?.[key]) delete choices[key];
          }
          const normalised = normalizeAddAudioOptions(info, choices);
          if (normalised) Object.assign(job.options, normalised);
        }
      }
    } catch (error) {
      if (!this.jobs.includes(job) || job[asset.role] !== asset) return;
      asset.status = 'failed';
      asset.error = error.message;
    }

    this.syncAddAudioProject(job);
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  openAddAudioPicker(job, role = 'audio') {
    if (!this.isAddAudioJob(job) || !['video', 'audio'].includes(role)) return;
    if (['queued', 'running'].includes(job.status)) return;
    this.setPickerIntent({ kind: 'add-audio-asset', projectId: job.id, role });
    this.dom.fileInput.accept = role === 'video' ? 'video/*' : 'audio/*';
    this.dom.fileInput.multiple = false;
    this.dom.fileInput.click();
  }

  /** Serialise everything that uses the worker; it can only do one thing. */
  enqueue(task) {
    this.chain = this.chain.then(task).catch((error) => {
      if (!error?.cancelled) console.warn('[media-forge]', error);
    });
    return this.chain;
  }

  quickToolSupportMessage(tool, info) {
    if (tool?.focus === 'volume' && info?.hasVideo && !info?.hasAudio) {
      return 'Este video no tiene una pista de audio para ajustar. Abrimos el conversor general.';
    }
    if (tool?.focus === 'loop' && info?.hasVideo) {
      return 'No pudimos medir una duración segura para repetir este video. Abrimos el conversor general.';
    }
    return `${tool?.title || 'Esta herramienta'} necesita un archivo de video. Abrimos el conversor general para este archivo.`;
  }

  neutraliseFocusedQuickOptions(job) {
    Object.assign(job.options, {
      trimStart: null,
      trimEnd: null,
      rotate: 0,
      flip: 'none',
      cropAspect: 'free',
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
      evenDimensions: false,
      volumeGain: 1,
      playbackRate: 1,
      loopMode: 'count',
      loopCount: 1,
      loopDuration: null,
      mute: false,
    });
    job.validationError = null;
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
        this.neutraliseFocusedQuickOptions(job);
        job.forgeToolId = null;
        this.toast(this.quickToolSupportMessage(quickTool, job.info), {
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
      if (job.status === 'ready' && job.outputs?.length) {
        job.status = 'done';
        this.syncQuickDirty(job);
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.forgeToolId = null;
    }
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  async removeJob(job, { confirm = true } = {}) {
    if (!job) return;
    const isRunning = this.runningId === job.id;
    const hasSavedResult = Boolean(job.outputs?.length);
    const isDurableProject = Boolean(this.projectsHydrated && this.projectPersistenceEnabled());
    // Once projects are durable, removing a finished row also removes the
    // saved result Blob. Make that destructive boundary explicit; originals
    // selected from disk are never touched.
    if (confirm && (isRunning || hasSavedResult || isDurableProject)) {
      const sure = await this.confirm({
        title: isRunning
          ? '¿Detener y quitar el proyecto?'
          : (hasSavedResult ? '¿Quitar el proyecto y su resultado?' : '¿Quitar este proyecto?'),
        message: isRunning
          ? `${job.name} lleva ${Math.round(job.progress * 100)}% procesado. Se perderán ese avance${hasSavedResult ? ' y el resultado anterior guardado' : ''}.`
          : (hasSavedResult
            ? 'Se borrarán de este navegador el proyecto y su resultado guardado. El archivo original no se modifica.'
            : 'Se borrarán de este navegador el proyecto en proceso y su copia local. El archivo original no se modifica.'),
        confirmLabel: isRunning ? 'Detener y quitar' : 'Quitar proyecto',
        danger: true,
      });
      if (!sure) return;
    }
    if (isRunning) {
      this.cancelRunning();
    }

    const index = this.jobs.indexOf(job);
    if (index < 0) return;
    if (this.pickerIntent?.projectId === job.id) this.clearPickerIntent();
    if (this.isMergeJob(job)) {
      if (this.mergeSourcePreview?.jobId === job.id) this.releaseMergeSourcePreview();
      if (this.mergeSequence?.jobId === job.id) this.releaseMergeSequence();
    }
    if (this.isAddAudioJob(job)) {
      if (this.audioMixPreview?.jobId === job.id) this.releaseAudioMixPreview();
      if (this.audioMixTimeline?.jobId === job.id) this.releaseAudioMixTimeline();
    }
    this.jobs.splice(index, 1);
    if (this.selectedId === job.id) this.selectedId = this.jobs[Math.min(index, this.jobs.length - 1)]?.id || null;
    // Turning persistence off means “stop changing the durable copy”, not
    // “silently delete it”. The explicit storage action remains available in
    // Settings; re-enabling persistence will commit the current workspace.
    if (this.projectPersistenceEnabled()) this.deletePersistedProject(job.id);
    this.paintQueue();
    this.paintDetail();
  }

  async clearFinishedProjects() {
    const finished = this.jobs.filter((job) => this.jobIsSettledDone(job));
    if (!finished.length) return;
    const sure = await this.confirm({
      title: `¿Quitar ${finished.length} proyecto${finished.length === 1 ? '' : 's'} terminado${finished.length === 1 ? '' : 's'}?`,
      message: 'Se borrarán de este navegador los proyectos y sus resultados guardados. Los archivos originales no se modifican.',
      confirmLabel: 'Quitar terminados',
      danger: true,
    });
    if (!sure) return;
    for (const job of finished) await this.removeJob(job, { confirm: false });
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

    const done = this.jobs.filter((job) => this.jobIsSettledDone(job));
    this.dom.queueCount.textContent = this.jobs.length
      ? `${this.jobs.length} file${this.jobs.length === 1 ? '' : 's'}`
      : 'Nothing queued';
    this.dom.app.dataset.empty = String(this.jobs.length === 0);
    this.dom.startAll.disabled = !this.jobs.some((job) => this.jobPendingForRun(job));
    this.dom.downloadAll.disabled = done.length === 0;

    const running = this.jobs.filter((job) => job.status === 'running').length;
    this.dom.statusQueue.textContent = this.jobs.length
      ? `${done.length} done${running ? ', 1 converting' : ''} of ${this.jobs.length}`
      : '';
  }

  describeJob(job) {
    if (job?.needsRelink || this.missingProjectAssets(job).length) {
      const missing = this.missingProjectAssets(job).length;
      return `${missing} fuente${missing === 1 ? '' : 's'} · Reconectar`;
    }
    if (this.isMergeJob(job)) {
      if (job.status === 'failed') return job.error ? truncateName(job.error, 44) : 'Falló la unión';
      if (job.status === 'running') {
        const percent = Math.round(job.progress * 100);
        const left = job.remaining !== null ? ` · ${formatDuration(job.remaining)} restantes` : '';
        return `${percent}%${left}`;
      }
      if (job.status === 'probing') {
        const ready = job.clips.filter((clip) => clip.status === 'ready').length;
        return `Analizando ${ready}/${job.clips.length}`;
      }
      const bits = [`${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'}`];
      const duration = mergeTotalDuration(job.clips);
      if (duration) bits.push(formatDuration(duration));
      bits.push(formatBytes(job.size));
      if (job.validationError) bits.push('Revisar');
      else if (job.dirtySinceOutput) bits.push('Cambios pendientes');
      else if (job.status === 'done') bits.push(STATUS_LABELS.done);
      return bits.join(' · ');
    }
    if (this.isAddAudioJob(job)) {
      if (job.status === 'failed') return job.error ? truncateName(job.error, 44) : 'Falló la mezcla';
      if (job.status === 'running') {
        const percent = Math.round(job.progress * 100);
        const left = job.remaining !== null ? ` · ${formatDuration(job.remaining)} restantes` : '';
        return `${percent}%${left}`;
      }
      if (job.status === 'probing') {
        if (job.video?.status !== 'ready') return 'Analizando video';
        if (job.audio?.status === 'probing') return 'Analizando audio';
      }
      const bits = [job.audio ? 'Video + audio' : 'Falta audio', formatBytes(job.size || 0)];
      const duration = videoTrackDuration(job.video?.info);
      if (duration) bits.splice(1, 0, formatDuration(duration));
      if (job.validationError && job.audio) bits.push('Revisar');
      else if (job.validationError && job.validationCode !== 'missing-audio') bits.push('Revisar');
      else if (job.dirtySinceOutput) bits.push('Cambios pendientes');
      else if (job.status === 'done') bits.push(STATUS_LABELS.done);
      return bits.join(' · ');
    }
    const quickTool = focusedQuickTool(job?.forgeToolId);
    if (job.status === 'failed') return job.error ? truncateName(job.error, 44) : 'Failed';
    if (job.status === 'running') {
      const percent = Math.round(job.progress * 100);
      const left = job.remaining !== null ? ` · ${formatDuration(job.remaining)} left` : '';
      return `${percent}%${left}`;
    }
    if (job.status === 'done' && quickTool && (job.dirtySinceOutput || job.validationError)) {
      return job.validationError ? 'Revisar ajustes' : 'Cambios pendientes';
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

  jobIsSettledDone(job) {
    if (job?.status !== 'done') return false;
    if (this.isMergeJob(job)) return !job.dirtySinceOutput && !job.validationError;
    if (this.isAddAudioJob(job)) return !job.dirtySinceOutput && !job.validationError;
    if (focusedQuickTool(job.forgeToolId)) return !job.dirtySinceOutput && !job.validationError;
    return true;
  }

  jobPendingForRun(job) {
    if (!job) return false;
    if (job.needsRelink || this.missingProjectAssets(job).length) return false;
    if (job.status === 'queued') return true;
    if (job.status === 'ready') {
      if (this.isAddAudioJob(job)) return this.addAudioValidation(job).ok;
      return true;
    }
    if (job.status !== 'done' || !job.dirtySinceOutput) return false;
    if (this.isAddAudioJob(job)) return this.addAudioValidation(job).ok;
    return this.isMergeJob(job) || Boolean(focusedQuickTool(job.forgeToolId));
  }

  /**
   * A processed Quick result belongs to an exact FFmpeg plan. Comparing that
   * plan — instead of merely remembering that a control was touched — keeps a
   * result settled when someone clicks the active preset, or changes a value
   * and then returns to the exported one.
   */
  quickPlanSignature(job) {
    const tool = focusedQuickTool(job?.forgeToolId);
    if (!tool || !this.quickJobRunnable(job, tool)) return null;
    const normalised = tool.focus === 'trim'
      ? trimOptionsForRun(job.info, job.options)
      : normalizeFocusedQuickOptions(tool.id, job.options, job.info);
    if (!normalised) return null;

    try {
      const plan = buildPlan(
        { name: job.name, info: job.info },
        job.operation,
        { ...job.options, ...normalised, format: quickVideoFormat(job.options.format) },
      );
      return planToCommand(plan);
    } catch {
      return null;
    }
  }

  syncQuickDirty(job) {
    if (!focusedQuickTool(job?.forgeToolId) || !job.outputs?.length) return;
    const signature = this.quickPlanSignature(job);
    job.dirtySinceOutput = !signature || signature !== job.quickExportSignature;
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
    job.options.cropAspect = 'free';
    job.options.cropX = null;
    job.options.cropY = null;
    job.options.cropWidth = null;
    job.options.cropHeight = null;
    job.cropPreviewUnavailable = false;

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
    } else if (tool.id === 'video-crop') {
      job.options.rotate = 0;
      job.options.flip = 'none';
      job.options.resolution = 'source';
      Object.assign(job.options, fullCropRect(job.info));
    } else if (tool.id === 'video-volume') {
      job.options.rotate = 0;
      job.options.flip = 'none';
      job.options.resolution = 'source';
      job.options.volumeGain = tool.defaultOptions.volumeGain;
      job.options.mute = false;
    } else if (tool.id === 'video-speed') {
      job.options.rotate = 0;
      job.options.flip = 'none';
      job.options.resolution = 'source';
      job.options.playbackRate = tool.defaultOptions.playbackRate;
      job.options.mute = false;
    } else if (tool.id === 'video-loop') {
      job.options.rotate = 0;
      job.options.flip = 'none';
      job.options.resolution = 'source';
      job.options.mute = false;
      const loop = defaultVideoLoopOptions(job.info);
      if (loop) Object.assign(job.options, loop);
      else job.validationError = 'Este video es demasiado largo para repetirlo dentro del límite seguro de 30 minutos.';
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
    const mergeJob = this.isMergeJob(job);
    const audioMixJob = this.isAddAudioJob(job);
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
      this.releaseCropper();
      this.releaseMergeSourcePreview();
      this.releaseMergeSequence();
      this.releaseAudioMixPreview();
      this.releaseAudioMixTimeline();
      return;
    }

    this.dom.detail.dataset.workspace = mergeJob
      ? 'video-merge'
      : (audioMixJob ? 'video-add-audio' : (quickTool ? 'quick-tool' : 'converter'));
    this.dom.detail.dataset.status = job.status === 'done' && job.dirtySinceOutput ? 'ready' : job.status;
    if (mergeJob) this.dom.detail.dataset.tool = MERGE_TOOL_ID;
    else if (audioMixJob) this.dom.detail.dataset.tool = ADD_AUDIO_TOOL_ID;
    else if (quickTool) this.dom.detail.dataset.tool = quickTool.id;
    else delete this.dom.detail.dataset.tool;

    if (!mergeJob) {
      this.releaseMergeSourcePreview();
      this.releaseMergeSequence();
    }
    if (!audioMixJob) {
      this.releaseAudioMixPreview();
      this.releaseAudioMixTimeline();
    }

    // Selecting a different file means the timeline belongs to a file that is
    // no longer on screen, and its `<video>` is still holding the old one open.
    if (this.scrubber && this.scrubber.jobId !== job.id) this.releaseScrubber();
    if (this.cropper && (this.cropper.jobId !== job.id || quickTool?.focus !== 'crop')) this.releaseCropper();
    if (this.quickSourcePreview && this.quickSourcePreview.jobId !== job.id) this.releaseQuickSourcePreview();
    if (this.quickOutputPreview && this.quickOutputPreview.jobId !== job.id) this.releaseQuickOutputPreview();
    if (this.audioMixPreview && this.audioMixPreview.jobId !== job.id) this.releaseAudioMixPreview();
    if (this.audioMixTimeline && this.audioMixTimeline.jobId !== job.id) this.releaseAudioMixTimeline();

    this.dom.detailName.textContent = mergeJob
      ? 'Unir videos'
      : (audioMixJob ? 'Agregar audio al video' : (quickTool?.title || job.name));
    this.dom.detailFacts.textContent = mergeJob
      ? `${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'} · ${formatBytes(job.size)}${mergeTotalDuration(job.clips) ? ` · ${formatDuration(mergeTotalDuration(job.clips))}` : ''}`
      : audioMixJob
      ? `${job.video?.name || 'Video'} · ${formatBytes(job.size || 0)}${videoTrackDuration(job.video?.info) ? ` · ${formatDuration(videoTrackDuration(job.video.info))}` : ''}`
      : quickTool
      ? `${job.name} · ${this.describeSource(job)}`
      : this.describeSource(job);

    if (job.needsRelink || this.missingProjectAssets(job).length) {
      this.renderRelinkState(job);
      return;
    }

    if (mergeJob) {
      this.releasePreview();
      this.releaseQuickSourcePreview();
      this.releaseCropper();
      this.releaseScrubber();
      this.dom.preview.replaceChildren();
      delete this.dom.preview.dataset.job;
      this.renderMergeControls(job);
      this.renderCommand();
      this.renderMergeFooter(job);
      const advanced = prefs.get('advanced');
      this.dom.commandBlock.hidden = !advanced || job.status === 'probing';
      this.renderDetailActions(job, null);
      this.restoreMergeFocus(job);
      return;
    }

    if (audioMixJob) {
      this.releasePreview();
      this.releaseQuickSourcePreview();
      this.releaseCropper();
      this.releaseScrubber();
      this.dom.preview.replaceChildren();
      delete this.dom.preview.dataset.job;
      this.renderAudioMixControls(job);
      this.renderCommand();
      this.renderAddAudioFooter(job);
      const advanced = prefs.get('advanced');
      this.dom.commandBlock.hidden = !advanced || job.status === 'probing';
      this.renderDetailActions(job, null);
      this.restoreAddAudioFocus(job);
      return;
    }

    if (quickTool) {
      this.releasePreview();
      this.dom.preview.replaceChildren();
      delete this.dom.preview.dataset.job;
    } else {
      this.releaseQuickSourcePreview();
      this.releaseQuickOutputPreview();
      this.releaseCropper();
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

  renderRelinkState(job) {
    this.releasePreview();
    this.releaseQuickSourcePreview();
    this.releaseQuickOutputPreview();
    this.releaseScrubber();
    this.releaseCropper();
    this.releaseMergeSourcePreview();
    this.releaseMergeSequence();
    this.releaseAudioMixPreview();
    this.releaseAudioMixTimeline();

    const missing = this.missingProjectAssets(job);
    const list = el('ul', { class: 'project-relink-list' }, missing.map((asset) => (
      el('li', { class: 'project-relink-file' }, [
        el('span', { text: asset.name || 'Archivo sin nombre' }),
        el('small', { text: Number.isFinite(Number(asset.size)) ? formatBytes(Number(asset.size)) : 'Tamaño desconocido' }),
      ])
    )));
    this.dom.preview.replaceChildren(el('section', { class: 'project-relink-card' }, [
      el('div', { class: 'project-relink-icon', attrs: { 'aria-hidden': 'true' }, text: '↗' }),
      el('div', {}, [
        el('p', { class: 'forge-eyebrow', text: 'Proyecto recuperado' }),
        el('h3', { text: 'Reconectá los archivos originales' }),
        el('p', { text: 'La edición y los ajustes están guardados, pero el navegador ya no conserva estas fuentes. Elegilas nuevamente para continuar.' }),
      ]),
      list,
      el('div', { class: 'project-relink-actions' }, [
        el('button', { type: 'button', class: 'primary-button', dataset: { action: 'relink-project' }, text: missing.length > 1 ? 'Elegir archivos' : 'Elegir archivo' }),
      ]),
    ]));
    this.dom.controls.replaceChildren();
    this.dom.commandBlock.hidden = true;
    this.dom.quickFootSummary.hidden = false;
    this.dom.quickFootSummary.textContent = `${missing.length} fuente${missing.length === 1 ? '' : 's'} pendiente${missing.length === 1 ? '' : 's'}`;

    const start = this.dom.detail.querySelector('[data-action="start-one"]');
    const cancel = this.dom.detail.querySelector('[data-action="cancel-one"]');
    const download = this.dom.detail.querySelector('[data-action="download-one"]');
    const remove = this.dom.detail.querySelector('[data-action="remove-one"]');
    start.hidden = true;
    cancel.hidden = true;
    download.hidden = !job.outputs?.length;
    download.textContent = 'Descargar resultado anterior';
    download.classList.toggle('primary-button', Boolean(job.outputs?.length));
    download.classList.toggle('text-button', !job.outputs?.length);
    remove.textContent = 'Quitar proyecto';
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

    if (this.isAddAudioJob(job)) {
      const runnable = this.addAudioJobRunnable(job);
      start.hidden = running || queued || job.status === 'probing' || !job.audio;
      start.disabled = !runnable;
      start.textContent = job.outputs?.length
        ? (job.dirtySinceOutput ? 'Actualizar resultado' : 'Crear otra versión')
        : 'Crear video con audio';
      cancel.hidden = !running;
      cancel.textContent = 'Cancelar';
      download.hidden = !job.outputs?.length;
      download.textContent = job.dirtySinceOutput || job.status !== 'done'
        ? 'Descargar versión anterior'
        : 'Descargar video';
      remove.textContent = 'Quitar proyecto';
      const downloadIsPrimary = Boolean(job.status === 'done' && !job.dirtySinceOutput && job.outputs?.length);
      start.classList.toggle('primary-button', !downloadIsPrimary);
      start.classList.toggle('text-button', downloadIsPrimary);
      download.classList.toggle('primary-button', downloadIsPrimary);
      download.classList.toggle('text-button', !downloadIsPrimary);
      return;
    }

    if (this.isMergeJob(job)) {
      const runnable = this.mergeJobRunnable(job);
      start.hidden = running || queued || job.status === 'probing';
      start.disabled = !runnable;
      start.textContent = job.outputs?.length
        ? (job.dirtySinceOutput ? 'Actualizar resultado' : 'Crear otra versión')
        : 'Unir videos';
      cancel.hidden = !running;
      cancel.textContent = 'Cancelar';
      download.hidden = !job.outputs?.length;
      download.textContent = job.dirtySinceOutput || job.status !== 'done'
        ? 'Descargar versión anterior'
        : 'Descargar video';
      remove.textContent = 'Quitar proyecto';
      const downloadIsPrimary = Boolean(job.status === 'done' && !job.dirtySinceOutput && job.outputs?.length);
      start.classList.toggle('primary-button', !downloadIsPrimary);
      start.classList.toggle('text-button', downloadIsPrimary);
      download.classList.toggle('primary-button', downloadIsPrimary);
      download.classList.toggle('text-button', !downloadIsPrimary);
      return;
    }

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
    const quickTool = focusedQuickTool(job.forgeToolId);
    const duration = ['volume', 'speed', 'loop'].includes(quickTool?.focus)
      ? playableMediaDuration(info)
      : info.duration;
    if (duration) parts.push(formatDuration(duration));
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

  releaseAudioMixTimeline() {
    if (!this.audioMixTimeline) return;
    this.audioMixTimeline.control?.destroy?.();
    this.audioMixTimeline = null;
  }

  releaseAudioMixPreview() {
    if (!this.audioMixPreview) return;
    const record = this.audioMixPreview;
    record.video?.pause();
    record.audio?.pause();
    for (const node of [record.videoSource, record.audioSource, record.originalGain, record.addedGain, record.compressor]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
    record.context?.close?.().catch(() => {});
    for (const media of [record.video, record.audio]) {
      media?.removeAttribute('src');
      media?.load();
    }
    if (record.videoUrl) URL.revokeObjectURL(record.videoUrl);
    if (record.audioUrl) URL.revokeObjectURL(record.audioUrl);
    this.audioMixPreview = null;
  }

  updateAudioMixPreview(job, { forceSync = false } = {}) {
    const record = this.audioMixPreview;
    if (!record || record.jobId !== job.id) return;
    const locked = ['queued', 'running'].includes(job.status);
    record.video.controls = !locked;
    if (locked) {
      record.video.pause();
      record.audio.pause();
      record.context?.suspend?.().catch(() => {});
    }
    const options = normalizeAddAudioOptions(job.video?.info, job.options) || job.options;
    const originalGain = options.mixMode === 'mix' && job.video?.info?.hasAudio
      ? Number(options.originalGain) || 0
      : 0;
    const addedGain = Number(options.addedGain) || 0;
    if (record.originalGain) record.originalGain.gain.value = originalGain;
    else {
      record.video.muted = originalGain === 0;
      record.video.volume = Math.min(1, originalGain);
    }
    if (record.addedGain) record.addedGain.gain.value = addedGain;
    else record.audio.volume = Math.min(1, addedGain);
    record.audio.loop = options.audioFit === 'loop';
    if (record.compressor) {
      const protectedMix = options.limiter !== false;
      record.compressor.threshold.value = protectedMix ? -3 : 0;
      record.compressor.knee.value = protectedMix ? 6 : 0;
      record.compressor.ratio.value = protectedMix ? 20 : 1;
      record.compressor.attack.value = protectedMix ? 0.003 : 0;
      record.compressor.release.value = protectedMix ? 0.08 : 0.25;
    }
    record.options = options;
    if (!locked) record.sync?.(forceSync);
  }

  audioMixPreviewFor(job) {
    if (!job.video?.file) {
      return el('div', { class: 'audio-mix-preview-placeholder' }, [
        el('strong', { text: 'Elegí un video' }),
        el('p', { text: 'El video define el cuadro y la duración final del proyecto.' }),
      ]);
    }
    if (!job.audio?.file) {
      const pick = el('button', {
        type: 'button',
        class: 'primary-button',
        text: 'Elegir audio',
        dataset: { audioMixAction: 'pick-audio' },
      });
      pick.addEventListener('click', () => this.openAddAudioPicker(job, 'audio'));
      return el('div', { class: 'audio-mix-preview-placeholder' }, [
        el('strong', { text: 'El video está listo' }),
        el('p', { text: 'Agregá una pista de audio para activar la mezcla y su timeline.' }),
        pick,
      ]);
    }
    if (
      this.audioMixPreview?.jobId === job.id
      && this.audioMixPreview.videoAssetId === job.video.id
      && this.audioMixPreview.audioAssetId === job.audio.id
    ) {
      this.updateAudioMixPreview(job);
      return this.audioMixPreview.node;
    }

    this.releaseAudioMixPreview();
    const videoUrl = URL.createObjectURL(job.video.file);
    const audioUrl = URL.createObjectURL(job.audio.file);
    const projectDuration = videoTrackDuration(job.video.info);
    const projectStart = addAudioVideoTimelineStart(job.video.info);
    const projectEnd = projectDuration ? projectStart + projectDuration : null;
    const video = el('video', {
      class: 'audio-mix-preview-media',
      src: projectEnd ? `${videoUrl}#t=${projectStart},${projectEnd}` : videoUrl,
      controls: true,
      playsInline: true,
      preload: 'metadata',
      attrs: { 'aria-label': `Vista previa del proyecto ${job.video.name}` },
    });
    const audio = el('audio', { src: audioUrl, preload: 'auto', hidden: true });
    const note = el('p', {
      class: 'audio-mix-preview-note',
      text: 'Simulación en el navegador · el archivo exportado es el resultado exacto.',
    });
    const badge = el('span', { class: 'audio-mix-preview-badge', text: 'Preview combinada' });
    const node = el('div', { class: 'audio-mix-preview-composite' }, [video, audio, badge, note]);
    const record = {
      jobId: job.id,
      videoAssetId: job.video.id,
      audioAssetId: job.audio.id,
      videoUrl,
      audioUrl,
      video,
      audio,
      node,
      context: null,
      videoSource: null,
      audioSource: null,
      originalGain: null,
      addedGain: null,
      compressor: null,
      options: null,
      sync: null,
      projectStart,
    };

    const ensureGraph = async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;
      try {
        if (!record.context) {
          record.context = new AudioContextClass();
          record.videoSource = record.context.createMediaElementSource(video);
          record.audioSource = record.context.createMediaElementSource(audio);
          record.originalGain = record.context.createGain();
          record.addedGain = record.context.createGain();
          record.compressor = record.context.createDynamicsCompressor();
          video.muted = false;
          audio.muted = false;
          video.volume = 1;
          audio.volume = 1;
          record.videoSource.connect(record.originalGain).connect(record.compressor);
          record.audioSource.connect(record.addedGain).connect(record.compressor);
          record.compressor.connect(record.context.destination);
          this.updateAudioMixPreview(job);
        }
        if (record.context.state === 'suspended') await record.context.resume();
        return true;
      } catch {
        note.textContent = 'No pudimos combinar el audio en la preview; FFmpeg sí puede crear el resultado.';
        return false;
      }
    };

    const sync = async (forcePlay = false) => {
      const options = record.options || normalizeAddAudioOptions(job.video?.info, job.options) || job.options;
      const duration = audioTrackDuration(job.audio?.info) || audio.duration;
      const projectTime = Math.max(0, video.currentTime - projectStart);
      const relative = projectTime - (Number(options.audioOffset) || 0);
      const loops = options.audioFit === 'loop';
      const active = Number.isFinite(duration) && duration > 0 && relative >= 0 && (loops || relative < duration);
      if (!active) {
        audio.pause();
        return;
      }
      const target = loops ? relative % duration : relative;
      if (Number.isFinite(target) && (forcePlay || Math.abs(audio.currentTime - target) > 0.12)) {
        try { audio.currentTime = Math.max(0, Math.min(duration - 0.001, target)); } catch { /* metadata pending */ }
      }
      audio.playbackRate = video.playbackRate;
      if (!video.paused && audio.paused) await audio.play().catch(() => {
        note.textContent = 'El navegador no puede preescuchar esta pista; FFmpeg sí puede procesarla.';
      });
    };
    record.sync = sync;

    const enforceProjectDuration = () => {
      if (video.currentTime < projectStart - 0.001) {
        try { video.currentTime = projectStart; } catch { /* media not seekable yet */ }
        audio.pause();
        this.audioMixTimeline?.control?.setCurrentTime?.(0);
        return true;
      }
      if (!projectEnd || video.currentTime < projectEnd) return false;
      if (video.currentTime > projectEnd + 0.001) {
        try { video.currentTime = projectEnd; } catch { /* media not seekable yet */ }
      }
      video.pause();
      audio.pause();
      this.audioMixTimeline?.control?.setCurrentTime?.(projectDuration);
      return true;
    };

    video.addEventListener('play', () => {
      if (['queued', 'running'].includes(job.status)) {
        video.pause();
        return;
      }
      ensureGraph().then(() => sync(true));
    });
    video.addEventListener('pause', () => audio.pause());
    video.addEventListener('ended', () => audio.pause());
    video.addEventListener('seeking', () => {
      audio.pause();
      enforceProjectDuration();
    });
    video.addEventListener('seeked', () => sync(true));
    video.addEventListener('timeupdate', () => {
      if (enforceProjectDuration()) return;
      sync(false);
      this.audioMixTimeline?.control?.setCurrentTime?.(Math.max(0, video.currentTime - projectStart));
    });
    video.addEventListener('ratechange', () => { audio.playbackRate = video.playbackRate; });
    audio.addEventListener('error', () => {
      note.textContent = 'No podemos preescuchar este audio en el navegador; FFmpeg sí puede procesarlo.';
    });
    this.audioMixPreview = record;
    this.updateAudioMixPreview(job, { forceSync: true });
    return node;
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

    if (job.forgeToolId === 'video-crop') {
      const crop = cropRectForAspect(job.info, 'free', options);
      if (crop) {
        width = crop.cropWidth;
        height = crop.cropHeight;
      }
    }

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
        if (media.paused) {
          media.play().catch(() => {
            syncPlayLabel();
            overlay.textContent = 'No pudimos iniciar la vista previa · probá de nuevo o procesá el resultado';
          });
        }
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
    const playbackRate = tool.focus === 'speed'
      ? (normalizePlaybackRate(job.options.playbackRate) || 1)
      : 1;
    const volumeGain = tool.focus === 'volume'
      ? (normalizeVolumeGain(job.options.volumeGain) ?? 1)
      : 1;
    preview.media.style.setProperty('--quick-rotation', `${rotation}deg`);
    preview.media.style.setProperty('--quick-flip-x', flip === 'horizontal' ? '-1' : '1');
    preview.media.style.setProperty('--quick-flip-y', flip === 'vertical' ? '-1' : '1');
    preview.media.playbackRate = playbackRate;
    preview.media.defaultPlaybackRate = playbackRate;
    preview.media.preservesPitch = true;
    if ('webkitPreservesPitch' in preview.media) preview.media.webkitPreservesPitch = true;
    preview.media.muted = job.options.mute === true || (tool.focus === 'volume' && volumeGain === 0);
    preview.media.volume = Math.min(1, Math.max(0, volumeGain));
    preview.stage.dataset.sideways = String(rotation === 90 || rotation === 270);
    preview.stage.dataset.focus = 'input';
    preview.stage.dataset.effect = tool.focus;
    const description = this.quickTransformDescription(job, tool);
    preview.overlay.textContent = tool.focus === 'loop'
      ? `${description} · vista previa continua`
      : description;

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
        this.syncQuickDirty(job);
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

  cropperRect(job) {
    const rect = cropRectForAspect(job.info, 'free', job.options) || fullCropRect(job.info);
    return rect ? {
      x: rect.cropX,
      y: rect.cropY,
      width: rect.cropWidth,
      height: rect.cropHeight,
    } : null;
  }

  cropperFor(job) {
    const dimensions = visibleVideoDimensions(job.info);
    const rect = this.cropperRect(job);
    if (!dimensions || !rect) {
      return el('p', { class: 'preview-note', text: 'No pudimos medir el cuadro de este video.' });
    }

    const preset = CROP_ASPECT_PRESETS.find((item) => item.id === job.options.cropAspect);
    if (this.cropper?.jobId === job.id) {
      this.cropper.control.setRect(rect);
      this.cropper.control.setAspectRatio(preset?.ratio || null);
      this.cropper.control.setDisabled(job.status === 'running' || job.status === 'queued');
      return this.cropper.control.node;
    }

    this.releaseCropper();
    const control = createCropper({
      file: job.file,
      dimensions,
      initialRect: rect,
      aspectRatio: preset?.ratio || null,
      onChange: (next) => {
        Object.assign(job.options, {
          cropX: next.x,
          cropY: next.y,
          cropWidth: next.width,
          cropHeight: next.height,
        });
        job.previewMode = 'source';
        if (!job.cropPreviewUnavailable) job.validationError = null;
        this.syncQuickDirty(job);
        this.scheduleCommandPreview();
        this.paintQueue();
        this.updateQuickCropSummary(job);
      },
      onPreviewError: () => {
        job.cropPreviewUnavailable = true;
        job.validationError = 'Este navegador no puede mostrar este formato. Convertí el video a MP4 y después volvé a recortarlo.';
        this.scheduleCommandPreview();
        this.paintQueue();
        this.updateQuickCropSummary(job);
      },
    });
    this.cropper = { jobId: job.id, control };
    control.setDisabled(job.status === 'running' || job.status === 'queued');
    return control.node;
  }

  releaseCropper() {
    this.cropper?.control.destroy();
    this.cropper = null;
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

  releaseMergeSourcePreview() {
    if (!this.mergeSourcePreview) return;
    const { media, url } = this.mergeSourcePreview;
    media?.pause();
    media?.removeAttribute('src');
    media?.load();
    URL.revokeObjectURL(url);
    this.mergeSourcePreview = null;
  }

  releaseMergeSequence() {
    this.mergeSequence?.control.destroy();
    this.mergeSequence = null;
  }

  mergeSourcePreviewFor(job, clip) {
    if (!clip) {
      return el('div', { class: 'merge-preview-placeholder' }, [
        el('strong', { text: 'Agregá un video a la secuencia' }),
        el('p', { text: 'Cada clip va a aparecer acá para que puedas revisarlo antes de unirlos.' }),
      ]);
    }
    if (this.mergeSourcePreview?.jobId === job.id && this.mergeSourcePreview.clipId === clip.id) {
      return this.mergeSourcePreview.node;
    }

    this.releaseMergeSourcePreview();
    const url = URL.createObjectURL(clip.file);
    const media = el('video', {
      class: 'merge-preview-media',
      src: url,
      controls: true,
      playsInline: true,
      preload: 'metadata',
      attrs: { 'aria-label': `Vista previa de ${clip.name}` },
    });
    const record = { jobId: job.id, clipId: clip.id, url, media, node: media };
    media.addEventListener('error', () => {
      const fallback = el('div', { class: 'merge-preview-placeholder' }, [
        el('strong', { text: 'Vista previa no disponible' }),
        el('p', { text: 'El navegador no puede reproducir este formato, pero FFmpeg puede unirlo si el análisis termina correctamente.' }),
      ]);
      media.replaceWith(fallback);
      record.node = fallback;
    }, { once: true });
    this.mergeSourcePreview = record;
    return media;
  }

  openMergePicker(job) {
    if (!this.isMergeJob(job) || ['queued', 'running'].includes(job.status)) return;
    this.setPickerIntent({ kind: 'merge-append', projectId: job.id });
    this.dom.fileInput.accept = 'video/*';
    this.dom.fileInput.multiple = true;
    this.dom.fileInput.click();
  }

  markMergeJobEdited(job) {
    Object.assign(job, markMergeEdited(job));
    job.previewMode = 'source';
    this.syncMergeProject(job);
  }

  setMergeOption(job, key, value) {
    if (!this.isMergeJob(job) || ['queued', 'running'].includes(job.status)) return;
    if (job.options[key] === value) return;
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingMergeFocus = { type: 'option', key };
    }
    job.options[key] = value;
    this.markMergeJobEdited(job);
    this.scheduleCommandPreview();
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  selectMergeClip(job, clipId) {
    if (!job.clips.some((clip) => clip.id === clipId)) return;
    job.pendingMergeFocus = { type: 'clip', id: clipId };
    job.selectedClipId = clipId;
    job.previewMode = 'source';
    if (job.id === this.selectedId) this.paintDetail();
  }

  moveMergeClip(job, clipId, targetIndex) {
    if (['queued', 'running'].includes(job.status)) return;
    const before = job.clips.map((clip) => clip.id).join('\n');
    const next = reorderMergeClips(job.clips, clipId, targetIndex);
    if (next.map((clip) => clip.id).join('\n') === before) return;
    job.pendingMergeFocus = { type: 'handle', id: clipId };
    job.clips = next;
    this.markMergeJobEdited(job);
    this.scheduleCommandPreview();
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  removeMergeClip(job, clipId) {
    if (['queued', 'running'].includes(job.status)) return;
    const index = job.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return;
    job.clips.splice(index, 1);
    if (job.selectedClipId === clipId) {
      job.selectedClipId = job.clips[Math.min(index, job.clips.length - 1)]?.id || null;
    }
    job.pendingMergeFocus = job.selectedClipId ? { type: 'clip', id: job.selectedClipId } : { type: 'add' };
    this.markMergeJobEdited(job);
    this.scheduleCommandPreview();
    this.scheduleProjectSave({ immediate: true, force: true });
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  mergeJobRunnable(job) {
    if (!this.isMergeJob(job) || ['probing', 'queued', 'running'].includes(job.status)) return false;
    return validateMergeClips(job.clips).ok;
  }

  restoreMergeFocus(job) {
    if (job.pendingQuickTab) {
      const action = job.pendingQuickTab === 'result' ? 'preview-result' : 'preview-source';
      this.dom.controls.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
      delete job.pendingQuickTab;
      return;
    }

    const pending = job.pendingMergeFocus;
    if (!pending) return;
    if (pending.type === 'option') {
      this.dom.controls.querySelector(`[data-merge-option="${pending.key}"]`)?.focus({ preventScroll: true });
    } else if (pending.type === 'handle') {
      const handle = Array.from(this.dom.controls.querySelectorAll('[data-merge-handle]'))
        .find((node) => node.dataset.clipId === pending.id);
      handle?.focus({ preventScroll: true });
    } else if (pending.type === 'clip') {
      this.mergeSequence?.control.focusClip(pending.id);
    } else if (pending.type === 'add') {
      this.dom.controls.querySelector('[data-merge-action="add"]')?.focus({ preventScroll: true });
    }
    delete job.pendingMergeFocus;
  }

  validateMergeJob(job, { notify = true } = {}) {
    if (!this.isMergeJob(job)) return true;
    const validation = validateMergeClips(job.clips);
    job.validationError = validation.error;
    if (validation.ok) return true;
    if (notify) this.toast(validation.error, { kind: 'error', duration: 6500 });
    if (job.id === this.selectedId) this.paintDetail();
    return false;
  }

  mergeStatusCopy(job) {
    const validation = validateMergeClips(job.clips);
    if (job.status === 'probing') {
      const ready = job.clips.filter((clip) => clip.status === 'ready').length;
      return {
        title: 'Analizando los videos',
        detail: `${ready} de ${job.clips.length} listos · leyendo pistas y duración sin subir archivos.`,
      };
    }
    if (!validation.ok) return { title: 'Revisá la secuencia', detail: validation.error };
    if (job.status === 'queued') return { title: 'En cola', detail: 'La unión empezará cuando el motor quede libre.' };
    if (job.status === 'running') {
      const remaining = job.remaining !== null ? ` · ${formatDuration(job.remaining)} restantes` : '';
      return {
        title: `Uniendo videos · ${Math.round(job.progress * 100)}%`,
        detail: `Procesamiento local${remaining}`,
      };
    }
    if (job.status === 'done' && !job.dirtySinceOutput) {
      return { title: 'Video listo', detail: `${formatBytes(job.outputSize || 0)} · listo para revisar o descargar.` };
    }
    if (job.status === 'failed') {
      const previous = job.outputs?.length ? ' El resultado anterior sigue disponible.' : '';
      return { title: 'No pudimos unir los videos', detail: `${job.error || 'Intentá de nuevo.'}${previous}` };
    }
    if (job.status === 'cancelled') {
      return { title: 'Unión cancelada', detail: 'La secuencia sigue intacta y podés volver a intentarlo.' };
    }
    if (job.dirtySinceOutput) {
      return { title: 'Cambios sin procesar', detail: 'El resultado anterior sigue disponible mientras preparás una nueva versión.' };
    }
    const duration = validation.totalDuration ? formatDuration(validation.totalDuration) : 'duración pendiente';
    return { title: 'Secuencia lista', detail: `${job.clips.length} clips · ${duration} · el original queda intacto.` };
  }

  mergeStatusCard(job) {
    const copy = this.mergeStatusCopy(job);
    const validation = validateMergeClips(job.clips);
    const activeStatus = ['probing', 'queued', 'running', 'failed', 'cancelled'].includes(job.status);
    const status = !validation.ok && job.status !== 'probing'
      ? 'failed'
      : (activeStatus ? job.status : (job.dirtySinceOutput ? 'ready' : job.status));
    return el('div', {
      class: 'merge-status-card',
      dataset: { status },
      attrs: { 'aria-live': 'polite' },
    }, [
      el('strong', { text: copy.title, dataset: { mergeProgressTitle: '' } }),
      el('span', { text: copy.detail, dataset: { mergeProgressDetail: '' } }),
      el('progress', {
        max: 1,
        value: job.progress || 0,
        hidden: job.status !== 'running' && job.status !== 'queued',
      }),
    ]);
  }

  renderMergeControls(job) {
    const container = this.dom.controls;
    container.replaceChildren();
    this.releaseMergeSequence();

    const selectedClip = job.clips.find((clip) => clip.id === job.selectedClipId) || job.clips[0] || null;
    if (selectedClip && selectedClip.id !== job.selectedClipId) job.selectedClipId = selectedClip.id;
    const resultAvailable = Boolean(job.outputs?.length);
    if (!resultAvailable && job.previewMode === 'result') job.previewMode = 'source';
    const showingResult = resultAvailable && job.previewMode === 'result';
    if (showingResult) this.releaseMergeSourcePreview();
    else this.pauseQuickOutputPreview();

    const panelId = `merge-preview-panel-${job.id}`;
    const sourceTabId = `merge-preview-source-${job.id}`;
    const resultTabId = `merge-preview-result-${job.id}`;
    const sourceTab = el('button', {
      id: sourceTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? '' : ' is-active'}`,
      text: 'Clip seleccionado',
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

    const stage = el('div', {
      id: panelId,
      class: 'merge-preview-stage',
      attrs: { role: 'tabpanel', 'aria-labelledby': showingResult ? resultTabId : sourceTabId },
    });
    if (showingResult) {
      stage.append(this.quickOutputPreviewFor(job));
    } else {
      stage.append(this.mergeSourcePreviewFor(job, selectedClip));
      if (selectedClip) {
        stage.append(el('span', {
          class: 'merge-preview-overlay',
          text: `${job.clips.findIndex((clip) => clip.id === selectedClip.id) + 1}/${job.clips.length} · ${truncateName(selectedClip.name, 48)}`,
        }));
      }
    }

    const canvas = el('section', { class: 'merge-canvas' }, [
      el('header', { class: 'merge-preview-head' }, [
        el('div', { class: 'merge-preview-copy' }, [
          el('strong', { text: showingResult ? 'Resultado unido' : (selectedClip?.name || 'Secuencia vacía') }),
          el('span', {
            text: showingResult
              ? `${formatBytes(job.outputSize || 0)} · video procesado`
              : (selectedClip?.info ? this.describeSource({ ...selectedClip, status: selectedClip.status }) : 'Preparando vista previa…'),
          }),
          el('small', { text: 'Local · los archivos no salen de este dispositivo' }),
        ]),
        el('div', { class: 'quick-preview-switch', attrs: { role: 'tablist', 'aria-label': 'Vista previa' } }, [sourceTab, resultTab]),
      ]),
      stage,
    ]);

    const locked = job.status === 'queued' || job.status === 'running';
    const sequence = createMergeSequence({
      clips: job.clips,
      selectedClipId: job.selectedClipId,
      disabled: locked,
      onSelect: (id) => this.selectMergeClip(job, id),
      onMove: (id, targetIndex) => this.moveMergeClip(job, id, targetIndex),
      onRemove: (id) => this.removeMergeClip(job, id),
      onAdd: () => this.openMergePicker(job),
    });
    this.mergeSequence = { jobId: job.id, control: sequence };

    const selectedSection = el('section', { class: 'merge-inspector-section' }, [
      el('h3', { text: 'Clip seleccionado' }),
      el('strong', { text: selectedClip?.name || 'Sin clips' }),
      el('p', {
        text: selectedClip?.error
          || (selectedClip?.info ? this.describeSource({ ...selectedClip, status: selectedClip.status }) : 'Elegí Agregar videos para completar la secuencia.'),
      }),
    ]);

    const fitControl = this.selectControl([
      { value: 'contain', label: 'Completo, con márgenes' },
      { value: 'cover', label: 'Llenar y recortar' },
    ], job.options.mergeFit, (value) => this.setMergeOption(job, 'mergeFit', value));
    fitControl.dataset.mergeOption = 'mergeFit';
    const qualityControl = this.selectControl(
      this.quickQualityOptions(),
      job.options.quality,
      (value) => this.setMergeOption(job, 'quality', value)
    );
    qualityControl.dataset.mergeOption = 'quality';
    const outputFields = [
      this.field('Encuadre', fitControl, job.options.mergeFit === 'cover'
        ? 'Llena todo el cuadro; puede recortar los bordes.'
        : 'Muestra cada video completo y agrega márgenes si hace falta.'),
      this.field('Calidad', qualityControl),
    ];
    if (job.info?.hasAudio) {
      const muteControl = this.checkbox(job.options.mute, 'Quitar todo el audio', (value) => this.setMergeOption(job, 'mute', value));
      muteControl.querySelector('input').dataset.mergeOption = 'mute';
      outputFields.push(el('div', { class: 'control' }, [muteControl]));
    }

    let target = null;
    if (validateMergeClips(job.clips).ok) {
      try {
        target = buildJoinVideosPlan(job.clips.map((clip) => ({ name: clip.name, info: clip.info })), job.options);
      } catch {
        target = null;
      }
    }
    const outputSection = el('section', { class: 'merge-output-section' }, [
      el('h3', { text: 'Resultado' }),
      el('p', {
        text: target
          ? `MP4 H.264 · ${target.width}×${target.height} · ${target.fps} fps · ${formatDuration(target.duration)}`
          : 'MP4 H.264 · el primer clip define el cuadro final.',
      }),
      ...outputFields,
    ]);
    for (const input of outputSection.querySelectorAll('input, select, button')) input.disabled = locked;

    const inspector = el('aside', { class: 'merge-inspector', attrs: { 'aria-label': 'Ajustes para unir videos' } }, [
      selectedSection,
      outputSection,
      el('section', { class: 'merge-inspector-section' }, [this.mergeStatusCard(job)]),
    ]);

    container.append(el('div', { class: 'merge-tool-layout' }, [canvas, inspector, sequence.node]));
  }

  updateMergeProgress(job) {
    if (this.selectedId !== job.id || !this.isMergeJob(job)) return;
    const card = this.dom.controls.querySelector('.merge-status-card');
    if (card) {
      const copy = this.mergeStatusCopy(job);
      const activeStatus = ['probing', 'queued', 'running', 'failed', 'cancelled'].includes(job.status);
      card.dataset.status = activeStatus ? job.status : (job.dirtySinceOutput ? 'ready' : job.status);
      const title = card.querySelector('[data-merge-progress-title]');
      const detail = card.querySelector('[data-merge-progress-detail]');
      const progress = card.querySelector('progress');
      if (title) title.textContent = copy.title;
      if (detail) detail.textContent = copy.detail;
      if (progress) {
        progress.hidden = job.status !== 'running' && job.status !== 'queued';
        progress.value = job.progress || 0;
      }
    }
    this.renderMergeFooter(job);
  }

  renderMergeFooter(job) {
    const summary = this.dom.quickFootSummary;
    if (!this.isMergeJob(job)) return;
    const copy = this.mergeStatusCopy(job);
    summary.hidden = false;
    summary.replaceChildren(
      el('strong', { text: copy.title }),
      el('span', { text: copy.detail })
    );
  }

  markAddAudioJobEdited(job) {
    Object.assign(job, markAddAudioEdited(job));
    job.previewMode = 'source';
    this.syncAddAudioProject(job);
  }

  setAddAudioOption(job, key, value) {
    if (!this.isAddAudioJob(job) || ['queued', 'running'].includes(job.status)) return;
    if (String(job.options[key]) === String(value)) return;
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingAddAudioFocus = { type: 'option', key };
    }
    job.options[key] = value;
    job.addAudioTouchedOptions ||= {};
    job.addAudioTouchedOptions[key] = true;
    this.markAddAudioJobEdited(job);
    this.updateAudioMixPreview(job, { forceSync: key === 'audioOffset' || key === 'audioFit' });
    this.scheduleCommandPreview();
    this.paintQueue();
    if (job.id === this.selectedId) this.paintDetail();
  }

  setAddAudioLiveOption(job, key, value) {
    if (!this.isAddAudioJob(job) || ['queued', 'running'].includes(job.status)) return;
    if (String(job.options[key]) === String(value)) return;
    job.options[key] = value;
    job.addAudioTouchedOptions ||= {};
    job.addAudioTouchedOptions[key] = true;
    this.markAddAudioJobEdited(job);
    if (key === 'audioOffset') this.audioMixTimeline?.control?.setOffset?.(value);
    this.updateAudioMixPreview(job);
    this.scheduleCommandPreview();
    this.paintQueue();
    this.updateAddAudioProgress(job);
    this.renderDetailActions(job);
  }

  commitAddAudioLiveOption(job, key, { timeline = false } = {}) {
    if (!this.isAddAudioJob(job) || ['queued', 'running'].includes(job.status)) return;
    this.updateAudioMixPreview(job, { forceSync: key === 'audioOffset' || key === 'audioFit' });
    job.pendingAddAudioFocus = timeline ? { type: 'timeline' } : { type: 'option', key };
    if (job.id === this.selectedId) this.paintDetail();
  }

  addAudioJobRunnable(job) {
    if (!this.isAddAudioJob(job) || ['probing', 'queued', 'running'].includes(job.status)) return false;
    return this.addAudioValidation(job).ok;
  }

  addAudioValidation(job) {
    const validation = validateAddAudioProject(job, job?.options);
    const retainedBytes = Number(job?.outputSize) || 0;
    if (
      validation.ok
      && retainedBytes > 0
      && validation.estimatedWorkingBytes + retainedBytes > ADD_AUDIO_LIMITS.maxWorkingBytes
    ) {
      return {
        ...validation,
        ok: false,
        code: 'retained-output-memory-limit',
        message: 'El resultado anterior y esta nueva exportación superarían el límite seguro de memoria. Descargá el anterior y creá un proyecto nuevo para esta versión.',
      };
    }
    return validation;
  }

  validateAddAudioJob(job, { notify = true } = {}) {
    if (!this.isAddAudioJob(job)) return true;
    const validation = this.addAudioValidation(job);
    job.validationError = validation.message;
    if (validation.ok) return true;
    if (notify) this.toast(validation.message, { kind: 'error', duration: 7000 });
    if (job.id === this.selectedId) this.paintDetail();
    return false;
  }

  addAudioStatusCopy(job) {
    const validation = this.addAudioValidation(job);
    if (job.video?.status === 'probing') {
      return { title: 'Analizando el video', detail: 'Leyendo cuadro, duración y pistas sin subir el archivo.' };
    }
    if (!job.audio) {
      return { title: 'Elegí una pista de audio', detail: 'Puede ser música, voz o un efecto; el video define la duración final.' };
    }
    if (job.audio.status === 'probing') {
      return { title: 'Analizando el audio', detail: 'Midiendo duración y formato antes de preparar la mezcla.' };
    }
    if (!validation.ok) return { title: 'Revisá el proyecto', detail: validation.message };
    if (job.status === 'queued') return { title: 'En cola', detail: 'La mezcla empezará cuando el motor quede libre.' };
    if (job.status === 'running') {
      const remaining = job.remaining !== null ? ` · ${formatDuration(job.remaining)} restantes` : '';
      return {
        title: `Creando video · ${Math.round(job.progress * 100)}%`,
        detail: `Mezcla y codificación local${remaining}`,
      };
    }
    if (job.status === 'done' && !job.dirtySinceOutput) {
      return { title: 'Video listo', detail: `${formatBytes(job.outputSize || 0)} · listo para revisar o descargar.` };
    }
    if (job.status === 'failed') {
      const previous = job.outputs?.length ? ' El resultado anterior sigue disponible.' : '';
      return { title: 'No pudimos crear el video', detail: `${job.error || 'Intentá de nuevo.'}${previous}` };
    }
    if (job.status === 'cancelled') {
      const previous = job.outputs?.length ? ' El resultado anterior sigue disponible.' : '';
      return { title: 'Procesamiento cancelado', detail: `Las dos fuentes siguen intactas.${previous}` };
    }
    if (job.dirtySinceOutput) {
      return { title: 'Cambios sin procesar', detail: 'El resultado anterior sigue disponible mientras ajustás una nueva versión.' };
    }
    const duration = videoTrackDuration(job.video?.info);
    return {
      title: 'Proyecto listo',
      detail: `${job.options.mixMode === 'mix' ? 'Audio mezclado' : 'Audio reemplazado'} · resultado de ${duration ? formatDuration(duration) : 'duración pendiente'}.`,
    };
  }

  addAudioStatusCard(job) {
    const copy = this.addAudioStatusCopy(job);
    const activeStatus = ['probing', 'queued', 'running', 'failed', 'cancelled'].includes(job.status);
    const validation = this.addAudioValidation(job);
    const status = !validation.ok && job.audio && job.status !== 'probing'
      ? 'failed'
      : (activeStatus ? job.status : (job.dirtySinceOutput ? 'ready' : job.status));
    return el('div', {
      class: 'audio-mix-status-card',
      dataset: { status },
      attrs: { 'aria-live': 'polite' },
    }, [
      el('strong', { text: copy.title, dataset: { addAudioProgressTitle: '' } }),
      el('span', { text: copy.detail, dataset: { addAudioProgressDetail: '' } }),
      el('progress', {
        max: 1,
        value: job.progress || 0,
        hidden: job.status !== 'running' && job.status !== 'queued',
      }),
    ]);
  }

  parseSignedTimestamp(value) {
    const text = String(value || '').trim();
    const negative = text.startsWith('-');
    const seconds = parseTimestamp(negative ? text.slice(1) : text);
    return seconds === null ? null : (negative ? -seconds : seconds);
  }

  describeAudioOffset(value) {
    const offset = Number(value) || 0;
    if (offset < 0) return `Omitir ${formatTimestamp(Math.abs(offset))} del inicio`;
    if (offset > 0) return `Entrar en ${formatTimestamp(offset)}`;
    return 'Empezar junto al video';
  }

  addAudioSourceCard(job, role) {
    const asset = job[role];
    const label = role === 'video' ? 'Video base' : 'Pista agregada';
    if (!asset) {
      const pick = el('button', {
        type: 'button',
        class: 'audio-mix-source-empty',
        dataset: { audioMixAction: `pick-${role}` },
      }, [
        el('span', { class: 'audio-mix-source-icon', text: '+' }),
        el('strong', { text: role === 'audio' ? 'Elegir audio' : 'Elegir video' }),
        el('small', { text: role === 'audio' ? 'Música, voz o efectos' : 'Define el cuadro final' }),
      ]);
      pick.addEventListener('click', () => this.openAddAudioPicker(job, role));
      return el('section', { class: 'audio-mix-source-card', dataset: { role, empty: 'true' } }, [
        el('h3', { text: label }),
        pick,
      ]);
    }

    const duration = role === 'video' ? videoTrackDuration(asset.info) : audioTrackDuration(asset.info);
    const facts = [
      duration ? formatDuration(duration) : null,
      role === 'video' && asset.info?.video?.width ? `${asset.info.video.width}×${asset.info.video.height}` : null,
      role === 'audio' && asset.info?.audio?.codec ? String(asset.info.audio.codec).toUpperCase() : null,
      formatBytes(asset.size),
    ].filter(Boolean).join(' · ');
    const replace = el('button', {
      type: 'button',
      class: 'text-button',
      text: 'Reemplazar',
      disabled: ['queued', 'running'].includes(job.status),
      dataset: { audioMixAction: `pick-${role}` },
    });
    replace.addEventListener('click', () => this.openAddAudioPicker(job, role));
    const actions = [replace];
    if (role === 'audio') {
      const remove = el('button', {
        type: 'button',
        class: 'text-button danger-text',
        text: 'Quitar',
        disabled: ['queued', 'running'].includes(job.status),
        dataset: { audioMixAction: 'remove-audio' },
      });
      remove.addEventListener('click', () => this.removeAddAudioTrack(job));
      actions.push(remove);
    }
    return el('section', { class: 'audio-mix-source-card', dataset: { role, status: asset.status } }, [
      el('div', { class: 'audio-mix-source-head' }, [
        el('div', {}, [el('h3', { text: label }), el('strong', { text: truncateName(asset.name, 38), title: asset.name })]),
        el('span', { class: 'audio-mix-source-state', text: asset.status === 'probing' ? 'Analizando' : (asset.error ? 'Atención' : 'Lista') }),
      ]),
      el('p', { text: asset.error || facts || 'Esperando información…' }),
      el('div', { class: 'audio-mix-source-actions' }, actions),
    ]);
  }

  renderAudioMixControls(job) {
    const container = this.dom.controls;
    container.replaceChildren();
    this.releaseAudioMixTimeline();

    const resultAvailable = Boolean(job.outputs?.length);
    if (!resultAvailable && job.previewMode === 'result') job.previewMode = 'source';
    const showingResult = resultAvailable && job.previewMode === 'result';
    if (showingResult) this.releaseAudioMixPreview();
    else this.pauseQuickOutputPreview();

    const panelId = `audio-mix-preview-panel-${job.id}`;
    const sourceTabId = `audio-mix-preview-source-${job.id}`;
    const resultTabId = `audio-mix-preview-result-${job.id}`;
    const sourceTab = el('button', {
      id: sourceTabId,
      type: 'button',
      class: `quick-preview-tab${showingResult ? '' : ' is-active'}`,
      text: 'Proyecto',
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

    const stage = el('div', {
      id: panelId,
      class: 'audio-mix-preview-stage',
      attrs: { role: 'tabpanel', 'aria-labelledby': showingResult ? resultTabId : sourceTabId },
    }, [showingResult ? this.quickOutputPreviewFor(job) : this.audioMixPreviewFor(job)]);
    const canvas = el('section', { class: 'audio-mix-canvas' }, [
      el('header', { class: 'audio-mix-preview-head' }, [
        el('div', { class: 'audio-mix-preview-copy' }, [
          el('strong', { text: showingResult ? 'Resultado exportado' : 'Preview del proyecto' }),
          el('span', {
            text: showingResult
              ? `${formatBytes(job.outputSize || 0)} · mezcla exacta`
              : (job.audio ? `${truncateName(job.video.name, 34)} + ${truncateName(job.audio.name, 34)}` : truncateName(job.video.name, 52)),
          }),
          el('small', { text: 'Local · ninguno de los archivos sale de este dispositivo' }),
        ]),
        el('div', { class: 'quick-preview-switch', attrs: { role: 'tablist', 'aria-label': 'Vista previa' } }, [sourceTab, resultTab]),
      ]),
      stage,
    ]);

    const locked = job.status === 'queued' || job.status === 'running';
    const videoDuration = videoTrackDuration(job.video?.info) || 0;
    const addedDuration = audioTrackDuration(job.audio?.info) || 0;
    const currentTime = this.audioMixPreview?.jobId === job.id
      ? Math.max(0, this.audioMixPreview.video.currentTime - (this.audioMixPreview.projectStart || 0))
      : 0;
    const timeline = createAudioMixTimeline({
      video: job.video ? { ...job.video, duration: videoDuration } : null,
      audio: job.audio ? { ...job.audio, duration: addedDuration } : null,
      offset: Number(job.options.audioOffset) || 0,
      fit: job.options.audioFit,
      currentTime,
      disabled: locked,
      onSeek: (seconds) => {
        if (this.audioMixPreview?.jobId === job.id) {
          this.audioMixPreview.video.currentTime = (this.audioMixPreview.projectStart || 0) + seconds;
          this.audioMixPreview.sync?.(true);
        }
      },
      onOffsetInput: (seconds) => this.setAddAudioLiveOption(job, 'audioOffset', seconds),
      onOffsetCommit: () => this.commitAddAudioLiveOption(job, 'audioOffset', { timeline: true }),
      onPickAudio: () => this.openAddAudioPicker(job, 'audio'),
      onReplaceVideo: () => this.openAddAudioPicker(job, 'video'),
      onReplaceAudio: () => this.openAddAudioPicker(job, 'audio'),
      onRemoveAudio: () => this.removeAddAudioTrack(job),
    });
    this.audioMixTimeline = { jobId: job.id, control: timeline };

    const settings = [];
    if (job.audio?.info && job.video?.info) {
      const hasOriginal = job.video.info.hasAudio === true;
      const mode = this.quickEffectSegments(job, {
        key: 'mixMode',
        label: 'Tratamiento del audio original',
        columns: 2,
        items: [
          { value: 'mix', label: 'Mezclar', meta: 'Conservar el original', disabled: !hasOriginal },
          { value: 'replace', label: 'Reemplazar', meta: hasOriginal ? 'Quitar el original' : 'El video no trae audio' },
        ],
        onSelect: (value) => this.setAddAudioOption(job, 'mixMode', value),
      });
      for (const button of mode.querySelectorAll('[data-quick-option]')) {
        button.dataset.audioMixOption = 'mixMode';
      }
      settings.push(el('div', { class: 'audio-mix-control-block' }, [
        el('h3', { text: 'Mezcla' }),
        mode,
      ]));

      if (hasOriginal && job.options.mixMode === 'mix') {
        const original = this.quickEffectRange(job, {
          key: 'originalGain',
          label: 'Audio original',
          description: 'Nivel de la pista que ya trae el video.',
          min: ADD_AUDIO_LIMITS.minGain,
          max: ADD_AUDIO_LIMITS.maxGain,
          step: 0.01,
          value: job.options.originalGain,
          formatValue: (value) => `${Math.round(value * 100)}%`,
          scale: ['0%', '100%', '200%'],
          onInput: (value) => this.setAddAudioLiveOption(job, 'originalGain', value),
          onCommit: () => this.commitAddAudioLiveOption(job, 'originalGain'),
        });
        original.querySelector('[data-quick-option]')?.setAttribute('data-audio-mix-option', 'originalGain');
        settings.push(original);
      }
      const added = this.quickEffectRange(job, {
        key: 'addedGain',
        label: 'Pista agregada',
        description: 'Nivel de la música, voz o efecto nuevo.',
        min: ADD_AUDIO_LIMITS.minGain,
        max: ADD_AUDIO_LIMITS.maxGain,
        step: 0.01,
        value: job.options.addedGain,
        formatValue: (value) => `${Math.round(value * 100)}%`,
        scale: ['0%', '100%', '200%'],
        onInput: (value) => this.setAddAudioLiveOption(job, 'addedGain', value),
        onCommit: () => this.commitAddAudioLiveOption(job, 'addedGain'),
      });
      added.querySelector('[data-quick-option]')?.setAttribute('data-audio-mix-option', 'addedGain');
      settings.push(added);

      const fit = this.quickEffectSegments(job, {
        key: 'audioFit',
        label: 'Qué pasa cuando termina la pista',
        columns: 2,
        items: [
          { value: 'once', label: 'Una vez', meta: 'Después continúa el original o silencio' },
          { value: 'loop', label: 'Repetir', meta: 'Hasta el final del video' },
        ],
        onSelect: (value) => this.setAddAudioOption(job, 'audioFit', value),
      });
      for (const button of fit.querySelectorAll('[data-quick-option]')) {
        button.dataset.audioMixOption = 'audioFit';
      }
      settings.push(el('div', { class: 'audio-mix-control-block' }, [
        el('h3', { text: 'Duración de la pista' }),
        fit,
      ]));

      if (videoDuration > 0 && addedDuration > 0) {
        // Keep the native range's min/max on the same hundredth-second grid
        // as its step. Otherwise browsers snap an exact zero to values such
        // as -0.004 when a source has millisecond-precise duration metadata.
        const minimum = Math.min(0, Math.ceil((-(addedDuration - 0.01)) * 100) / 100);
        const maximum = Math.max(0, Math.floor((videoDuration - 0.01) * 100) / 100);
        const offset = this.quickEffectRange(job, {
          key: 'audioOffset',
          label: 'Posición del audio',
          description: 'A la derecha entra más tarde; a la izquierda omite el comienzo.',
          min: minimum,
          max: maximum,
          step: 0.01,
          value: job.options.audioOffset,
          formatValue: (value) => this.describeAudioOffset(value),
          scale: [`-${formatTimestamp(Math.abs(minimum))}`, '00:00.000', formatTimestamp(maximum)],
          onInput: (value) => this.setAddAudioLiveOption(job, 'audioOffset', value),
          onCommit: () => this.commitAddAudioLiveOption(job, 'audioOffset'),
        });
        offset.querySelector('[data-quick-option]')?.setAttribute('data-audio-mix-option', 'audioOffset');
        const exact = el('input', {
          type: 'text',
          class: 'control-input',
          value: `${Number(job.options.audioOffset) < 0 ? '-' : ''}${formatTimestamp(Math.abs(Number(job.options.audioOffset) || 0))}`,
          disabled: locked,
          dataset: { audioMixOption: 'audioOffset' },
          attrs: { inputmode: 'decimal', 'aria-label': 'Posición exacta del audio' },
        });
        exact.addEventListener('change', () => {
          const value = this.parseSignedTimestamp(exact.value);
          if (value !== null) {
            this.setAddAudioOption(job, 'audioOffset', Math.min(maximum, Math.max(minimum, value)));
          }
        });
        const useCurrent = el('button', {
          type: 'button',
          class: 'text-button',
          text: 'Usar posición actual',
          disabled: locked,
        });
        useCurrent.addEventListener('click', () => {
          const seconds = this.audioMixPreview?.jobId === job.id
            ? Math.max(0, this.audioMixPreview.video.currentTime - (this.audioMixPreview.projectStart || 0))
            : 0;
          this.setAddAudioOption(job, 'audioOffset', Math.min(maximum, Math.max(minimum, seconds)));
        });
        settings.push(offset, el('div', { class: 'audio-mix-offset-exact' }, [exact, useCurrent]));
      }
    }

    const quality = this.selectControl(
      this.quickQualityOptions(),
      job.options.quality,
      (value) => this.setAddAudioOption(job, 'quality', value),
    );
    quality.dataset.audioMixOption = 'quality';
    const limiter = this.checkbox(job.options.limiter !== false, 'Protección anti-saturación', (value) => this.setAddAudioOption(job, 'limiter', value));
    limiter.querySelector('input').dataset.audioMixOption = 'limiter';
    const outputSection = el('section', { class: 'audio-mix-output-section' }, [
      el('h3', { text: 'Salida' }),
      el('p', { text: videoDuration ? `MP4 H.264 + AAC · ${formatDuration(videoDuration)}` : 'MP4 H.264 + AAC' }),
      this.field('Calidad', quality),
      el('div', { class: 'control' }, [limiter]),
      el('p', { class: 'audio-mix-output-note', text: 'La protección controla picos cuando ambas pistas suenan juntas.' }),
    ]);
    for (const input of outputSection.querySelectorAll('input, select, button')) input.disabled = locked;

    const inspector = el('aside', { class: 'audio-mix-inspector', attrs: { 'aria-label': 'Ajustes para agregar audio' } }, [
      ...(settings.length ? [el('section', { class: 'audio-mix-inspector-section audio-mix-settings' }, settings)] : []),
      outputSection,
      el('section', { class: 'audio-mix-inspector-section' }, [this.addAudioStatusCard(job)]),
    ]);
    container.append(el('div', {
      class: 'audio-mix-layout',
      attrs: { 'aria-busy': String(job.status === 'probing' || job.status === 'running') },
    }, [canvas, timeline.node, inspector]));
  }

  restoreAddAudioFocus(job) {
    if (job.pendingQuickTab) {
      const action = job.pendingQuickTab === 'result' ? 'preview-result' : 'preview-source';
      this.dom.controls.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
      delete job.pendingQuickTab;
      return;
    }
    const pending = job.pendingAddAudioFocus;
    if (!pending) return;
    if (pending.type === 'timeline') this.audioMixTimeline?.control?.focusOffset?.();
    else this.dom.controls.querySelector(`[data-audio-mix-option="${pending.key}"]`)?.focus({ preventScroll: true });
    delete job.pendingAddAudioFocus;
  }

  updateAddAudioProgress(job) {
    if (this.selectedId !== job.id || !this.isAddAudioJob(job)) return;
    const card = this.dom.controls.querySelector('.audio-mix-status-card');
    if (card) {
      const copy = this.addAudioStatusCopy(job);
      const active = ['probing', 'queued', 'running', 'failed', 'cancelled'].includes(job.status);
      card.dataset.status = active ? job.status : (job.dirtySinceOutput ? 'ready' : job.status);
      const title = card.querySelector('[data-add-audio-progress-title]');
      const detail = card.querySelector('[data-add-audio-progress-detail]');
      const progress = card.querySelector('progress');
      if (title) title.textContent = copy.title;
      if (detail) detail.textContent = copy.detail;
      if (progress) {
        progress.hidden = job.status !== 'running' && job.status !== 'queued';
        progress.value = job.progress || 0;
      }
    }
    this.renderAddAudioFooter(job);
  }

  renderAddAudioFooter(job) {
    const summary = this.dom.quickFootSummary;
    if (!this.isAddAudioJob(job)) return;
    const copy = this.addAudioStatusCopy(job);
    summary.hidden = false;
    summary.replaceChildren(el('strong', { text: copy.title }), el('span', { text: copy.detail }));
  }

  /* ------------------------------------------------------------------ *
   * Controls
   * ------------------------------------------------------------------ */

  quickEffectPreflight(job, tool = this.quickToolFor(job)) {
    if (!tool || !['volume', 'speed', 'loop'].includes(tool.focus)) return null;
    return focusedQuickPreflight(tool.id, job.options, job.info, job.size);
  }

  quickInvalidMessage(tool, job = null) {
    const preflight = job ? this.quickEffectPreflight(job, tool) : null;
    if (preflight && !preflight.ok && preflight.code !== 'invalid-effect') return preflight.message;
    switch (tool?.focus) {
      case 'trim':
        return 'El inicio y el final tienen que dejar al menos un instante de video seleccionado.';
      case 'rotate':
        return 'Elegí un giro de 90°, 180° o 270°.';
      case 'flip':
        return 'Elegí si querés voltear el video en horizontal o en vertical.';
      case 'resize':
        return 'Elegí un tamaño que reduzca realmente este video.';
      case 'crop':
        return 'Reducí o mové el marco para definir un encuadre distinto del original.';
      case 'volume':
        return 'Elegí un volumen distinto de 100% o activá Silenciar.';
      case 'speed':
        return 'Elegí una velocidad distinta de 1×.';
      case 'loop':
        return 'Elegí una repetición que dure más que el original y no supere 30 minutos.';
      default:
        return 'Revisá los ajustes antes de crear el resultado.';
    }
  }

  quickJobRunnable(job, tool = this.quickToolFor(job)) {
    if (!tool || !job?.info || job.validationError || job.cropPreviewUnavailable) return false;
    if (tool.focus === 'trim') return Boolean(trimOptionsForRun(job.info, job.options));
    const preflight = this.quickEffectPreflight(job, tool);
    if (preflight) return preflight.ok;
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
    if ((job.status === 'ready' || job.dirtySinceOutput) && tool && !this.quickJobRunnable(job, tool)) {
      return {
        title: tool.focus === 'crop' ? 'Definí el encuadre' : 'Elegí un cambio',
        detail: this.quickInvalidMessage(tool, job),
      };
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
    const visualStatus = this.quickVisualStatus(job);
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

  quickVisualStatus(job) {
    if (job.validationError) return 'failed';
    if (['probing', 'queued', 'running', 'failed', 'cancelled'].includes(job.status)) return job.status;
    return job.dirtySinceOutput ? 'ready' : job.status;
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

  quickOutputSection(job, { includeResolution = true, includeMute = true } = {}) {
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
    if (includeMute && job.info?.hasAudio) {
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
    if (['volume', 'speed', 'loop'].includes(tool.focus)) {
      this.renderQuickEffectControls(job, tool);
      return;
    }
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
    if (tool.id === 'video-crop') {
      const notes = {
        free: 'Mové cada borde',
        '1:1': 'Cuadrado',
        '16:9': 'Panorámico',
        '9:16': 'Vertical',
        '4:5': 'Social',
      };
      return {
        key: 'cropAspect',
        title: 'Relación de aspecto',
        description: 'Elegí un formato o dejalo libre para ajustar cada borde.',
        columns: 3,
        items: CROP_ASPECT_PRESETS.map((preset) => ({
          value: preset.id,
          label: preset.label,
          meta: notes[preset.id],
        })),
        onSelect: (value) => this.setCropAspect(job, value),
      };
    }
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
      button.addEventListener('click', () => {
        if (config.onSelect) config.onSelect(item.value);
        else this.setJobOption(job, config.key, item.value);
      });
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

  quickEffectSegments(job, {
    key,
    label,
    items,
    columns = 4,
    onSelect = (value) => this.setJobOption(job, key, value),
  }) {
    const locked = job.status === 'running' || job.status === 'queued';
    const group = el('div', {
      class: 'quick-segmented',
      dataset: { columns: String(columns) },
      attrs: { role: 'radiogroup', 'aria-label': label },
    });
    const activeIndex = items.findIndex((item) => String(item.value) === String(job.options[key]));

    for (const [index, item] of items.entries()) {
      const active = index === activeIndex;
      const button = el('button', {
        type: 'button',
        class: `quick-segment${active ? ' is-active' : ''}`,
        disabled: locked || item.disabled,
        tabIndex: active || (activeIndex < 0 && index === 0) ? 0 : -1,
        dataset: {
          active: String(active),
          quickOption: key,
          quickValue: String(item.value),
        },
        attrs: { role: 'radio', 'aria-checked': String(active) },
      }, [
        el('strong', { text: item.label }),
        item.meta ? el('small', { text: item.meta }) : null,
      ]);
      button.addEventListener('click', () => onSelect(item.value));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(group.querySelectorAll('[role="radio"]:not(:disabled)'));
        if (!buttons.length) return;
        const current = Math.max(0, buttons.indexOf(button));
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
      group.append(button);
    }
    return group;
  }

  quickEffectRange(job, {
    key,
    label,
    description,
    min,
    max,
    step,
    value,
    formatValue,
    scale,
    onInput,
    onCommit,
    disabled = false,
  }) {
    const locked = disabled || job.status === 'running' || job.status === 'queued';
    const safeValue = Math.min(max, Math.max(min, Number(value)));
    const position = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;
    const labelId = `quick-effect-${key}-${job.id}`;
    const output = el('output', {
      class: 'quick-effect-value',
      text: formatValue(safeValue),
      dataset: { quickEffectValue: key },
      attrs: { for: `${labelId}-input` },
    });
    const input = el('input', {
      id: `${labelId}-input`,
      class: 'quick-effect-range',
      type: 'range',
      disabled: locked,
      dataset: { quickOption: key },
      attrs: {
        min: String(min),
        max: String(max),
        step: String(step),
        'aria-labelledby': labelId,
        'aria-valuetext': formatValue(safeValue),
      },
    });
    // Range inputs start with a browser-defined midpoint. Set the value only
    // after min/max/step exist; otherwise Safari and Chromium can clamp the
    // earlier property assignment while those constraints are still changing.
    input.value = String(safeValue);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = formatValue(next);
      input.setAttribute('aria-valuetext', formatValue(next));
      const nextPosition = max === min ? 0 : ((next - min) / (max - min)) * 100;
      input.closest('.quick-effect-control')?.style.setProperty('--quick-range-position', `${nextPosition}%`);
      onInput(next);
    });
    if (onCommit) input.addEventListener('change', () => onCommit(Number(input.value)));

    return el('div', {
      class: 'quick-effect-control',
      style: `--quick-range-position:${position}%`,
    }, [
      el('div', { class: 'quick-effect-control-head' }, [
        el('div', { class: 'quick-effect-control-copy' }, [
          el('strong', { id: labelId, text: label }),
          el('span', { text: description }),
        ]),
        output,
      ]),
      input,
      el('div', { class: 'quick-effect-scale', attrs: { 'aria-hidden': 'true' } },
        scale.map((item) => el('span', { text: item }))
      ),
    ]);
  }

  quickEffectSummary(job, tool) {
    const sourceDuration = playableMediaDuration(job.info);
    if (tool.focus === 'volume') {
      const gain = normalizeVolumeGain(job.options.volumeGain);
      const output = job.options.mute
        ? 'Sin pista de audio'
        : (gain === null ? '—' : `${Math.round(gain * 100)}%`);
      return el('div', { class: 'quick-effect-summary', dataset: { quickEffectSummary: '' } }, [
        el('div', { class: 'quick-effect-stat' }, [
          el('span', { text: 'Original' }),
          el('strong', { text: '100%' }),
        ]),
        el('div', { class: 'quick-effect-stat', dataset: { emphasis: 'true' } }, [
          el('span', { text: 'Resultado' }),
          el('output', { text: output }),
        ]),
      ]);
    }

    const outputDuration = focusedQuickOutputDuration(tool.id, job.options, job.info);
    return el('div', {
      class: 'quick-effect-summary',
      dataset: {
        quickEffectSummary: '',
        ...(outputDuration && outputDuration >= VIDEO_LOOP_LIMITS.maxDuration ? { status: 'warning' } : {}),
      },
    }, [
      el('div', { class: 'quick-effect-stat' }, [
        el('span', { text: 'Duración original' }),
        el('strong', { text: sourceDuration ? formatDuration(sourceDuration) : '—' }),
      ]),
      el('div', { class: 'quick-effect-stat', dataset: { emphasis: 'true' } }, [
        el('span', { text: 'Resultado estimado' }),
        el('output', { text: outputDuration ? formatDuration(outputDuration) : '—' }),
      ]),
    ]);
  }

  setQuickEffectLiveOption(job, key, value, { unmute = false, validationError = null } = {}) {
    job.options[key] = value;
    if (unmute) job.options.mute = false;
    if (!job.cropPreviewUnavailable) job.validationError = validationError;
    this.syncQuickDirty(job);
    const tool = this.quickToolFor(job);
    if (!tool || this.selectedId !== job.id) return;

    if (this.quickSourcePreview?.jobId === job.id) this.quickSourcePreviewFor(job, tool);
    const valueNode = this.dom.controls.querySelector(`[data-quick-effect-value="${key}"]`);
    if (valueNode) {
      if (key === 'volumeGain') valueNode.textContent = `${Math.round(Number(value) * 100)}%`;
      else if (key === 'loopCount') valueNode.textContent = `${value} veces`;
      else if (key === 'loopDuration') valueNode.textContent = Number.isFinite(value) ? formatDuration(value) : '—';
    }
    const summary = this.dom.controls.querySelector('[data-quick-effect-summary]');
    if (summary) summary.replaceWith(this.quickEffectSummary(job, tool));
    const description = this.quickTransformDescription(job, tool);
    const copy = this.dom.controls.querySelector('[data-quick-effect-description]');
    if (copy) copy.textContent = job.previewMode === 'result' && job.outputs?.length
      ? `${formatBytes(job.outputSize || 0)} · resultado anterior`
      : description;
    const resultTab = this.dom.controls.querySelector('[data-action="preview-result"]');
    if (resultTab && job.outputs?.length) resultTab.textContent = 'Resultado anterior';
    const effectSegments = Array.from(
      this.dom.controls.querySelectorAll(`[data-quick-option="${key}"][role="radio"]`)
    );
    let matchedSegment = false;
    for (const segment of effectSegments) {
      const active = String(segment.dataset.quickValue) === String(value);
      if (active) matchedSegment = true;
      segment.classList.toggle('is-active', active);
      segment.dataset.active = String(active);
      segment.setAttribute('aria-checked', String(active));
      segment.tabIndex = active ? 0 : -1;
    }
    if (!matchedSegment && effectSegments[0]) effectSegments[0].tabIndex = 0;
    const mute = this.dom.controls.querySelector('.quick-mute-toggle');
    if (mute && unmute) {
      mute.setAttribute('aria-pressed', 'false');
      mute.dataset.quickValue = 'false';
      const copy = mute.querySelector('small');
      if (copy) copy.textContent = 'Conservamos la pista con el nivel elegido.';
    }
    this.scheduleCommandPreview();
    this.paintQueue();
    this.updateQuickProgress(job);
    this.renderDetailActions(job, tool);
  }

  setQuickLoopMode(job, mode) {
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingQuickFocus = { key: 'loopMode', value: mode };
    }
    const sourceDuration = playableMediaDuration(job.info) || 0;
    job.options.loopMode = mode;
    if (mode === 'count') {
      const maximum = maxLoopCountFor(job.info) || 0;
      job.options.loopCount = Math.min(maximum, Math.max(2, Number(job.options.loopCount) || 2));
      job.options.loopDuration = null;
    } else {
      const current = Number(job.options.loopDuration);
      job.options.loopCount = null;
      job.options.loopDuration = Number.isFinite(current) && current > sourceDuration
        ? Math.min(VIDEO_LOOP_LIMITS.maxDuration, current)
        : Math.min(VIDEO_LOOP_LIMITS.maxDuration, sourceDuration * 2);
    }
    job.previewMode = 'source';
    job.validationError = null;
    this.syncQuickDirty(job);
    this.scheduleCommandPreview();
    this.paintQueue();
    if (this.selectedId === job.id) this.paintDetail();
  }

  quickVolumeControls(job) {
    const gain = normalizeVolumeGain(job.options.volumeGain) ?? VOLUME_GAIN_LIMITS.default;
    const stack = el('div', { class: 'quick-effect-stack' });
    stack.append(
      this.quickEffectRange(job, {
        key: 'volumeGain',
        label: 'Nivel de salida',
        description: 'Ajustá el volumen sin modificar el archivo original.',
        min: VOLUME_GAIN_LIMITS.min,
        max: VOLUME_GAIN_LIMITS.max,
        step: 0.05,
        value: gain,
        formatValue: (value) => `${Math.round(value * 100)}%`,
        scale: ['Silencio', '100%', '200%'],
        onInput: (value) => this.setQuickEffectLiveOption(job, 'volumeGain', value, { unmute: true }),
      }),
      this.quickEffectSegments(job, {
        key: 'volumeGain',
        label: 'Presets de volumen',
        columns: 3,
        items: VOLUME_GAIN_PRESETS.map((preset) => ({
          value: preset.value,
          label: preset.label,
          meta: preset.value === 1 ? 'Original' : null,
        })),
        onSelect: (value) => {
          job.options.mute = false;
          this.setJobOption(job, 'volumeGain', value);
        },
      }),
    );

    const muted = job.options.mute === true;
    const mute = el('button', {
      type: 'button',
      class: 'quick-mute-toggle',
      disabled: job.status === 'running' || job.status === 'queued',
      dataset: { quickOption: 'mute', quickValue: String(muted) },
      attrs: { 'aria-pressed': String(muted) },
    }, [
      el('span', {
        class: 'quick-mute-icon',
        html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3z" stroke-width="1.5" stroke-linejoin="round"/><path d="m14 8 4 4m0-4-4 4" stroke-width="1.5" stroke-linecap="round"/></svg>',
      }),
      el('span', {}, [
        el('strong', { text: 'Silenciar por completo' }),
        el('small', { text: muted ? 'La salida no tendrá pista de audio.' : 'Conservamos la pista con el nivel elegido.' }),
      ]),
    ]);
    mute.addEventListener('click', () => this.setJobOption(job, 'mute', !muted));
    stack.append(mute, this.quickEffectSummary(job, this.quickToolFor(job)));
    if (gain > 1 && !muted) stack.append(el('p', {
      class: 'quick-effect-note',
      dataset: { tone: 'warning' },
      text: 'La vista previa llega hasta 100%. La amplificación completa se aplica al crear el resultado y puede saturar audio que ya esté cerca del máximo.',
    }));
    return stack;
  }

  quickSpeedControls(job) {
    const items = PLAYBACK_RATE_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      meta: preset.value < 1 ? 'Más lento' : (preset.value > 1 ? 'Más rápido' : 'Original'),
    }));
    return el('div', { class: 'quick-effect-stack' }, [
      this.quickEffectSegments(job, {
        key: 'playbackRate',
        label: 'Velocidad de reproducción',
        items,
        columns: 3,
      }),
      this.quickEffectSummary(job, this.quickToolFor(job)),
      el('p', {
        class: 'quick-effect-note',
        text: job.info?.hasAudio
          ? 'La imagen y el sonido cambian juntos; conservamos el tono de las voces.'
          : 'La duración cambia sin inventar una pista de audio.',
      }),
    ]);
  }

  quickLoopControls(job) {
    const sourceDuration = playableMediaDuration(job.info) || 0;
    const maximumCount = maxLoopCountFor(job.info) || 0;
    const countAvailable = maximumCount >= VIDEO_LOOP_LIMITS.minCount;
    const mode = job.options.loopMode === 'duration' ? 'duration' : 'count';
    const stack = el('div', { class: 'quick-effect-stack' });
    if (sourceDuration >= VIDEO_LOOP_LIMITS.maxDuration) {
      stack.append(
        this.quickEffectSummary(job, this.quickToolFor(job)),
        el('p', {
          class: 'quick-effect-note',
          dataset: { tone: 'warning' },
          text: 'El original ya dura 30 minutos o más; repetirlo superaría el límite seguro de esta herramienta local.',
        }),
      );
      return stack;
    }
    stack.append(this.quickEffectSegments(job, {
      key: 'loopMode',
      label: 'Cómo definir la repetición',
      columns: 2,
      items: [
        { value: 'count', label: 'Repeticiones', meta: 'Veces totales', disabled: !countAvailable },
        { value: 'duration', label: 'Duración', meta: 'Tiempo final' },
      ],
      onSelect: (value) => this.setQuickLoopMode(job, value),
    }));

    if (mode === 'count' && countAvailable) {
      const count = Math.min(maximumCount, Math.max(2, Number(job.options.loopCount) || 2));
      stack.append(this.quickEffectRange(job, {
        key: 'loopCount',
        label: 'Cantidad total',
        description: 'Incluye la reproducción original.',
        min: VIDEO_LOOP_LIMITS.minCount,
        max: maximumCount,
        step: 1,
        value: count,
        formatValue: (value) => `${value} veces`,
        scale: ['2×', `${Math.max(2, Math.round((maximumCount + 2) / 2))}×`, `${maximumCount}×`],
        onInput: (value) => this.setQuickEffectLiveOption(job, 'loopCount', value),
      }));
      const presets = LOOP_COUNT_PRESETS.filter((value) => value <= maximumCount);
      if (presets.length > 1) stack.append(this.quickEffectSegments(job, {
        key: 'loopCount',
        label: 'Presets de repeticiones',
        columns: Math.min(4, presets.length),
        items: presets.map((value) => ({ value, label: `${value}×` })),
      }));
    } else {
      const current = Number(job.options.loopDuration);
      const fallback = Math.min(VIDEO_LOOP_LIMITS.maxDuration, sourceDuration * 2);
      const duration = Number.isFinite(current) && current > sourceDuration ? current : fallback;
      const input = el('input', {
        class: 'control-input',
        type: 'text',
        value: formatTimestamp(duration),
        placeholder: '00:01:00',
        spellcheck: false,
        disabled: job.status === 'running' || job.status === 'queued',
        dataset: { quickOption: 'loopDuration' },
        attrs: { inputmode: 'decimal', 'aria-label': 'Duración final del video repetido' },
      });
      const apply = () => {
        const value = parseTimestamp(input.value);
        const valid = Number.isFinite(value)
          && value > sourceDuration
          && value <= VIDEO_LOOP_LIMITS.maxDuration;
        this.setQuickEffectLiveOption(job, 'loopDuration', valid ? value : null, {
          validationError: valid
            ? null
            : 'La duración final debe superar al original y no puede pasar de 30 minutos.',
        });
      };
      // Validate while the person types. The lightweight updater keeps this
      // exact textbox in place, so feedback is immediate without stealing
      // focus or rebuilding the inspector on every character.
      input.addEventListener('input', apply);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
      });
      stack.append(el('div', { class: 'quick-effect-control' }, [
        el('div', { class: 'quick-effect-control-head' }, [
          el('div', { class: 'quick-effect-control-copy' }, [
            el('strong', { text: 'Duración final' }),
            el('span', { text: 'Se corta la última repetición exactamente en este punto.' }),
          ]),
          el('output', {
            class: 'quick-effect-value',
            text: formatDuration(duration),
            dataset: { quickEffectValue: 'loopDuration' },
          }),
        ]),
        input,
      ]));
      const candidates = [...new Set([
        sourceDuration * 2,
        30, 60, 120, 300, 600, 900, VIDEO_LOOP_LIMITS.maxDuration,
      ].map((value) => Math.round(value * 1000) / 1000))]
        .filter((value) => value > sourceDuration && value <= VIDEO_LOOP_LIMITS.maxDuration)
        .sort((left, right) => left - right)
        .slice(0, 8);
      if (candidates.length) stack.append(this.quickEffectSegments(job, {
        key: 'loopDuration',
        label: 'Presets de duración final',
        columns: Math.min(4, candidates.length),
        items: candidates.map((value) => ({ value, label: formatDuration(value) })),
      }));
    }

    stack.append(
      this.quickEffectSummary(job, this.quickToolFor(job)),
      el('p', {
        class: 'quick-effect-note',
        text: 'La vista previa se repite de forma continua; el archivo final respeta la cantidad o duración elegida y el límite local de 30 minutos.',
      }),
    );
    return stack;
  }

  quickEffectControls(job, tool) {
    if (tool.focus === 'volume') return this.quickVolumeControls(job);
    if (tool.focus === 'speed') return this.quickSpeedControls(job);
    return this.quickLoopControls(job);
  }

  renderQuickEffectControls(job, tool) {
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
    if (!hasInfo) previewContent.append(this.quickProcessingCard(job));
    else if (showingResult) {
      this.pauseQuickSourcePreview();
      previewContent.append(this.quickOutputPreviewFor(job));
    } else {
      this.pauseQuickOutputPreview();
      this.releaseCropper();
      previewContent.append(this.quickSourcePreviewFor(job, tool));
    }

    const description = hasInfo ? this.quickTransformDescription(job, tool) : 'Preparando la vista previa…';
    const canvas = el('section', { class: 'quick-canvas' }, [
      el('header', { class: 'quick-preview-head' }, [
        el('div', { class: 'quick-preview-copy' }, [
          el('strong', { text: job.name }),
          el('span', {
            text: showingResult ? `${formatBytes(job.outputSize || 0)} · resultado procesado` : description,
            dataset: { quickEffectDescription: '' },
          }),
          el('small', { text: 'Local · el archivo no sale de este dispositivo' }),
        ]),
        el('div', { class: 'quick-preview-switch', attrs: { role: 'tablist', 'aria-label': 'Vista previa' } }, [
          sourceTab,
          resultTab,
        ]),
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
        el('p', { text: 'Cuando termine el análisis vas a poder configurar el efecto y revisar la salida.' }),
        this.quickProcessingCard(job),
      ]));
    } else {
      const titles = {
        volume: ['Volumen', 'Ajustá el nivel o quitá el sonido por completo.'],
        speed: ['Velocidad', 'Elegí un ritmo y revisá la nueva duración antes de procesar.'],
        loop: ['Repetición', 'Definí cuántas veces se reproduce o cuánto debe durar.'],
      };
      const [title, copy] = titles[tool.focus];
      inspector.append(
        el('section', { class: 'quick-inspector-section' }, [
          el('h3', { text: title }),
          el('p', { text: copy }),
          this.quickEffectControls(job, tool),
        ]),
        this.quickOutputSection(job, { includeMute: tool.focus !== 'volume' }),
        el('section', { class: 'quick-inspector-section' }, [this.quickProcessingCard(job)]),
      );
    }

    container.append(el('div', {
      class: 'quick-tool-layout',
      attrs: { 'aria-busy': String(job.status === 'probing' || job.status === 'queued' || job.status === 'running') },
    }, [canvas, inspector]));
  }

  quickDimensionSummary(job) {
    const dimensions = this.quickTransformDimensions(job);
    if (!dimensions) return null;
    return el('div', { class: 'quick-dimension-summary' }, [
      el('div', {}, [
        el('span', { text: 'Original' }),
        el('strong', {
          text: `${dimensions.source.width}×${dimensions.source.height}`,
          dataset: { quickDimension: 'source' },
        }),
      ]),
      el('span', { class: 'quick-dimension-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
      el('div', {}, [
        el('span', { text: 'Resultado estimado' }),
        el('output', {
          text: `${dimensions.output.width}×${dimensions.output.height}`,
          dataset: { quickDimension: 'output' },
        }),
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
      this.cropper?.control.setDisabled(true);
      previewContent.append(this.quickOutputPreviewFor(job));
    } else {
      this.pauseQuickOutputPreview();
      if (tool.focus === 'crop') {
        this.releaseQuickSourcePreview();
        previewContent.append(this.cropperFor(job));
      } else {
        this.releaseCropper();
        previewContent.append(this.quickSourcePreviewFor(job, tool));
      }
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

  updateQuickCropSummary(job) {
    const tool = this.quickToolFor(job);
    if (!job?.info || this.selectedId !== job.id || tool?.focus !== 'crop') return;
    const dimensions = this.quickTransformDimensions(job);
    if (dimensions) {
      const source = this.dom.controls.querySelector('[data-quick-dimension="source"]');
      const output = this.dom.controls.querySelector('[data-quick-dimension="output"]');
      if (source) source.textContent = `${dimensions.source.width}×${dimensions.source.height}`;
      if (output) output.textContent = `${dimensions.output.width}×${dimensions.output.height}`;
    }
    const resultTab = this.dom.controls.querySelector('[data-action="preview-result"]');
    if (resultTab) {
      const resultAvailable = Boolean(job.outputs?.length);
      resultTab.textContent = resultAvailable && (job.dirtySinceOutput || job.status !== 'done')
        ? 'Resultado anterior'
        : 'Resultado';
    }
    this.updateQuickProgress(job);
    this.renderDetailActions(job, tool);
  }

  updateQuickProgress(job) {
    if (this.selectedId !== job.id || !this.quickToolFor(job)) return;
    const card = this.dom.controls.querySelector('.quick-processing-card');
    if (card) {
      const copy = this.quickStatusCopy(job);
      card.dataset.status = this.quickVisualStatus(job);
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

  setCropAspect(job, value) {
    const rect = cropRectForAspect(job.info, value, job.options);
    if (!rect) return;
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingQuickFocus = { key: 'cropAspect', value: String(value) };
    }
    job.options.cropAspect = value;
    Object.assign(job.options, rect);
    job.previewMode = 'source';
    if (!job.cropPreviewUnavailable) job.validationError = null;
    this.syncQuickDirty(job);

    const preset = CROP_ASPECT_PRESETS.find((item) => item.id === value);
    this.cropper?.control.setAspectRatio(preset?.ratio || null);
    this.cropper?.control.setRect(this.cropperRect(job));
    this.scheduleCommandPreview();
    this.paintQueue();
    if (this.selectedId === job.id) this.paintDetail();
  }

  setJobOption(job, key, value) {
    if (this.dom.controls.contains(document.activeElement)) {
      job.pendingQuickFocus = { key, value: String(value) };
    }
    job.options[key] = value;
    job.previewMode = 'source';
    if (!job.cropPreviewUnavailable) job.validationError = null;
    this.syncQuickDirty(job);
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
    if (this.isAddAudioJob(job)) {
      const validation = this.addAudioValidation(job);
      if (!validation.ok) {
        this.dom.commandText.textContent = validation.message;
        this.dom.commandText.dataset.invalid = 'true';
        return;
      }
      try {
        const plan = buildAddAudioPlan(addAudioProjectSource(job), job.options);
        this.dom.commandText.textContent = planToCommand(plan);
        this.dom.commandText.dataset.invalid = 'false';
      } catch (error) {
        this.dom.commandText.textContent = error.message;
        this.dom.commandText.dataset.invalid = 'true';
      }
      return;
    }
    if (this.isMergeJob(job)) {
      const validation = validateMergeClips(job.clips);
      if (!validation.ok) {
        this.dom.commandText.textContent = validation.error;
        this.dom.commandText.dataset.invalid = 'true';
        return;
      }
      try {
        const plan = buildJoinVideosPlan(
          job.clips.map((clip) => ({ name: clip.name, info: clip.info })),
          job.options
        );
        this.dom.commandText.textContent = planToCommand(plan);
        this.dom.commandText.dataset.invalid = 'false';
      } catch (error) {
        this.dom.commandText.textContent = error.message;
        this.dom.commandText.dataset.invalid = 'true';
      }
      return;
    }
    const quickTool = this.quickToolFor(job);
    if (quickTool && !this.quickJobRunnable(job, quickTool)) {
      this.dom.commandText.textContent = this.quickInvalidMessage(quickTool, job);
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
    if (tool.focus === 'crop' && job.cropPreviewUnavailable) {
      job.validationError = 'Este navegador no puede mostrar este formato. Convertí el video a MP4 y después volvé a recortarlo.';
      if (notify) this.toast(job.validationError, { kind: 'error', duration: 6500 });
      this.paintDetail();
      return false;
    }

    const preflight = this.quickEffectPreflight(job, tool);
    if (preflight && !preflight.ok) {
      job.validationError = preflight.code === 'invalid-effect'
        ? this.quickInvalidMessage(tool, job)
        : preflight.message;
      if (notify) this.toast(job.validationError, { kind: 'error', duration: 6500 });
      this.paintDetail();
      return false;
    }

    const normalised = tool.focus === 'trim'
      ? trimOptionsForRun(job.info, job.options)
      : normalizeFocusedQuickOptions(tool.id, job.options, job.info);
    if (!normalised) {
      job.validationError = this.quickInvalidMessage(tool, job);
      if (notify) this.toast(job.validationError, { kind: 'error', duration: 6500 });
      this.paintDetail();
      return false;
    }

    // Write exactly the validated values into the command options. Focused
    // tools deliberately own only their primary transformation, so unrelated
    // settings from a previous generic conversion cannot leak into the result.
    Object.assign(job.options, normalised);
    if (tool.focus !== 'crop') {
      job.options.cropAspect = 'free';
      job.options.cropX = null;
      job.options.cropY = null;
      job.options.cropWidth = null;
      job.options.cropHeight = null;
    }
    if (tool.focus === 'rotate') job.options.flip = 'none';
    if (tool.focus === 'flip') job.options.rotate = 0;
    if (tool.focus === 'resize') {
      job.options.rotate = 0;
      job.options.flip = 'none';
    }
    if (tool.focus === 'crop') {
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
      if (!this.jobPendingForRun(job)) continue;
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
    if (
      !this.jobs.includes(job)
      || !job.info
      || job.needsRelink
      || this.missingProjectAssets(job).length
      || !this.jobPendingForRun(job)
    ) return;
    const valid = this.isAddAudioJob(job)
      ? this.validateAddAudioJob(job, { notify: job.status !== 'queued' })
      : (this.isMergeJob(job)
        ? this.validateMergeJob(job, { notify: job.status !== 'queued' })
        : this.validateQuickJob(job, { notify: job.status !== 'queued' }));
    if (!valid) {
      if (job.status === 'queued') job.status = 'ready';
      this.paintQueue();
      this.paintDetail();
      return;
    }

    let plan;
    let mergeSnapshot = null;
    let addAudioSnapshot = null;
    try {
      if (this.isAddAudioJob(job)) {
        addAudioSnapshot = job.pendingAddAudioSnapshot || createAddAudioSnapshot(job);
        const retainedBytes = Number(job.outputSize) || 0;
        const validation = validateAddAudioProject(addAudioSnapshot, addAudioSnapshot.options);
        if (!validation.ok) throw new Error(validation.message);
        if (validation.estimatedWorkingBytes + retainedBytes > ADD_AUDIO_LIMITS.maxWorkingBytes) {
          throw new Error('El resultado anterior y esta nueva exportación superarían el límite seguro de memoria. Descargá el anterior y quitá el proyecto antes de volver a procesar.');
        }
        plan = buildAddAudioPlan(addAudioSnapshot.source, addAudioSnapshot.options);
      } else if (this.isMergeJob(job)) {
        mergeSnapshot = job.pendingMergeSnapshot || createMergeSnapshot(job);
        plan = buildJoinVideosPlan(mergeSnapshot.source.inputs, mergeSnapshot.options);
      } else {
        plan = buildPlan({ name: job.name, info: job.info }, job.operation, job.options);
      }
    } catch (error) {
      delete job.pendingMergeSnapshot;
      delete job.pendingAddAudioSnapshot;
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
    if (this.quickToolFor(job) || this.isMergeJob(job) || this.isAddAudioJob(job)) {
      job.previewMode = 'source';
      if (this.quickOutputPreview?.jobId === job.id) this.releaseQuickOutputPreview();
    }
    this.runningId = job.id;
    const startedAt = performance.now();
    this.scheduleProjectSave({ immediate: true });
    this.paintQueue();
    this.paintDetail();

    const running = this.engine.start(plan, addAudioSnapshot?.files || mergeSnapshot?.files || job.file, {
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
        this.updateMergeProgress(job);
        this.updateAddAudioProgress(job);
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
      if (this.isAddAudioJob(job)) {
        Object.assign(job, markAddAudioExported(job, addAudioSnapshot.revision));
      } else if (this.isMergeJob(job)) {
        Object.assign(job, markMergeExported(job, mergeSnapshot.revision));
      } else {
        if (this.quickToolFor(job)) job.quickExportSignature = planToCommand(plan);
        job.dirtySinceOutput = false;
      }
      if (this.quickToolFor(job) || this.isMergeJob(job) || this.isAddAudioJob(job)) job.previewMode = 'result';

      // The encoded bytes are useful only if the matching manifest commits.
      // Force a save even when a same-sized re-export has an identical cheap
      // signature; the Blob identity and contents may still be different.
      this.scheduleProjectSave({ immediate: true, force: true });

      const seconds = (performance.now() - startedAt) / 1000;
      this.appendLog(`Finished in ${formatDuration(seconds)} · ${formatBytes(job.outputSize)}`);
    } catch (error) {
      job.status = error.cancelled ? 'cancelled' : 'failed';
      job.error = error.cancelled ? 'Cancelled' : error.message;
      if (!error.cancelled) this.appendLog(`Failed: ${error.message}`);
    } finally {
      delete job.pendingMergeSnapshot;
      delete job.pendingAddAudioSnapshot;
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
    const done = this.jobs.filter((job) => this.jobIsSettledDone(job) && job.outputs?.length);
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
      // Safari may put the page in BFCache and later evict it without another
      // unload event. Promote the pending edit even when `persisted` is true;
      // only media teardown must wait for a definitive unload.
      this.scheduleProjectSave({ immediate: true });
      // A page entering the back/forward cache keeps its DOM alive. Destroying
      // media here would restore a timeline whose listeners and blob URL are
      // gone when the user comes back.
      if (event.persisted) return;
      this.releaseQuickSourcePreview();
      this.releaseQuickOutputPreview();
      this.releasePreview();
      this.releaseScrubber();
      this.releaseCropper();
      this.releaseMergeSourcePreview();
      this.releaseMergeSequence();
      this.releaseAudioMixPreview();
      this.releaseAudioMixTimeline();
      this.clearPickerIntent();
    });
    on(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      prefs.flush();
      this.scheduleProjectSave({ immediate: true });
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
    on(this.dom.fileInput, 'cancel', () => {
      this.clearPickerIntent();
    });

    // A conversion in flight is minutes of the user's processor time; losing it
    // to a stray ⌘W deserves at least a question.
    on(window, 'beforeunload', (event) => {
      if (!this.runningId && this.projectStorageState !== 'saving') return;
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
        if (job && (job.needsRelink || this.missingProjectAssets(job).length)) this.openRelinkPicker(job);
        else if (this.isMergeJob(job)) this.openMergePicker(job);
        else if (this.isAddAudioJob(job)) this.openAddAudioPicker(job, 'audio');
        else this.dom.fileInput.click();
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
      case 'request-persistent-storage':
        this.requestPersistentProjectStorage();
        return true;
      case 'clear-local-projects':
        if (this.dom.settings.open) this.dom.settings.close();
        this.clearLocalProjects();
        return true;
      case 'relink-project':
        if (job) this.openRelinkPicker(job);
        return true;
      case 'start-all':
        this.enqueue(() => this.runQueue());
        return true;
      case 'start-one':
        if (job && !['probing', 'queued', 'running'].includes(job.status)) {
          const valid = this.isAddAudioJob(job)
            ? this.validateAddAudioJob(job)
            : (this.isMergeJob(job) ? this.validateMergeJob(job) : this.validateQuickJob(job));
          if (!valid) return true;
          // Reset here rather than only inside `runJob`: the run is queued
          // behind whatever else is using the engine, and until it starts the
          // row would otherwise still show the previous result's full bar.
          job.progress = 0;
          job.remaining = null;
          job.status = 'queued';
          job.previewMode = 'source';
          if (this.isMergeJob(job)) job.pendingMergeSnapshot = createMergeSnapshot(job);
          if (this.isAddAudioJob(job)) job.pendingAddAudioSnapshot = createAddAudioSnapshot(job);
          this.releaseQuickOutputPreview();
          this.scheduleProjectSave({ immediate: true });
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
        this.clearFinishedProjects();
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
      if (this.selected && (this.selected.needsRelink || this.missingProjectAssets(this.selected).length)) this.openRelinkPicker(this.selected);
      else if (this.isMergeJob(this.selected)) this.openMergePicker(this.selected);
      else if (this.isAddAudioJob(this.selected)) this.openAddAudioPicker(this.selected, 'audio');
      else this.dom.fileInput.click();
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
      ? `FFmpeg ${details.capabilities.version}, ${details.threads ? 'multihilo' : 'un solo hilo'}, ` +
        `con ${details.capabilities.encoders.length} codificadores incluidos.`
      : 'FFmpeg todavía está iniciando.';

    // Isolation is necessary for the threaded core but not sufficient: the
    // threaded build also has to have been vendored. Saying "isolated, so it
    // is multi-threaded" would be wrong on a checkout that only has the
    // single-threaded one, which is every default checkout.
    const { crossOriginIsolated, sharedArrayBuffer } = isolationStatus();
    const isolated = crossOriginIsolated && sharedArrayBuffer;
    $('#settings-isolation').textContent = details?.threads
      ? 'La página está aislada entre orígenes y usa el motor multihilo más rápido.'
      : isolated
        ? 'La página está aislada, pero esta instalación sólo incluye el motor de un hilo.'
        : 'La página usa el motor de un hilo porque GitHub Pages no puede enviar los encabezados necesarios para el modo multihilo.';

    this.syncStorageSettings();
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
