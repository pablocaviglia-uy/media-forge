import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';

function baseApp() {
  const app = Object.create(App.prototype);
  app.jobs = [];
  app.selectedId = null;
  app.projectsHydrated = false;
  app.projectSaveTimer = null;
  app.projectSaveDeadline = null;
  app.projectSaveRevision = 0;
  app.projectDeleteRevision = 0;
  app.projectSaveChain = Promise.resolve();
  app.projectStorageRevision = null;
  app.projectStorageState = 'saving';
  app.projectStorageIssue = null;
  app.projectStorageUnavailable = false;
  app.projectStorageReadOnly = false;
  app.projectExternalChange = false;
  app.lastScheduledProjectSignature = null;
  app.ignoreProjectBroadcast = false;
  app.chain = Promise.resolve();
  app.dom = {
    statusStorage: { dataset: {}, textContent: '' },
    fileInput: { accept: '', multiple: false, click() {} },
  };
  app.toasts = [];
  app.toast = (message) => app.toasts.push(message);
  app.paintQueue = () => {};
  app.paintDetail = () => {};
  app.enqueue = (task) => {
    app.enqueued ||= [];
    app.enqueued.push(task);
    return Promise.resolve();
  };
  return app;
}

function simpleJob(overrides = {}) {
  const file = new File(['source'], 'clip.mp4', { type: 'video/mp4', lastModified: 42 });
  return {
    id: 'job-persisted',
    file,
    name: file.name,
    size: file.size,
    info: { hasVideo: true, hasAudio: false, duration: 2, video: { width: 16, height: 16 } },
    status: 'ready',
    operation: 'convert',
    options: { format: 'mp4-h264' },
    progress: 0,
    speed: null,
    remaining: null,
    outputs: null,
    error: null,
    log: [],
    ...overrides,
  };
}

test('boot does not bind file/drop intents until workspace hydration settles', async () => {
  const app = baseApp();
  let finishHydration;
  const hydration = new Promise((resolve) => { finishHydration = resolve; });
  const calls = [];
  app.applyPreferences = () => {};
  app.setProjectStorageState = () => {};
  app.renderQueue = () => {};
  app.renderDetail = () => {};
  app.updateOfflineBadge = () => {};
  app.restoreLocalProjects = () => hydration;
  app.bindGlobalEvents = () => calls.push('global');
  app.bindDropZone = () => calls.push('drop');
  app.bindSettings = () => calls.push('settings');
  app.bindConfirmSheet = () => calls.push('confirm');
  app.bindResizers = () => calls.push('resizers');
  app.loadEngine = () => calls.push('engine');

  const starting = app.start();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishHydration();
  await starting;

  assert.deepEqual(calls, ['global', 'drop', 'settings', 'confirm', 'resizers', 'engine']);
});

test('restore hydrates the selected workspace and treats external-tab writes as a conflict', async () => {
  const app = baseApp();
  let listener = null;
  const restored = simpleJob({ status: 'done', outputs: [{ name: 'output.mp4', blob: new Blob(['out']) }] });
  app.projectStore = {
    async open() {},
    subscribe(callback) { listener = callback; return () => {}; },
    async loadWorkspace() {
      return { jobs: [restored], selectedId: restored.id, storageRevision: 7, issues: [] };
    },
  };

  await app.restoreLocalProjects();

  assert.equal(app.projectsHydrated, true);
  assert.equal(app.jobs[0], restored);
  assert.equal(app.selectedId, restored.id);
  assert.equal(app.projectStorageRevision, 7);
  assert.equal(restored.previewMode, 'result');
  assert.equal(app.dom.statusStorage.dataset.state, 'saved');

  listener({ local: true, storageRevision: 8 });
  assert.equal(app.projectExternalChange, false);
  listener({ local: false, storageRevision: 8 });
  assert.equal(app.projectExternalChange, true);
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
});

test('lossy or future records freeze automatic writes until explicit clear', async () => {
  const app = baseApp();
  let saves = 0;
  let deletes = 0;
  app.projectStore = {
    async open() {},
    subscribe() { return () => {}; },
    async loadWorkspace() {
      return {
        jobs: [simpleJob()],
        selectedId: 'job-persisted',
        storageRevision: 6,
        issues: [{ code: 'newer-schema', message: 'future record' }],
      };
    },
    async saveWorkspace() { saves += 1; },
    async deleteProject() { deletes += 1; },
  };

  await app.restoreLocalProjects();

  assert.equal(app.projectStorageReadOnly, true);
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
  app.jobs[0].options.quality = 'high';
  app.scheduleProjectSave({ immediate: true, force: true });
  await app.deletePersistedProject(app.jobs[0].id);
  assert.equal(saves, 0);
  assert.equal(deletes, 0);
  assert.match(app.toasts.join(' '), /No los modificaremos/);
  app.syncStorageSettings = () => {};
  app.setProjectStorageState('off');
  app.onProjectPersistencePreference();
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
});

