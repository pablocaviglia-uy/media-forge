/**
 * A visual crop rectangle over the browser's own video preview.
 *
 * Coordinates are expressed in visible source pixels. FFmpeg receives the
 * same rectangle later; this component only maps those pixels to pointer and
 * keyboard interactions and never reads or rewrites the media bytes.
 */

import { el, on } from './dom.js';

const MIN_SIZE = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const even = (value) => Math.round(value / 2) * 2;

function normaliseRect(rect, dimensions) {
  const frameWidth = Math.max(MIN_SIZE, Math.floor(dimensions.width / 2) * 2);
  const frameHeight = Math.max(MIN_SIZE, Math.floor(dimensions.height / 2) * 2);
  const width = clamp(even(Number(rect?.width) || frameWidth), MIN_SIZE, frameWidth);
  const height = clamp(even(Number(rect?.height) || frameHeight), MIN_SIZE, frameHeight);
  const x = clamp(even(Number(rect?.x) || 0), 0, frameWidth - width);
  const y = clamp(even(Number(rect?.y) || 0), 0, frameHeight - height);
  return { x, y, width, height };
}

function handlePoint(rect, handle) {
  return {
    x: handle.includes('w') ? rect.x : rect.x + rect.width,
    y: handle.includes('n') ? rect.y : rect.y + rect.height,
  };
}

function resizeRect(start, handle, point, dimensions, aspectRatio) {
  const anchor = {
    x: handle.includes('w') ? start.x + start.width : start.x,
    y: handle.includes('n') ? start.y + start.height : start.y,
  };

  let width = Math.max(MIN_SIZE, Math.abs(point.x - anchor.x));
  let height = Math.max(MIN_SIZE, Math.abs(point.y - anchor.y));
  if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
    if (width / height > aspectRatio) height = width / aspectRatio;
    else width = height * aspectRatio;

    const availableWidth = handle.includes('w') ? anchor.x : dimensions.width - anchor.x;
    const availableHeight = handle.includes('n') ? anchor.y : dimensions.height - anchor.y;
    const fit = Math.min(1, availableWidth / width, availableHeight / height);
    width *= fit;
    height *= fit;
  }

  width = clamp(even(width), MIN_SIZE, dimensions.width);
  height = clamp(even(height), MIN_SIZE, dimensions.height);
  return normaliseRect({
    x: handle.includes('w') ? anchor.x - width : anchor.x,
    y: handle.includes('n') ? anchor.y - height : anchor.y,
    width,
    height,
  }, dimensions);
}

/** Keep a pointer drag anchored to the corner, regardless of where inside its
 * larger hit target the press began. */
export function pointerResizeRect(start, handle, origin, point, dimensions, aspectRatio = null) {
  const corner = handlePoint(start, handle);
  return resizeRect(start, handle, {
    x: corner.x + point.x - origin.x,
    y: corner.y + point.y - origin.y,
  }, dimensions, aspectRatio);
}

/**
 * Resize a corner from the keyboard while preserving a fixed aspect ratio.
 * Moving only one pointer axis is ambiguous once both dimensions are linked,
 * so the pressed arrow owns that axis and the other one follows the ratio.
 */
export function keyboardResizeRect(start, handle, key, step, dimensions, aspectRatio = null) {
  const point = handlePoint(start, handle);
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (!horizontal && !vertical) return normaliseRect(start, dimensions);

  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    point.x += key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    point.y += key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    return resizeRect(start, handle, point, dimensions, null);
  }

  const anchor = {
    x: handle.includes('w') ? start.x + start.width : start.x,
    y: handle.includes('n') ? start.y + start.height : start.y,
  };
  let width = start.width;
  let height = start.height;
  if (horizontal) {
    const direction = (key === 'ArrowRight' ? 1 : -1) * (handle.includes('e') ? 1 : -1);
    width = Math.max(MIN_SIZE, start.width + direction * step);
    height = width / aspectRatio;
  } else {
    const direction = (key === 'ArrowDown' ? 1 : -1) * (handle.includes('s') ? 1 : -1);
    height = Math.max(MIN_SIZE, start.height + direction * step);
    width = height * aspectRatio;
  }
  point.x = handle.includes('w') ? anchor.x - width : anchor.x + width;
  point.y = handle.includes('n') ? anchor.y - height : anchor.y + height;
  return resizeRect(start, handle, point, dimensions, aspectRatio);
}

/**
 * @param {{file: File, dimensions: {width: number, height: number},
 *   initialRect: {x: number, y: number, width: number, height: number},
 *   aspectRatio?: number | null,
 *   onChange?: (rect: {x: number, y: number, width: number, height: number}) => void,
 *   onPreviewError?: () => void}} options
 * @returns {{node: HTMLElement, rect: () => object, setRect: (rect: object) => void,
 *   setAspectRatio: (ratio: number | null) => void,
 *   setDisabled: (disabled: boolean) => void, destroy: () => void}}
 */
