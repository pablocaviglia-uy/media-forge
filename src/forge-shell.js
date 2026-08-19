/**
 * Forge OS shell.
 *
 * The conversion controller remains the source of truth for files and jobs.
 * This module adds the product-level launcher around it and translates a
 * public tool intent into the closest preset the current engine can execute.
 * Remove `?ui=legacy` from the URL to enable it; no second app is booted.
 */

import { TOOL_CATALOG } from './catalog/tool-catalog.js';
import { prefs } from './storage/prefs.js';

if (document.documentElement.dataset.interface === 'forge') {
  const app = window.mediaForge;
  const launcher = document.querySelector('#tool-launcher');
  const queryInput = document.querySelector('#forge-launcher-query');
  const toolList = document.querySelector('#forge-tool-list');
  const resultSummary = document.querySelector('#forge-result-summary');
  const intentForm = document.querySelector('#forge-intent-form');
  const intentInput = document.querySelector('#forge-intent');
  const fileInput = document.querySelector('#file-input');
  const activeToolLabel = document.querySelector('#forge-active-tool');

  const WORKSPACE_LABELS = {
    quick: 'Herramientas rápidas',
    studio: 'Media Studio',
    documents: 'Documentos',
    batch: 'Batch & Convert',
  };

  const MODE_LABELS = {
    L: 'Local',
    HL: 'Local por defecto',
    HR: 'Nube recomendada',
    R: 'Nube requerida',
  };

  const PRESETS = {
    'video-converter': { operation: 'convert', accept: 'video/*', format: 'mp4-h264' },
    'audio-converter': { operation: 'extract-audio', accept: 'audio/*,video/*' },
    'video-merge': {
      operation: 'join-videos',
      accept: 'video/*',
      format: 'mp4-h264',
      group: true,
    },
    'video-trim': { operation: 'convert', accept: 'video/*', format: 'mp4-h264', single: true },
    'audio-trim': { operation: 'extract-audio', accept: 'audio/*,video/*', single: true },
    'video-rotate': {
      operation: 'convert',
      accept: 'video/*',
      format: 'mp4-h264',
      options: { rotate: 90, flip: 'none' },
      single: true,
    },
    'video-flip': {
      operation: 'convert',
      accept: 'video/*',
      format: 'mp4-h264',
      options: { rotate: 0, flip: 'horizontal' },
      single: true,
    },
    'video-resize': {
      operation: 'convert',
      accept: 'video/*',
      format: 'mp4-h264',
      options: { resolution: '720' },
      single: true,
    },
    'video-crop': {
      operation: 'convert',
      accept: 'video/*',
      format: 'mp4-h264',
      options: { cropAspect: 'free' },
      single: true,
    },
  };

  const state = {
    workspace: 'all',
    availability: 'all',
    query: '',
  };

  let pendingToolId = null;

  function resetPickerIntent() {
    pendingToolId = null;
    fileInput.accept = 'video/*,audio/*';
    fileInput.multiple = true;
    const selectedTool = toolsById.get(app.selected?.forgeToolId);
    activeToolLabel.textContent = selectedTool?.name || 'Conversión multimedia';
  }

  /** Keep the UI tolerant while the catalogue schema evolves. */
  const tools = TOOL_CATALOG.map((tool) => ({
    ...tool,
    id: tool.id,
    name: tool.name || tool.title || tool.label || tool.id,
    description: tool.description || tool.summary || '',
    workspace: String(tool.workspace || '').toLowerCase(),
    mode: tool.mode || tool.executionMode || 'L',
    routeEs: tool.route?.es || tool.routeEs || tool.route || '',
    availability: tool.availability || tool.status || 'planned',
    keywords: Array.isArray(tool.keywords) ? tool.keywords : [],
  }));

  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));

  function fold(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function matchesQuery(tool, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = fold([
      tool.id,
      tool.name,
      tool.description,
      tool.routeEs,
      tool.workspace,
      ...tool.keywords,
    ].join(' '));
    return words.every((word) => (
      haystack.includes(word) || (word.length > 3 && word.endsWith('s') && haystack.includes(word.slice(0, -1)))
    ));
  }

  function filteredTools() {
    return tools
      .filter((tool) => state.workspace === 'all' || tool.workspace === state.workspace)
      .filter((tool) => state.availability === 'all' || tool.availability === state.availability)
      .filter((tool) => matchesQuery(tool, state.query))
      .sort((left, right) => {
        const availability = Number(right.availability === 'available') - Number(left.availability === 'available');
        return availability || left.name.localeCompare(right.name, 'es');
      });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderTools() {
    const matches = filteredTools();
    toolList.replaceChildren();

    for (const tool of matches) {
      const row = element('button', `forge-tool-row${tool.availability === 'planned' ? ' forge-planned' : ''}`);
      row.type = 'button';
      row.dataset.toolId = tool.id;
      if (tool.availability === 'planned') row.title = 'Planificada para una próxima etapa';

      const main = element('span', 'forge-tool-main');
      main.append(
        element('strong', '', tool.name),
        element('span', '', tool.description)
      );

      const meta = element('span', 'forge-tool-meta');
      meta.append(
        element('span', '', WORKSPACE_LABELS[tool.workspace] || tool.workspace),
        element('span', '', MODE_LABELS[tool.mode] || tool.mode),
        element(
          'span',
          `forge-tool-badge${tool.availability === 'available' ? ' is-available' : ''}`,
          tool.availability === 'available' ? 'Disponible' : 'Planificada'
        )
      );

      row.append(main, meta);
      toolList.append(row);
    }

    const available = matches.filter((tool) => tool.availability === 'available').length;
    resultSummary.textContent = matches.length
      ? `${matches.length} ${matches.length === 1 ? 'acción' : 'acciones'} · ${available} disponibles en esta versión`
      : 'No encontramos una acción con esos términos.';

    for (const button of document.querySelectorAll('[data-filter-workspace]')) {
      button.classList.toggle('is-active', button.dataset.filterWorkspace === state.workspace);
    }
    for (const button of document.querySelectorAll('[data-filter-availability]')) {
      button.classList.toggle('is-active', state.availability === button.dataset.filterAvailability);
      button.setAttribute('aria-pressed', String(state.availability === button.dataset.filterAvailability));
    }
  }

  function openLauncher({ workspace = 'all', availability = 'all', query = '' } = {}) {
    state.workspace = workspace;
    state.availability = availability;
    state.query = query;
    queryInput.value = query;
    renderTools();

    if (!launcher.open) {
      if (typeof launcher.showModal === 'function') launcher.showModal();
      else launcher.setAttribute('open', '');
    }
    requestAnimationFrame(() => queryInput.focus());
  }

  function closeLauncher() {
    if (typeof launcher.close === 'function' && launcher.open) launcher.close();
    else launcher.removeAttribute('open');
  }

  function selectHome() {
    for (const item of document.querySelectorAll('.forge-nav-item')) {
      const selected = item.dataset.forgeAction === 'home';
      item.classList.toggle('is-active', selected);
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }

    app.selectedId = null;
    app.paintQueue();
    app.paintDetail();
    document.querySelector('#inspector')?.focus({ preventScroll: true });
  }

  function notifyPlanned(tool) {
    app.toast(`${tool.name} ya está en el catálogo y entra en una próxima etapa de implementación.`, {
      duration: 6500,
    });
  }

  function activateTool(toolId) {
    const tool = toolsById.get(toolId);
    if (!tool) return;
    if (tool.availability !== 'available') {
      notifyPlanned(tool);
      return;
    }

    const preset = PRESETS[tool.id];
    if (!preset) {
      notifyPlanned(tool);
      return;
    }

    pendingToolId = tool.id;
    if (preset.advanced) prefs.set('advanced', true);
    fileInput.accept = preset.accept;
    fileInput.multiple = !preset.single;
    activeToolLabel.textContent = tool.name;
    closeLauncher();
    fileInput.click();
  }

  function applyPreset(job, toolId) {
    const tool = toolsById.get(toolId);
    const preset = PRESETS[toolId];
    if (!tool || !preset) return;
    job.forgeToolId = toolId;
    job.operation = preset.operation;
    if (preset.format) job.options.format = preset.format;
    if (preset.options) Object.assign(job.options, preset.options);
    job.previewMode = 'source';
  }

  // Add intent without forking the existing file/job controller. The wrapper
  // tags only the jobs created by this call, then the normal probe and render
  // pipeline continues unchanged.
  const addFiles = app.addFiles.bind(app);
  app.addFiles = (files) => {
    const toolId = pendingToolId;
    const preset = PRESETS[toolId];
    if (toolId && preset?.group) {
      app.addMergeProject(files, toolId);
      resetPickerIntent();
      app.paintQueue();
      app.paintDetail();
      return;
    }
    const known = new Set(app.jobs.map((job) => job.id));
    // An explicit launcher choice wins over the currently selected workspace.
    // Otherwise choosing "Convertir video" while a merge project is open
    // would append the file to that sequence before this wrapper can tag it.
    addFiles(files, { forceNewJobs: Boolean(toolId) });
    const added = app.jobs.filter((job) => !known.has(job.id));
    if (toolId) {
      for (const job of added) applyPreset(job, toolId);
      if (added[0]) app.selectedId = added[0].id;
    }
    resetPickerIntent();
    app.paintQueue();
    app.paintDetail();
  };

  fileInput.addEventListener('cancel', resetPickerIntent);

  const renderDetail = app.renderDetail.bind(app);
  app.renderDetail = () => {
    renderDetail();
    const tool = toolsById.get(app.selected?.forgeToolId);
    activeToolLabel.textContent = tool?.name || 'Conversión multimedia';
  };

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;

    if (target.matches('[data-action="add-files"]')) {
      resetPickerIntent();
    }

    if (target.dataset.toolId) {
      activateTool(target.dataset.toolId);
      return;
    }

    if (target.dataset.filterWorkspace) {
      state.workspace = target.dataset.filterWorkspace;
      renderTools();
      return;
    }

    if (target.dataset.filterAvailability) {
      const value = target.dataset.filterAvailability;
      state.availability = state.availability === value ? 'all' : value;
      renderTools();
      return;
    }

    if (target.dataset.forgeWorkspace) {
      openLauncher({ workspace: target.dataset.forgeWorkspace });
      return;
    }

    if (target.dataset.forgeAction === 'open-launcher') {
      openLauncher({ availability: target.dataset.availability || 'all' });
      return;
    }

    if (target.dataset.forgeAction === 'close-launcher') {
      closeLauncher();
      return;
    }

    if (target.dataset.forgeAction === 'home') selectHome();
  }, true);

  queryInput.addEventListener('input', () => {
    state.query = queryInput.value;
    renderTools();
  });

  document.querySelector('#forge-launcher-form').addEventListener('submit', (event) => {
    event.preventDefault();
  });

  intentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openLauncher({ query: intentInput.value.trim() });
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openLauncher();
    }
  });

  renderTools();
}
