/**
 * Ordered, accessible clip sequence for the focused video-merge workspace.
 *
 * The application owns the project. This component owns only the interaction:
 * selection, an optimistic visual reorder and the equivalent pointer, keyboard
 * and explicit-button paths. Every committed move is reported as a stable clip
 * id plus a zero-based destination index.
 */

import { el, formatBytes, formatDuration, on, truncateName } from './dom.js';

let nextSequenceId = 1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Return a new array with `id` placed at `targetIndex`. */
export function moveSequenceItem(items, id, targetIndex) {
  const sourceIndex = items.findIndex((item) => item.id === id);
  if (sourceIndex < 0 || items.length < 2) return [...items];
  const destination = clamp(Math.round(Number(targetIndex) || 0), 0, items.length - 1);
  if (sourceIndex === destination) return [...items];

  const next = [...items];
  const [item] = next.splice(sourceIndex, 1);
  next.splice(destination, 0, item);
  return next;
}

function clipFacts(clip) {
  if (clip.status === 'probing') return 'Analizando…';
  if (clip.status === 'failed' || clip.error) return 'Requiere atención';
  const facts = [];
  if (Number.isFinite(clip.info?.duration)) facts.push(formatDuration(clip.info.duration));
  if (clip.info?.video?.width && clip.info?.video?.height) {
    facts.push(`${clip.info.video.width}×${clip.info.video.height}`);
  }
  if (Number.isFinite(clip.size) && clip.size > 0) facts.push(formatBytes(clip.size));
  return facts.join(' · ') || 'Esperando información';
}

function statusLabel(clip) {
  if (clip.status === 'probing') return 'Analizando';
  if (clip.status === 'failed' || clip.error) return 'Atención';
  return 'Listo';
}

function actionButton({ action, clip, label, glyph, disabled = false }) {
  const accessible = `${label}: ${clip.name}`;
  const shortLabels = {
    first: 'Inicio',
    before: 'Antes',
    after: 'Después',
    last: 'Final',
    remove: 'Quitar',
  };
  return el('button', {
    type: 'button',
    class: `merge-clip-action merge-clip-action-${action}`,
    disabled,
    title: label,
    dataset: { mergeAction: action, clipId: clip.id },
    attrs: { 'aria-label': accessible },
  }, [
    el('span', { class: 'merge-clip-action-glyph', text: glyph, attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'merge-clip-action-label', text: shortLabels[action], attrs: { 'aria-hidden': 'true' } }),
  ]);
}

/**
 * @param {{
 *   clips: Array<{id: string, name: string, size?: number, info?: object,
 *     status?: string, error?: string|null}>,
 *   selectedClipId?: string|null,
 *   disabled?: boolean,
 *   onSelect?: (id: string) => void,
 *   onMove?: (id: string, targetIndex: number) => void,
 *   onRemove?: (id: string) => void,
 *   onAdd?: () => void,
 * }} options
 * @returns {{node: HTMLElement, focusClip: (id: string) => void, destroy: () => void}}
 */