test('a restricted browser degrades to session-only without retrying every edit', async () => {
  const app = baseApp();
  const unavailable = new Error('IndexedDB disabled');
  unavailable.code = 'storage-unavailable';
  app.projectStore = {
    async open() { throw unavailable; },
  };

  await app.restoreLocalProjects();

  assert.equal(app.projectsHydrated, true);
  assert.equal(app.projectStorageUnavailable, true);
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
  const revision = app.projectSaveRevision;
  app.jobs = [simpleJob()];
  app.scheduleProjectSave({ immediate: true, force: true });
  await app.projectSaveChain;
  assert.equal(app.projectSaveRevision, revision);
  assert.equal(app.toasts.length, 1);
});

test('retry adopts the durable revision and merges stored projects before saving', async () => {
  const app = baseApp();
  const unavailable = new Error('temporary IndexedDB failure');
  unavailable.code = 'storage-unavailable';
  let opens = 0;
  let saved = null;
  const durable = simpleJob({ id: 'durable-job', name: 'durable.mp4' });
  app.projectStore = {
    async open() {
      opens += 1;
      if (opens === 1) throw unavailable;
    },
    subscribe() { return () => {}; },
    async loadWorkspace() {
      return { jobs: [durable], selectedId: durable.id, storageRevision: 12, issues: [] };
    },
    async saveWorkspace(jobs, options) {
      saved = { jobs: [...jobs], options };
      return { saved: true, storageRevision: 13, issues: [] };
    },
  };

  await app.restoreLocalProjects();
  const session = simpleJob({ id: 'session-job', name: 'session.mp4' });
  app.jobs = [session];
  app.selectedId = session.id;
  await app.onProjectPersistencePreference();

  assert.deepEqual(app.jobs.map((job) => job.id), ['session-job', 'durable-job']);
  assert.deepEqual(saved.jobs.map((job) => job.id), ['session-job', 'durable-job']);
  assert.equal(saved.options.expectedStorageRevision, 12);
  assert.equal(app.projectStorageRevision, 13);
  assert.equal(app.projectStorageUnavailable, false);
});

test('restored Quick output is rechecked against its exported command signature', () => {
  const app = baseApp();
  const job = simpleJob({
    forgeToolId: 'video-speed',
    status: 'done',
    outputs: [{ name: 'output.mp4', blob: new Blob(['old']) }],
    quickExportSignature: 'old-command',
    dirtySinceOutput: false,
  });
  app.jobs = [job];
  app.quickPlanSignature = () => 'edited-command';

  app.resumeRestoredProject(job);

  assert.equal(job.previewMode, 'result');
  assert.equal(job.dirtySinceOutput, true);
  assert.equal(app.jobIsSettledDone(job), false);
});

test('durable signatures ignore conversion telemetry but include edits and selection', () => {
  const app = baseApp();
  app.jobs = [simpleJob()];
  app.selectedId = app.jobs[0].id;
  const first = app.projectStateSignature();

  app.jobs[0].progress = 0.7;
  app.jobs[0].speed = 2.5;
  app.jobs[0].remaining = 1;
  app.jobs[0].log.push('frame=1');
  assert.equal(app.projectStateSignature(), first);

  app.jobs[0].options.quality = 'high';
  assert.notEqual(app.projectStateSignature(), first);
  const edited = app.projectStateSignature();
  app.selectedId = null;
  assert.notEqual(app.projectStateSignature(), edited);
});

test('an immediate commit uses revision CAS and reports metadata-only fallback', async () => {
  const app = baseApp();
  app.projectsHydrated = true;
  app.projectStorageRevision = 3;
  app.jobs = [simpleJob()];
  app.selectedId = app.jobs[0].id;
  let saved = null;
  app.projectStore = {
    async saveWorkspace(jobs, options) {
      saved = { jobs, options };
      return { saved: true, storageRevision: 4, metadataOnly: true, issues: [{ code: 'quota-metadata-only' }] };
    },
  };

  app.scheduleProjectSave({ immediate: true, force: true });
  await app.projectSaveChain;

  assert.equal(saved.jobs, app.jobs);
  assert.deepEqual(saved.options, {
    selectedId: 'job-persisted',
    expectedStorageRevision: 3,
    allowMetadataFallback: true,
  });
  assert.equal(app.projectStorageRevision, 4);
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
  assert.match(app.toasts.join(' '), /reconectarlos/);
});