export function createCropper({ file, dimensions, initialRect, aspectRatio = null, onChange, onPreviewError }) {
  let current = normaliseRect(initialRect, dimensions);
  let ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : null;
  let disabled = false;
  let stopDrag = null;
  const removeListeners = [];
  const url = URL.createObjectURL(file);

  const video = el('video', {
    class: 'quick-crop-media',
    src: url,
    preload: 'metadata',
    playsInline: true,
    loop: true,
    attrs: { 'aria-label': `Vista previa de ${file.name}` },
  });
  const selection = el('div', {
    class: 'quick-crop-selection',
    attrs: {
      tabindex: '0',
      role: 'group',
      'aria-label': 'Área de recorte. Usá las flechas para moverla; Mayús mueve diez píxeles.',
    },
  });
  const handles = new Map();
  const handleLabels = {
    nw: 'Redimensionar desde la esquina superior izquierda',
    ne: 'Redimensionar desde la esquina superior derecha',
    sw: 'Redimensionar desde la esquina inferior izquierda',
    se: 'Redimensionar desde la esquina inferior derecha',
  };
  for (const handle of Object.keys(handleLabels)) {
    const button = el('button', {
      type: 'button',
      class: `quick-crop-handle quick-crop-handle-${handle}`,
      dataset: { cropHandle: handle },
      attrs: { 'aria-label': handleLabels[handle] },
    });
    handles.set(handle, button);
    selection.append(button);
  }

  const frame = el('div', { class: 'quick-crop-frame' }, [video, selection]);
  const badge = el('output', { class: 'quick-crop-badge', attrs: { 'aria-live': 'polite' } });
  const play = el('button', {
    type: 'button',
    class: 'text-button quick-transform-play',
    text: 'Reproducir vista previa',
  });
  const node = el('div', {
    class: 'quick-transform-stage quick-crop-stage',
    attrs: { 'aria-label': 'Vista previa y selección del encuadre' },
  }, [frame, badge, play]);

  function paint() {
    selection.style.left = `${(current.x / dimensions.width) * 100}%`;
    selection.style.top = `${(current.y / dimensions.height) * 100}%`;
    selection.style.width = `${(current.width / dimensions.width) * 100}%`;
    selection.style.height = `${(current.height / dimensions.height) * 100}%`;
    const label = `${current.width}×${current.height} · x ${current.x}, y ${current.y}`;
    badge.textContent = label;
    selection.setAttribute('aria-description', label);
  }

  function commit(rect) {
    const next = normaliseRect(rect, dimensions);
    if (
      next.x === current.x && next.y === current.y &&
      next.width === current.width && next.height === current.height
    ) return;
    current = next;
    paint();
    onChange?.({ ...current });
  }

  function sourcePoint(event, box = frame.getBoundingClientRect()) {
    return {
      x: clamp(((event.clientX - box.left) / box.width) * dimensions.width, 0, dimensions.width),
      y: clamp(((event.clientY - box.top) / box.height) * dimensions.height, 0, dimensions.height),
    };
  }

  function beginDrag(event, handle = null) {
    if (disabled || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopDrag?.();
    const start = { ...current };
    const box = frame.getBoundingClientRect();
    const origin = sourcePoint(event, box);

    const move = (moveEvent) => {
      const point = sourcePoint(moveEvent, box);
      if (handle) {
        commit(pointerResizeRect(start, handle, origin, point, dimensions, ratio));
      } else {
        commit({
          ...start,
          x: start.x + point.x - origin.x,
          y: start.y + point.y - origin.y,
        });
      }
    };
    const end = () => stopDrag?.();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
    stopDrag = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stopDrag = null;
    };
  }

  removeListeners.push(on(selection, 'pointerdown', (event) => {
    const handle = event.target.closest('[data-crop-handle]')?.dataset.cropHandle || null;
    beginDrag(event, handle);
  }));
  removeListeners.push(on(selection, 'keydown', (event) => {
    if (event.target !== selection || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 2;
    commit({
      ...current,
      x: current.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      y: current.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
    });
  }));
  for (const [handle, button] of handles) {
    removeListeners.push(on(button, 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 2;
      commit(keyboardResizeRect(current, handle, event.key, step, dimensions, ratio));
    }));
  }

  const syncPlay = () => {
    play.textContent = video.paused ? 'Reproducir vista previa' : 'Pausar vista previa';
  };
  removeListeners.push(on(play, 'click', () => {
    if (video.paused) video.play().catch(syncPlay);
    else video.pause();
  }));
  removeListeners.push(on(video, 'play', syncPlay));
  removeListeners.push(on(video, 'pause', syncPlay));
  removeListeners.push(on(video, 'error', () => {
    badge.textContent = 'Vista previa no disponible para este formato';
    play.hidden = true;
    onPreviewError?.();
  }));

  paint();

  return {
    node,
    rect: () => ({ ...current }),
    setRect(rect) {
      current = normaliseRect(rect, dimensions);
      paint();
    },
    setAspectRatio(value) {
      ratio = Number.isFinite(value) && value > 0 ? value : null;
    },
    setDisabled(value) {
      disabled = Boolean(value);
      node.inert = disabled;
      node.setAttribute('aria-disabled', String(disabled));
      play.disabled = disabled;
      if (disabled) video.pause();
    },
    destroy() {
      stopDrag?.();
      for (const remove of removeListeners) remove();
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}