export function createMergeSequence({
  clips: initialClips,
  selectedClipId = null,
  disabled = false,
  onSelect,
  onMove,
  onRemove,
  onAdd,
}) {
  let clips = Array.from(initialClips || []);
  let selected = clips.some((clip) => clip.id === selectedClipId)
    ? selectedClipId
    : clips[0]?.id || null;
  let pointerDrag = null;
  let keyboardDrag = null;
  let destroyed = false;
  let stopPointer = null;
  const removeListeners = [];
  const instanceId = `merge-sequence-${nextSequenceId++}`;
  const helpId = `${instanceId}-help`;

  const heading = el('strong', { id: `${instanceId}-title`, text: 'Orden final' });
  const summary = el('span', { class: 'merge-sequence-summary' });
  const add = el('button', {
    type: 'button',
    class: 'text-button merge-sequence-add',
    text: 'Agregar videos',
    disabled,
    dataset: { mergeAction: 'add' },
  });
  const header = el('header', { class: 'merge-sequence-head' }, [
    el('div', { class: 'merge-sequence-copy' }, [heading, summary]),
    add,
  ]);
  const list = el('ol', {
    class: 'merge-sequence-list',
    attrs: {
      'aria-labelledby': heading.id,
      'aria-describedby': helpId,
    },
  });
  const help = el('p', {
    id: helpId,
    class: 'sr-only',
    text: 'Para reordenar con el teclado, enfocá el asa de un clip, presioná Espacio, movelo con las flechas, Inicio o Fin, y presioná Espacio para soltar. Escape cancela.',
  });
  const live = el('p', {
    class: 'sr-only merge-sequence-live',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const node = el('section', {
    class: 'merge-sequence-panel',
    dataset: { disabled: String(Boolean(disabled)) },
    attrs: {
      'aria-labelledby': heading.id,
      'aria-disabled': String(Boolean(disabled)),
    },
  }, [header, list, help, live]);

  function announce(message) {
    live.textContent = '';
    // Repeating a move back to a previously announced position must still be
    // spoken. A microtask creates the observable text change without delaying
    // the visual interaction.
    queueMicrotask(() => {
      if (!destroyed) live.textContent = message;
    });
  }

  function positionMessage(id, verb = 'está') {
    const index = clips.findIndex((clip) => clip.id === id);
    const clip = clips[index];
    return clip ? `${clip.name} ${verb} en la posición ${index + 1} de ${clips.length}.` : '';
  }

  function updateSummary() {
    const seconds = clips.reduce((total, clip) => (
      total + (Number.isFinite(clip.info?.duration) ? clip.info.duration : 0)
    ), 0);
    const count = `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`;
    summary.textContent = seconds > 0 ? `${count} · ${formatDuration(seconds)}` : count;
  }

  function renderList({ focusHandleId = null, focusSelectId = null } = {}) {
    list.replaceChildren();
    updateSummary();
    node.dataset.sorting = keyboardDrag || pointerDrag ? 'true' : 'false';
    add.disabled = Boolean(disabled || keyboardDrag || pointerDrag);

    if (!clips.length) {
      list.append(el('li', { class: 'merge-sequence-empty', text: 'Todavía no agregaste videos.' }));
      return;
    }

    for (const [index, clip] of clips.entries()) {
      const isSelected = clip.id === selected;
      const isMoving = clip.id === keyboardDrag?.id || clip.id === pointerDrag?.id;
      const mutationsLocked = Boolean(disabled || (keyboardDrag && !isMoving) || pointerDrag);
      const position = index + 1;
      const selection = el('button', {
        type: 'button',
        class: 'merge-clip-select',
        title: clip.name,
        dataset: { mergeAction: 'select', clipId: clip.id },
        attrs: {
          'aria-pressed': String(isSelected),
          'aria-label': `Seleccionar ${clip.name}, clip ${position} de ${clips.length}`,
        },
      }, [
        el('span', { class: 'merge-clip-order', text: String(position), attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'merge-clip-visual', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { class: 'merge-clip-play', text: '▶' }),
          el('span', { class: 'merge-clip-duration', text: Number.isFinite(clip.info?.duration) ? formatDuration(clip.info.duration) : '—' }),
        ]),
        el('span', { class: 'merge-clip-copy' }, [
          el('strong', { text: truncateName(clip.name, 32), title: clip.name }),
          el('span', { class: 'merge-clip-facts', text: clipFacts(clip) }),
        ]),
        isSelected ? el('span', { class: 'merge-clip-selected', text: 'Seleccionado' }) : null,
      ]);

      const handle = el('button', {
        type: 'button',
        class: 'merge-clip-handle',
        disabled: mutationsLocked,
        title: 'Reordenar clip',
        dataset: { mergeHandle: '', clipId: clip.id },
        attrs: {
          'aria-label': `Reordenar ${clip.name}, posición ${position} de ${clips.length}`,
          'aria-describedby': helpId,
          'aria-pressed': String(Boolean(keyboardDrag?.id === clip.id)),
          'aria-keyshortcuts': 'Space ArrowLeft ArrowRight ArrowUp ArrowDown Home End Escape',
        },
      }, [el('span', { text: '⠿', attrs: { 'aria-hidden': 'true' } })]);

      const actions = el('div', {
        class: 'merge-clip-actions',
        attrs: { role: 'group', 'aria-label': `Orden y acciones de ${clip.name}` },
      }, [
        actionButton({ action: 'first', clip, label: 'Mover al inicio', glyph: '↤', disabled: mutationsLocked || index === 0 }),
        actionButton({ action: 'before', clip, label: 'Mover antes', glyph: '←', disabled: mutationsLocked || index === 0 }),
        actionButton({ action: 'after', clip, label: 'Mover después', glyph: '→', disabled: mutationsLocked || index === clips.length - 1 }),
        actionButton({ action: 'last', clip, label: 'Mover al final', glyph: '↦', disabled: mutationsLocked || index === clips.length - 1 }),
        actionButton({ action: 'remove', clip, label: 'Quitar del proyecto', glyph: '×', disabled: mutationsLocked }),
      ]);

      const error = clip.error
        ? el('p', { class: 'merge-clip-warning', text: truncateName(clip.error, 82), title: clip.error })
        : null;
      const item = el('li', {
        class: `merge-clip${isSelected ? ' is-selected' : ''}${isMoving ? ' is-moving' : ''}`,
        dataset: { mergeClipId: clip.id, status: clip.error ? 'failed' : (clip.status || 'ready') },
      }, [
        el('div', { class: 'merge-clip-top' }, [
          handle,
          el('span', { class: 'merge-clip-status', text: statusLabel(clip) }),
        ]),
        selection,
        error,
        actions,
      ]);
      list.append(item);
    }

    if (focusHandleId || focusSelectId) {
      requestAnimationFrame(() => {
        if (destroyed) return;
        const candidates = focusHandleId
          ? list.querySelectorAll('[data-merge-handle]')
          : list.querySelectorAll('[data-merge-action="select"]');
        const target = Array.from(candidates)
          .find((candidate) => candidate.dataset.clipId === (focusHandleId || focusSelectId));
        target?.focus({ preventScroll: true });
      });
    }
  }

  function commitMove(id, targetIndex, { focusHandle = false } = {}) {
    const from = clips.findIndex((clip) => clip.id === id);
    if (from < 0) return;
    const destination = clamp(targetIndex, 0, clips.length - 1);
    if (from === destination) return;
    clips = moveSequenceItem(clips, id, destination);
    renderList({ focusHandleId: focusHandle ? id : null });
    announce(positionMessage(id));
    onMove?.(id, destination);
  }

  function cancelKeyboardMove() {
    if (!keyboardDrag) return;
    const { id, original } = keyboardDrag;
    clips = original;
    keyboardDrag = null;
    renderList({ focusHandleId: id });
    announce(`Movimiento de ${clips.find((clip) => clip.id === id)?.name || 'clip'} cancelado.`);
  }

  function finishKeyboardMove() {
    if (!keyboardDrag) return;
    const { id, original } = keyboardDrag;
    const originalIndex = original.findIndex((clip) => clip.id === id);
    const destination = clips.findIndex((clip) => clip.id === id);
    keyboardDrag = null;
    renderList({ focusHandleId: id });
    announce(positionMessage(id, 'quedó'));
    if (destination !== originalIndex) onMove?.(id, destination);
  }

  function moveKeyboardClip(id, key) {
    const current = clips.findIndex((clip) => clip.id === id);
    if (current < 0) return;
    let destination = current;
    if (key === 'Home') destination = 0;
    else if (key === 'End') destination = clips.length - 1;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') destination = current - 1;
    else if (key === 'ArrowRight' || key === 'ArrowDown') destination = current + 1;
    destination = clamp(destination, 0, clips.length - 1);
    if (destination === current) return;
    clips = moveSequenceItem(clips, id, destination);
    renderList({ focusHandleId: id });
    announce(positionMessage(id));
  }

  function pointerTargetIndex(clientX) {
    const cards = Array.from(list.querySelectorAll('[data-merge-clip-id]'));
    if (!cards.length) return -1;
    let nearest = cards[0];
    let distance = Infinity;
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const nextDistance = Math.abs(clientX - (box.left + box.width / 2));
      if (nextDistance < distance) {
        nearest = card;
        distance = nextDistance;
      }
    }
    return clips.findIndex((clip) => clip.id === nearest.dataset.mergeClipId);
  }

  function stopPointerMove({ cancel = false } = {}) {
    if (!pointerDrag) return;
    const { id, original, moved } = pointerDrag;
    const destination = clips.findIndex((clip) => clip.id === id);
    const originalIndex = original.findIndex((clip) => clip.id === id);
    pointerDrag = null;
    stopPointer?.();
    stopPointer = null;

    if (cancel) {
      clips = original;
      renderList({ focusHandleId: id });
      announce(`Movimiento de ${original.find((clip) => clip.id === id)?.name || 'clip'} cancelado.`);
      return;
    }

    renderList({ focusHandleId: id });
    if (moved && destination !== originalIndex) {
      announce(positionMessage(id, 'quedó'));
      onMove?.(id, destination);
    }
  }

  function beginPointerMove(event, id) {
    if (disabled || event.button !== 0 || keyboardDrag) return;
    const startX = event.clientX;
    const startY = event.clientY;
    pointerDrag = { id, original: [...clips], moved: false, startX, startY };
    renderList();
    event.preventDefault();

    const move = (moveEvent) => {
      if (!pointerDrag) return;
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!pointerDrag.moved && distance < 6) return;
      pointerDrag.moved = true;

      const box = list.getBoundingClientRect();
      if (moveEvent.clientX < box.left + 44) list.scrollLeft -= 16;
      else if (moveEvent.clientX > box.right - 44) list.scrollLeft += 16;

      const destination = pointerTargetIndex(moveEvent.clientX);
      const current = clips.findIndex((clip) => clip.id === id);
      if (destination < 0 || destination === current) return;
      clips = moveSequenceItem(clips, id, destination);
      renderList();
    };
    const up = () => stopPointerMove();
    const cancel = () => stopPointerMove({ cancel: true });
    const keydown = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    window.addEventListener('keydown', keydown);
    stopPointer = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keydown);
    };
  }

  removeListeners.push(on(list, 'pointerdown', (event) => {
    const handle = event.target.closest('[data-merge-handle]');
    if (handle) beginPointerMove(event, handle.dataset.clipId);
  }));

  removeListeners.push(on(list, 'keydown', (event) => {
    const handle = event.target.closest('[data-merge-handle]');
    if (!handle || disabled) return;
    const id = handle.dataset.clipId;
    const space = event.key === ' ' || event.key === 'Spacebar';

    if (space) {
      event.preventDefault();
      if (keyboardDrag?.id === id) finishKeyboardMove();
      else if (!keyboardDrag && !pointerDrag) {
        keyboardDrag = { id, original: [...clips] };
        renderList({ focusHandleId: id });
        announce(`${clips.find((clip) => clip.id === id)?.name || 'Clip'} tomado. Posición ${clips.findIndex((clip) => clip.id === id) + 1} de ${clips.length}.`);
      }
      return;
    }

    if (keyboardDrag?.id !== id) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelKeyboardMove();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveKeyboardClip(id, event.key);
    }
  }));

  removeListeners.push(on(node, 'click', (event) => {
    const target = event.target.closest('[data-merge-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.mergeAction;
    const id = target.dataset.clipId;

    if (keyboardDrag) cancelKeyboardMove();
    if (action === 'add') {
      onAdd?.();
      return;
    }
    if (action === 'select') {
      selected = id;
      renderList({ focusSelectId: id });
      onSelect?.(id);
      return;
    }
    const index = clips.findIndex((clip) => clip.id === id);
    if (index < 0) return;
    if (action === 'remove') {
      const name = clips[index].name;
      clips.splice(index, 1);
      if (selected === id) selected = clips[Math.min(index, clips.length - 1)]?.id || null;
      renderList({ focusSelectId: selected });
      announce(`${name} se quitó del proyecto.`);
      onRemove?.(id);
      return;
    }

    const destination = action === 'first'
      ? 0
      : action === 'last'
        ? clips.length - 1
        : index + (action === 'before' ? -1 : 1);
    commitMove(id, destination, { focusHandle: true });
  }));

  renderList();

  return {
    node,
    focusClip(id) {
      const button = Array.from(list.querySelectorAll('[data-merge-action="select"]'))
        .find((candidate) => candidate.dataset.clipId === id);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'auto' });
    },
    destroy() {
      destroyed = true;
      stopPointerMove({ cancel: true });
      for (const remove of removeListeners) remove();
      list.replaceChildren();
    },
  };
}