test('new source files start a durable save before probing begins', () => {
  const app = baseApp();
  const saves = [];
  app.scheduleProjectSave = (options) => saves.push(options);
  const source = new File(['video-source'], 'new-source.mp4', {
    type: 'video/mp4',
    lastModified: 123,
  });

  app.addFiles([source]);

  assert.deepEqual(saves, [{ immediate: true, force: true }]);
  assert.equal(app.jobs.length, 1);
  assert.equal(app.jobs[0].file, source);
  assert.equal(app.enqueued.length, 1);
});

test('an immediate flush promotes an identical debounced edit before unload', () => {
  const app = baseApp();
  app.projectsHydrated = true;
  app.jobs = [simpleJob()];
  app.selectedId = app.jobs[0].id;
  const commits = [];
  app.commitProjectSave = (revision) => commits.push(revision);

  app.scheduleProjectSave();
  assert.ok(app.projectSaveTimer);
  assert.ok(app.projectSaveDeadline);
  app.scheduleProjectSave({ immediate: true });

  assert.deepEqual(commits, [1]);
  assert.equal(app.projectSaveTimer, null);
  assert.equal(app.projectSaveDeadline, null);
});

test('project deletion uses revision CAS and a conflict freezes later autosaves', async () => {
  const app = baseApp();
  app.projectsHydrated = true;
  app.projectStorageRevision = 9;
  let options = null;
  app.projectStore = {
    async deleteProject(_id, passed) {
      options = passed;
      const error = new Error('stale tab');
      error.code = 'conflict';
      throw error;
    },
    async saveWorkspace() {
      throw new Error('must not save after a conflict');
    },
  };

  await app.deletePersistedProject('job-persisted');

  assert.deepEqual(options, { expectedStorageRevision: 9 });
  assert.equal(app.projectExternalChange, true);
  assert.equal(app.dom.statusStorage.dataset.state, 'error');
  app.commitProjectSave();
  await app.projectSaveChain;
  assert.equal(app.projectStorageIssue.code, 'conflict');
});

test('clear waits for an in-flight save before deleting durable bytes', async () => {
  const app = baseApp();
  app.projectsHydrated = true;
  app.projectStorageRevision = 4;
  app.jobs = [simpleJob()];
  app.selectedId = app.jobs[0].id;
  app.confirm = async () => true;
  app.runningId = null;
  for (const method of [
    'releaseQuickSourcePreview', 'releaseQuickOutputPreview', 'releasePreview',
    'releaseScrubber', 'releaseCropper', 'releaseMergeSourcePreview',
    'releaseMergeSequence', 'releaseAudioMixPreview', 'releaseAudioMixTimeline',
    'clearPickerIntent', 'syncStorageSettings',
  ]) app[method] = () => {};

  let finishSave;
  app.projectSaveChain = new Promise((resolve) => { finishSave = resolve; });
  let clearOptions = null;
  app.projectStore = {
    async clear(options) {
      clearOptions = options;
      return { storageRevision: 5 };
    },
  };

  const clearing = app.clearLocalProjects();
  await Promise.resolve();
  assert.equal(clearOptions, null);
  finishSave();
  await clearing;

  assert.deepEqual(clearOptions, { expectedStorageRevision: 4 });
  assert.deepEqual(app.jobs, []);
  assert.equal(app.projectStorageRevision, 5);
});

test('removing saved results and clearing finished projects require confirmation', async () => {
  const app = baseApp();
  app.projectsHydrated = true;
  const first = simpleJob({
    id: 'finished-a',
    status: 'done',
    outputs: [{ name: 'a.mp4', blob: new Blob(['a']) }],
  });
  const second = simpleJob({
    id: 'finished-b',
    status: 'done',
    outputs: [{ name: 'b.mp4', blob: new Blob(['b']) }],
  });
  app.jobs = [first, second];
  app.selectedId = first.id;
  app.jobIsSettledDone = () => true;
  const prompts = [];
  let allow = false;
  app.confirm = async (options) => {
    prompts.push(options);
    return allow;
  };
  const deleted = [];
  app.deletePersistedProject = (id) => deleted.push(id);

  await app.removeJob(first);
  assert.deepEqual(app.jobs, [first, second]);
  assert.equal(deleted.length, 0);
  assert.match(prompts[0].title, /resultado/);

  allow = true;
  await app.clearFinishedProjects();
  assert.deepEqual(app.jobs, []);
  assert.deepEqual(deleted, ['finished-a', 'finished-b']);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].message, /resultados guardados/);
});

test('removing a persisted draft also requires confirmation', async () => {
  const app = baseApp();
  const draft = simpleJob();
  app.projectsHydrated = true;
  app.jobs = [draft];
  app.selectedId = draft.id;
  let prompt = null;
  app.confirm = async (options) => {
    prompt = options;
    return false;
  };

  await app.removeJob(draft);

  assert.deepEqual(app.jobs, [draft]);
  assert.match(prompt.title, /proyecto/);
  assert.match(prompt.message, /proyecto en proceso/);
});

test('removing a draft while persistence is off leaves its durable copy untouched', async () => {
  const app = baseApp();
  const draft = simpleJob();
  app.projectsHydrated = true;
  app.jobs = [draft];
  app.selectedId = draft.id;
  const deleted = [];
  app.deletePersistedProject = (id) => deleted.push(id);
  app.confirm = async () => {
    throw new Error('an in-memory draft needs no destructive confirmation');
  };
  app.projectPersistenceEnabled = () => false;

  await app.removeJob(draft);

  assert.deepEqual(app.jobs, []);
  assert.deepEqual(deleted, []);
});

test('relink restores a matching source without losing project options or outputs', () => {
  const app = baseApp();
  const replacement = new File(['source'], 'clip.mp4', { type: 'video/mp4', lastModified: 42 });
  const previousOutput = { name: 'output.mp4', blob: new Blob(['old']) };
  const job = simpleJob({
    file: null,
    info: { hasVideo: true, duration: 2 },
    needsRelink: true,
    status: 'failed',
    outputs: [previousOutput],
    lastModified: 42,
  });
  app.jobs = [job];
  app.selectedId = job.id;
  let forced = null;
  app.scheduleProjectSave = (options) => { forced = options; };

  app.relinkProject(job, [replacement]);

  assert.equal(job.file, replacement);
  assert.equal(job.info, null);
  assert.equal(job.status, 'probing');
  assert.equal(job.needsRelink, undefined);
  assert.equal(job.outputs[0], previousOutput);
  assert.equal(job.options.format, 'mp4-h264');
  assert.deepEqual(forced, { immediate: true, force: true });
  assert.equal(app.enqueued.length, 1);
});

test('relink refuses a different file instead of silently changing the project source', () => {
  const app = baseApp();
  const job = simpleJob({ file: null, needsRelink: true, lastModified: 42 });
  app.jobs = [job];

  app.relinkProject(job, [new File(['different-content'], 'other.mp4', { lastModified: 99 })]);

  assert.equal(job.file, null);
  assert.match(app.toasts.join(' '), /no coincide/);
  assert.equal(app.enqueued, undefined);
});

test('folder imports preserve modification time and relink by basename', async () => {
  const app = baseApp();
  const original = new File(['source'], 'clip.mp4', {
    type: 'video/mp4',
    lastModified: 777,
  });
  let readCount = 0;
  const directory = {
    isFile: false,
    name: 'shoot',
    createReader() {
      return {
        readEntries(resolve) {
          resolve(readCount++ === 0 ? [{
            isFile: true,
            file(resolveFile) { resolveFile(original); },
          }] : []);
        },
      };
    },
  };
  const collected = await app.collectFiles({
    items: [{ webkitGetAsEntry: () => directory }],
    files: [],
  });

  assert.equal(collected[0].name, 'shoot/clip.mp4');
  assert.equal(collected[0].lastModified, 777);

  const job = simpleJob({
    file: null,
    name: 'shoot/clip.mp4',
    size: original.size,
    lastModified: 777,
    needsRelink: true,
  });
  app.jobs = [job];
  app.scheduleProjectSave = () => {};
  const pickedAgain = new File(['source'], 'clip.mp4', {
    type: 'video/mp4',
    lastModified: 999,
  });

  app.relinkProject(job, [pickedAgain]);

  assert.equal(job.file, pickedAgain);
  assert.equal(job.needsRelink, undefined);
});
