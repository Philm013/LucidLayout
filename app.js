const GRID_LIMIT = 20;
const SESSION_STORAGE_KEY = 'png-grid-session-v1';
const WINDOW_NAME_SESSION_PREFIX = 'png-grid-session-v1:';
const SESSION_DB_NAME = 'png-grid-session-db';
const SESSION_DB_STORE = 'kv';
// Full-resolution originals live here, keyed by asset id, so `state.assets`
// only ever has to carry a small thumbnail in memory (see THUMB_MAX_DIM).
const ASSET_BLOB_STORE = 'assetBlobs';
const SESSION_DB_VERSION = 2;
const SHRINK_MODE_STORAGE_KEY = 'png-grid-shrink-mode';

// Longest edge, in pixels, for the in-memory/grid-display thumbnail generated
// for every imported image. Grid cells, the holding tray, and history
// timeline previews all render this thumbnail instead of the original file,
// which is what actually keeps tab memory and pan/zoom smooth with dozens of
// large photos on the grid. Full-resolution bytes are never dropped — they're
// stored in IndexedDB (ASSET_BLOB_STORE) and pulled back on demand for
// export/copy operations (PNG, SVG, Lucid) and the single-image preview.
const THUMB_MAX_DIM = 900;

let sessionDbPromise = null;

function loadShrinkMode() {
  try {
    return localStorage.getItem(SHRINK_MODE_STORAGE_KEY) === 'reflow' ? 'reflow' : 'trim';
  } catch {
    return 'trim';
  }
}

function saveShrinkMode(mode) {
  try {
    localStorage.setItem(SHRINK_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable in some privacy contexts; ignore.
  }
}

const UI_SCALE_STORAGE_KEY = 'png-grid-ui-scale';
const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 1.5;
const UI_SCALE_DEFAULT = 1.1;

function loadUiScalePreference() {
  try {
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null) return UI_SCALE_DEFAULT;
    const stored = Number(raw);
    if (Number.isFinite(stored)) return clamp(stored, UI_SCALE_MIN, UI_SCALE_MAX);
  } catch {
    // localStorage can be unavailable in some privacy contexts; ignore.
  }
  return UI_SCALE_DEFAULT;
}

function saveUiScalePreference(scale) {
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
  } catch {
    // localStorage can be unavailable in some privacy contexts; ignore.
  }
}

const EXPORT_LOG_STORAGE_KEY = 'png-grid-export-log';
const EXPORT_LOG_MAX_ENTRIES = 50;

function loadExportLog() {
  try {
    const raw = localStorage.getItem(EXPORT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveExportLog(log) {
  try {
    localStorage.setItem(EXPORT_LOG_STORAGE_KEY, JSON.stringify(log.slice(0, EXPORT_LOG_MAX_ENTRIES)));
  } catch {
    // localStorage can be unavailable in some privacy contexts; ignore.
  }
}

function addExportLogEntry(result) {
  const entry = {
    documentId: result?.documentId ?? null,
    title: result?.title ?? 'Untitled',
    editUrl: result?.editUrl ?? null,
    viewUrl: result?.viewUrl ?? null,
    product: result?.product ?? null,
    version: result?.version ?? null,
    pageCount: result?.pageCount ?? null,
    created: result?.created ?? new Date().toISOString()
  };
  const log = loadExportLog();
  log.unshift(entry);
  saveExportLog(log);
  return log;
}

const state = {
  assets: [],
  grid: [],
  rows: 3,
  cols: 3,
  globalGapX: 12,
  columnGaps: [12, 12],
  gapX: 12,
  gapY: 12,
  cellWidth: 160,
  cellHeight: 120,
  textSize: 12,
  fit: 'contain',
  shrinkMode: 'trim',
  uiScalePreference: UI_SCALE_DEFAULT,
  canvasWidth: 1280,
  canvasHeight: 720,
  contentOffsetX: 0,
  contentOffsetY: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  selectedSlotIndex: null,
  pendingImportFiles: null,
  pendingReplaceFiles: null,
  awaitingAppendSelection: false,
  pendingGridSequence: null,
  pendingGridIsLayout: false,
  pendingGridPlacementOffset: 0,
  pendingOverflowInitialRows: null,
  pendingOverflowInitialCols: null,
  dragPayload: null,
  dropDepth: 0,
  lastDragExpandAt: 0,
  overflowModalOpen: false,
  previewModalOpen: false,
  previewSlotIndex: null,
  keyboardPlacement: null,
  dragEdgeHint: null,
  flowPreview: null,
  autoExpandSession: null,
  multiSelectedSlots: [],
  holdingAssetIds: [],
  modalFocusStack: []
};

const els = {};
let modalOpenSequence = 0;

// History system for undo/redo
const HISTORY_MAX_SIZE = 50;
const history = {
  undoStack: [],
  redoStack: [],
  currentIndex: -1
};

function captureStateSnapshot(label = 'Action') {
  const snapshot = {
    timestamp: Date.now(),
    label,
    state: {
      // Asset objects are never mutated in place after creation (only ever
      // replaced/added/removed as whole objects), so a shallow copy of the
      // array is enough here — deep-cloning via JSON used to re-serialize
      // every thumbnail on every single undo-tracked action (up to
      // HISTORY_MAX_SIZE times over), which was a major source of bloated
      // tab memory.
      assets: state.assets.slice(),
      grid: state.grid.slice(),
      rows: state.rows,
      cols: state.cols,
      globalGapX: state.globalGapX,
      columnGaps: state.columnGaps.slice(),
      gapX: state.gapX,
      gapY: state.gapY,
      cellWidth: state.cellWidth,
      cellHeight: state.cellHeight,
      textSize: state.textSize,
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
      holdingAssetIds: state.holdingAssetIds.slice(),
      selectedSlotIndex: state.selectedSlotIndex,
      multiSelectedSlots: state.multiSelectedSlots.slice()
    },
    preview: null
  };
  
  return snapshot;
}

function restoreStateSnapshot(snapshot) {
  if (!snapshot || !snapshot.state) return false;
  
  const s = snapshot.state;
  state.assets = s.assets.slice();
  state.grid = s.grid.slice();
  state.rows = s.rows;
  state.cols = s.cols;
  state.globalGapX = Number.isFinite(s.globalGapX)
    ? clamp(s.globalGapX, 0, 120)
    : (Number.isFinite(s.gapX) ? clamp(s.gapX, 0, 120) : (Number.isFinite(s.gap) ? clamp(s.gap, 0, 120) : 12));
  state.columnGaps = Array.isArray(s.columnGaps) ? s.columnGaps.slice() : [];
  state.gapX = state.globalGapX;
  state.gapY = Number.isFinite(s.gapY) ? s.gapY : (Number.isFinite(s.gap) ? s.gap : 12);
  state.cellWidth = s.cellWidth;
  state.cellHeight = s.cellHeight;
  state.textSize = s.textSize;
  state.zoom = s.zoom;
  state.panX = s.panX;
  state.panY = s.panY;
  state.holdingAssetIds = s.holdingAssetIds.slice();
  state.selectedSlotIndex = s.selectedSlotIndex;
  state.multiSelectedSlots = s.multiSelectedSlots.slice();
  normalizeColumnGaps();
  
  return true;
}

function pushHistory(label = 'Action') {
  // Clear redo stack when new action is taken
  history.redoStack = [];
  
  const snapshot = captureStateSnapshot(label);
  history.undoStack.push(snapshot);
  
  // Limit history size
  if (history.undoStack.length > HISTORY_MAX_SIZE) {
    history.undoStack.shift();
  }
  
  updateHistoryButtonStates();
  renderHistoryTimeline();
  
  // Async thumbnail — capture after the current call stack settles
  generateHistoryThumbnail(snapshot);
}

async function generateHistoryThumbnail(snapshot) {
  try {
    const offscreen = document.createElement('canvas');
    offscreen.width = 192;
    offscreen.height = 144;
    await drawLayoutToCanvas(offscreen);
    snapshot.preview = offscreen.toDataURL('image/jpeg', 0.55);
    const modal = document.getElementById('historyModal');
    if (modal && modal.classList.contains('show')) {
      renderHistoryTimeline();
    }
  } catch (e) {
    // Thumbnail generation failed silently
  }
}

function undo() {
  if (history.undoStack.length === 0) return false;
  
  const currentSnapshot = captureStateSnapshot('Checkpoint');
  history.redoStack.push(currentSnapshot);
  
  const previous = history.undoStack.pop();
  if (restoreStateSnapshot(previous)) {
    updateHistoryButtonStates();
    renderHistoryTimeline();
    renderAll();
    showToast(`Undo: ${previous.label}`);
    return true;
  }
  
  return false;
}

function redo() {
  if (history.redoStack.length === 0) return false;
  
  const currentSnapshot = captureStateSnapshot('Checkpoint');
  history.undoStack.push(currentSnapshot);
  
  const next = history.redoStack.pop();
  if (restoreStateSnapshot(next)) {
    updateHistoryButtonStates();
    renderHistoryTimeline();
    renderAll();
    showToast(`Redo: ${next.label}`);
    return true;
  }
  
  return false;
}

function updateHistoryButtonStates() {
  if (els.undoBtn) {
    els.undoBtn.disabled = history.undoStack.length === 0;
    els.undoBtn.title = history.undoStack.length > 0 
      ? `Undo: ${history.undoStack[history.undoStack.length - 1].label}`
      : 'No undo available';
  }
  if (els.redoBtn) {
    els.redoBtn.disabled = history.redoStack.length === 0;
    els.redoBtn.title = history.redoStack.length > 0
      ? `Redo: ${history.redoStack[history.redoStack.length - 1].label}`
      : 'No redo available';
  }
}
const imageCache = new Map();
let toastTimer = null;
let transparentDragImage = null;

const ratioToCanvas = {
  '16:9': { width: 1280, height: 720, ppt: { w: 13.333, h: 7.5 }, layout: 'LAYOUT_WIDE' },
  '4:3': { width: 1200, height: 900, ppt: { w: 10, h: 7.5 }, layout: 'LAYOUT_STANDARD' }
};

function uid() {
  return Math.random().toString(36).slice(2, 11);
}

function lucidId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789~_.';
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isEditableElement(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable="true"]')) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function getSizeLabel(type, value) {
  const sizes = {
    gapX: [
      { threshold: 5, label: 'compact' },
      { threshold: 10, label: 'xtra-small' },
      { threshold: 15, label: 'small' },
      { threshold: 20, label: 'medium' },
      { threshold: 25, label: 'xtra-medium' },
      { threshold: 30, label: 'large' },
      { threshold: 40, label: 'xtra-large' }
    ],
    gapY: [
      { threshold: 5, label: 'compact' },
      { threshold: 10, label: 'xtra-small' },
      { threshold: 15, label: 'small' },
      { threshold: 20, label: 'medium' },
      { threshold: 25, label: 'xtra-medium' },
      { threshold: 30, label: 'large' },
      { threshold: 40, label: 'xtra-large' }
    ],
    cellWidth: [
      { threshold: 70, label: 'compact' },
      { threshold: 100, label: 'xtra-small' },
      { threshold: 130, label: 'small' },
      { threshold: 160, label: 'medium' },
      { threshold: 190, label: 'xtra-medium' },
      { threshold: 230, label: 'large' },
      { threshold: 300, label: 'xtra-large' }
    ],
    cellHeight: [
      { threshold: 70, label: 'compact' },
      { threshold: 95, label: 'xtra-small' },
      { threshold: 110, label: 'small' },
      { threshold: 120, label: 'medium' },
      { threshold: 150, label: 'xtra-medium' },
      { threshold: 200, label: 'large' },
      { threshold: 300, label: 'xtra-large' }
    ],
    textSize: [
      { threshold: 10, label: 'compact' },
      { threshold: 12, label: 'xtra-small' },
      { threshold: 14, label: 'small' },
      { threshold: 16, label: 'medium' },
      { threshold: 18, label: 'xtra-medium' },
      { threshold: 24, label: 'large' },
      { threshold: 32, label: 'xtra-large' }
    ]
  };
  
  const scale = sizes[type] || [];
  for (const { threshold, label } of scale) {
    if (value <= threshold) return label;
  }
  return scale[scale.length - 1]?.label || 'large';
}

function updateSizeLabel(inputId, labelId) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (!input || !label) return;
  const value = Number(input.value);
  const type = inputId.replace('Input', '');
  label.textContent = getSizeLabel(type, value);
}

function showToast(message, duration = 2200) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('show');
  if (els.toastStatus) {
    els.toastStatus.textContent = message;
  }
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, duration);
}

function showDragTooltip(clientX, clientY, mode, text) {
  if (!els.dragTooltip) return;
  els.dragTooltip.textContent = text;
  els.dragTooltip.className = `drag-tooltip mode-${mode}`;
  els.dragTooltip.style.left = `${clientX + 16}px`;
  els.dragTooltip.style.top = `${clientY - 36}px`;
}

function ensureDragTooltipImage(event) {
  if (!event?.dataTransfer) return;
  if (!transparentDragImage) {
    transparentDragImage = document.createElement('canvas');
    transparentDragImage.width = 1;
    transparentDragImage.height = 1;
  }
  event.dataTransfer.setDragImage(transparentDragImage, 0, 0);
}

function hideDragTooltip() {
  if (!els.dragTooltip) return;
  els.dragTooltip.className = 'drag-tooltip hidden';
}

function confirmAction(message) {
  return window.confirm(message);
}

function isFileDrag(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  if (Array.from(dt.types || []).includes('Files')) return true;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.items && dt.items.length > 0) {
    for (const item of dt.items) {
      if (item.kind === 'file') return true;
    }
  }
  return false;
}

function getDisplayName(name) {
  if (!name) return 'Untitled image';
  const withoutExtension = String(name).replace(/\.[^.]+$/, '');
  const normalized = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || withoutExtension || String(name);
}

function getBaseCanvasSize() {
  return ratioToCanvas[state.slideRatio] || ratioToCanvas['16:9'];
}

function resetCanvasLayout() {
  const base = getBaseCanvasSize();
  state.canvasWidth = base.width;
  state.canvasHeight = base.height;
  state.contentOffsetX = 0;
  state.contentOffsetY = 0;
}

function normalizeColumnGaps({ reset = false } = {}) {
  const gapCount = Math.max(0, state.cols - 1);
  const fallback = clamp(Number(state.globalGapX ?? state.gapX ?? 12) || 12, 0, 120);
  state.globalGapX = fallback;
  state.gapX = fallback;

  const source = Array.isArray(state.columnGaps) ? state.columnGaps : [];
  const next = new Array(gapCount);
  for (let i = 0; i < gapCount; i += 1) {
    if (!reset && Number.isFinite(source[i])) {
      next[i] = clamp(Number(source[i]), 0, 120);
    } else {
      next[i] = fallback;
    }
  }
  state.columnGaps = next;
}

function getGapAfterColumn(colIndex) {
  if (!Number.isInteger(colIndex)) return 0;
  if (colIndex < 0 || colIndex >= Math.max(0, state.cols - 1)) return 0;
  const gap = state.columnGaps[colIndex];
  return Number.isFinite(gap) ? gap : state.globalGapX;
}

function getColumnOffsets(cellWidth = state.cellWidth || 160) {
  const offsets = [];
  let x = 0;
  for (let col = 0; col < state.cols; col += 1) {
    offsets.push(x);
    x += cellWidth + getGapAfterColumn(col);
  }
  return offsets;
}

function getLayoutMetrics() {
  const cellWidth = state.cellWidth || 160;
  const cellHeight = state.cellHeight || 120;
  const columnOffsets = getColumnOffsets(cellWidth);
  const innerWidth = state.cols > 0
    ? (columnOffsets[state.cols - 1] + cellWidth)
    : cellWidth;
  const innerHeight = cellHeight * state.rows + state.gapY * Math.max(0, state.rows - 1);
  const width = innerWidth;
  const height = innerHeight;
  return {
    width,
    height,
    cellWidth,
    cellHeight,
    columnOffsets,
    offsetX: 0,
    offsetY: 0
  };
}

function resizeGridWithDirectionalExpansion({ left = 0, right = 0, top = 0, bottom = 0 }) {
  const addCols = left + right;
  const addRows = top + bottom;
  if (addCols === 0 && addRows === 0) {
    return { changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const metrics = getLayoutMetrics();
  // No upper bound here: GRID_LIMIT is only a UI-stepper/search-window
  // constant, not a real grid-size cap (see restoreSession() above). Clamping
  // the *absolute* next size to GRID_LIMIT used to silently shrink any grid
  // already larger than 20 rows/cols (e.g. from Auto Pack on a big import)
  // down to 20 the moment a drag-to-edge auto-expand added even one more
  // row/column — this only ever grows the grid, so just floor at 1.
  const nextCols = Math.max(1, state.cols + addCols);
  const nextRows = Math.max(1, state.rows + addRows);
  const actualColsAdded = nextCols - state.cols;
  const actualRowsAdded = nextRows - state.rows;
  if (actualColsAdded === 0 && actualRowsAdded === 0) {
    return { changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const appliedLeft = Math.min(left, actualColsAdded);
  const appliedRight = Math.max(0, actualColsAdded - appliedLeft);
  const appliedTop = Math.min(top, actualRowsAdded);
  const appliedBottom = Math.max(0, actualRowsAdded - appliedTop);

  const colStride = metrics.cellWidth + state.globalGapX;
  const rowStride = metrics.cellHeight + state.gapY;
  const oldRows = state.rows;
  const oldCols = state.cols;
  const oldGrid = state.grid.slice();
  const newGrid = new Array(nextRows * nextCols).fill(null);

  for (let r = 0; r < oldRows; r += 1) {
    for (let c = 0; c < oldCols; c += 1) {
      const oldIndex = r * oldCols + c;
      const nextIndex = (r + appliedTop) * nextCols + (c + appliedLeft);
      if (nextIndex >= 0 && nextIndex < newGrid.length) {
        newGrid[nextIndex] = oldGrid[oldIndex] || null;
      }
    }
  }

  state.canvasWidth += colStride * actualColsAdded;
  state.canvasHeight += rowStride * actualRowsAdded;

  // Keep existing content visually anchored while left/top edges grow outward.
  if (appliedLeft > 0) {
    state.panX -= colStride * appliedLeft * state.zoom;
  }
  if (appliedTop > 0) {
    state.panY -= rowStride * appliedTop * state.zoom;
  }

  const previousGaps = state.columnGaps.slice();
  state.rows = nextRows;
  state.cols = nextCols;
  if (actualColsAdded > 0) {
    const leftGaps = new Array(appliedLeft).fill(state.globalGapX);
    const rightGaps = new Array(appliedRight).fill(state.globalGapX);
    state.columnGaps = leftGaps.concat(previousGaps, rightGaps);
  }
  normalizeColumnGaps();
  state.grid = newGrid;

  if (state.selectedSlotIndex != null) {
    const selectedRow = Math.floor(state.selectedSlotIndex / oldCols);
    const selectedCol = state.selectedSlotIndex % oldCols;
    const nextSelectedRow = selectedRow + appliedTop;
    const nextSelectedCol = selectedCol + appliedLeft;
    state.selectedSlotIndex = nextSelectedRow * nextCols + nextSelectedCol;
  }

  if (state.previewModalOpen && state.previewSlotIndex != null) {
    const previewRow = Math.floor(state.previewSlotIndex / oldCols);
    const previewCol = state.previewSlotIndex % oldCols;
    const nextPreviewRow = previewRow + appliedTop;
    const nextPreviewCol = previewCol + appliedLeft;
    state.previewSlotIndex = nextPreviewRow * nextCols + nextPreviewCol;
  }

  if (state.keyboardPlacement?.type === 'slot' && Number.isInteger(state.keyboardPlacement.slotIndex)) {
    const sourceRow = Math.floor(state.keyboardPlacement.slotIndex / oldCols);
    const sourceCol = state.keyboardPlacement.slotIndex % oldCols;
    state.keyboardPlacement.slotIndex = (sourceRow + appliedTop) * nextCols + (sourceCol + appliedLeft);
  }

  if (state.dragPayload?.type === 'slot' && Number.isInteger(state.dragPayload.slotIndex)) {
    const dragRow = Math.floor(state.dragPayload.slotIndex / oldCols);
    const dragCol = state.dragPayload.slotIndex % oldCols;
    state.dragPayload.slotIndex = (dragRow + appliedTop) * nextCols + (dragCol + appliedLeft);
  }

  if (state.dragPayload?.type === 'group' && Array.isArray(state.dragPayload.slotIndices)) {
    state.dragPayload.slotIndices = state.dragPayload.slotIndices
      .map(index => {
        if (!Number.isInteger(index)) return null;
        const dragRow = Math.floor(index / oldCols);
        const dragCol = index % oldCols;
        return (dragRow + appliedTop) * nextCols + (dragCol + appliedLeft);
      })
      .filter(index => index != null);
  }

  state.multiSelectedSlots = state.multiSelectedSlots
    .map(index => {
      if (!Number.isInteger(index)) return null;
      const selRow = Math.floor(index / oldCols);
      const selCol = index % oldCols;
      return (selRow + appliedTop) * nextCols + (selCol + appliedLeft);
    })
    .filter(index => index != null);

  return {
    changed: true,
    left: appliedLeft,
    right: appliedRight,
    top: appliedTop,
    bottom: appliedBottom
  };
}

function shrinkGridWithDirectionalReduction({ left = 0, right = 0, top = 0, bottom = 0 }) {
  const removeCols = left + right;
  const removeRows = top + bottom;
  if (removeCols === 0 && removeRows === 0) {
    return { changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const metrics = getLayoutMetrics();
  const maxColsRemovable = Math.max(0, state.cols - 1);
  const maxRowsRemovable = Math.max(0, state.rows - 1);
  const nextCols = state.cols - Math.min(removeCols, maxColsRemovable);
  const nextRows = state.rows - Math.min(removeRows, maxRowsRemovable);
  const actualColsRemoved = state.cols - nextCols;
  const actualRowsRemoved = state.rows - nextRows;
  if (actualColsRemoved === 0 && actualRowsRemoved === 0) {
    return { changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const appliedLeft = Math.min(left, actualColsRemoved);
  const appliedRight = Math.max(0, actualColsRemoved - appliedLeft);
  const appliedTop = Math.min(top, actualRowsRemoved);
  const appliedBottom = Math.max(0, actualRowsRemoved - appliedTop);

  const oldRows = state.rows;
  const oldCols = state.cols;
  const oldGrid = state.grid.slice();
  const newGrid = new Array(nextRows * nextCols).fill(null);

  for (let r = 0; r < nextRows; r += 1) {
    for (let c = 0; c < nextCols; c += 1) {
      const sourceRow = r + appliedTop;
      const sourceCol = c + appliedLeft;
      const oldIndex = sourceRow * oldCols + sourceCol;
      const nextIndex = r * nextCols + c;
      newGrid[nextIndex] = oldGrid[oldIndex] || null;
    }
  }

  const colStride = metrics.cellWidth + state.globalGapX;
  const rowStride = metrics.cellHeight + state.gapY;
  state.canvasWidth = Math.max(1, state.canvasWidth - colStride * actualColsRemoved);
  state.canvasHeight = Math.max(1, state.canvasHeight - rowStride * actualRowsRemoved);

  // Mirror expansion compensation so left/top shrink does not jump content.
  if (appliedLeft > 0) {
    state.panX += colStride * appliedLeft * state.zoom;
  }
  if (appliedTop > 0) {
    state.panY += rowStride * appliedTop * state.zoom;
  }

  const nextGaps = state.columnGaps.slice();
  if (appliedLeft > 0) {
    nextGaps.splice(0, appliedLeft);
  }
  if (appliedRight > 0) {
    nextGaps.splice(Math.max(0, nextGaps.length - appliedRight), appliedRight);
  }

  state.rows = nextRows;
  state.cols = nextCols;
  state.columnGaps = nextGaps;
  normalizeColumnGaps();
  state.grid = newGrid;

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / oldCols) - appliedTop;
    const col = (index % oldCols) - appliedLeft;
    if (row < 0 || row >= nextRows || col < 0 || col >= nextCols) return null;
    return row * nextCols + col;
  };

  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }
  if (state.keyboardPlacement?.type === 'slot' && Number.isInteger(state.keyboardPlacement.slotIndex)) {
    const mappedSource = mapIndex(state.keyboardPlacement.slotIndex);
    if (mappedSource == null) {
      state.keyboardPlacement = null;
    } else {
      state.keyboardPlacement.slotIndex = mappedSource;
    }
  }
  if (state.dragPayload?.type === 'slot' && Number.isInteger(state.dragPayload.slotIndex)) {
    const mappedDragIndex = mapIndex(state.dragPayload.slotIndex);
    if (mappedDragIndex != null) {
      state.dragPayload.slotIndex = mappedDragIndex;
    }
  }

  if (state.dragPayload?.type === 'group' && Array.isArray(state.dragPayload.slotIndices)) {
    state.dragPayload.slotIndices = state.dragPayload.slotIndices
      .map(mapIndex)
      .filter(index => index != null);
  }

  state.multiSelectedSlots = state.multiSelectedSlots
    .map(mapIndex)
    .filter(index => index != null);

  return {
    changed: true,
    left: appliedLeft,
    right: appliedRight,
    top: appliedTop,
    bottom: appliedBottom
  };
}

function openSessionDatabase() {
  if (sessionDbPromise) return sessionDbPromise;

  sessionDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    const request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_DB_STORE)) {
        db.createObjectStore(SESSION_DB_STORE);
      }
      if (!db.objectStoreNames.contains(ASSET_BLOB_STORE)) {
        db.createObjectStore(ASSET_BLOB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });

  return sessionDbPromise;
}

// ── Full-resolution asset storage (IndexedDB) ────────────────────────────────
// These hold the original, full-quality file bytes for every imported image.
// `state.assets` (and history/session snapshots of it) never carries this
// data directly — only a small `thumbUrl`. Callers pull the real bytes back
// out, on demand, right before an export/copy/full-preview needs them.

async function writeAssetBlob(id, blob) {
  try {
    const db = await openSessionDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ASSET_BLOB_STORE, 'readwrite');
      transaction.objectStore(ASSET_BLOB_STORE).put(blob, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB asset write failed'));
    });
  } catch {
    // IndexedDB can be unavailable in some file:// or privacy contexts; the
    // asset simply stays thumbnail-only (export falls back to the thumbnail).
  }
}

async function readAssetBlob(id) {
  try {
    const db = await openSessionDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(ASSET_BLOB_STORE, 'readonly');
      const request = transaction.objectStore(ASSET_BLOB_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB asset read failed'));
    });
  } catch {
    return null;
  }
}

async function deleteAssetBlobs(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const db = await openSessionDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ASSET_BLOB_STORE, 'readwrite');
      const store = transaction.objectStore(ASSET_BLOB_STORE);
      for (const id of ids) store.delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB asset delete failed'));
    });
  } catch {
    // best-effort cleanup only
  }
}

// Deletes any stored blob whose asset id is no longer referenced by the
// current assets list *or* by anything still reachable via undo/redo, so
// removing/replacing images can't silently break Ctrl+Z fidelity.
async function pruneOrphanedAssetBlobs() {
  try {
    const db = await openSessionDatabase();
    const referenced = new Set(state.assets.map(asset => asset.id));
    for (const snapshot of history.undoStack) {
      for (const asset of snapshot.state.assets) referenced.add(asset.id);
    }
    for (const snapshot of history.redoStack) {
      for (const asset of snapshot.state.assets) referenced.add(asset.id);
    }

    const allKeys = await new Promise((resolve, reject) => {
      const transaction = db.transaction(ASSET_BLOB_STORE, 'readonly');
      const request = transaction.objectStore(ASSET_BLOB_STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('IndexedDB key scan failed'));
    });

    const orphaned = allKeys.filter(key => !referenced.has(key));
    if (orphaned.length > 0) {
      await deleteAssetBlobs(orphaned);
    }
  } catch {
    // best-effort cleanup only
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Resolves the true full-resolution data URL for one asset, falling back to
// its thumbnail if the original was never stored (e.g. IndexedDB unavailable).
async function getFullResDataUrl(assetId) {
  const asset = findAssetById(assetId);
  if (!asset) return null;
  const blob = await readAssetBlob(assetId);
  if (!blob) return asset.thumbUrl || null;
  try {
    return await blobToDataUrl(blob);
  } catch {
    return asset.thumbUrl || null;
  }
}

// Batch form of getFullResDataUrl, used right before export/copy operations
// that need several assets at once (only reads each unique id once).
async function getFullResDataUrls(assetIds) {
  const uniqueIds = [...new Set(assetIds)];
  const entries = await Promise.all(uniqueIds.map(async id => [id, await getFullResDataUrl(id)]));
  return new Map(entries);
}

// Same idea, but returns short-lived Object URLs (cheaper than base64 data
// URLs) for drawing full-resolution images onto a canvas. Callers must
// revoke every URL in the returned map once done.
async function getFullResObjectUrls(assetIds) {
  const uniqueIds = [...new Set(assetIds)];
  const entries = await Promise.all(uniqueIds.map(async id => {
    const blob = await readAssetBlob(id);
    return [id, blob ? URL.createObjectURL(blob) : null];
  }));
  return new Map(entries);
}

// Loads an image without adding it to the shared `imageCache` — used for
// one-off, full-resolution decodes (thumbnail generation, full-res export)
// so large decoded bitmaps aren't kept alive indefinitely.
function loadImageOnce(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Downscales a decoded image to THUMB_MAX_DIM (longest edge) and returns a
// small data URL for grid/tray display. PNG is kept for anything that isn't
// already a lossy JPEG so transparency (icons, diagrams, etc. — the whole
// point of a "PNG Grid") survives; the dimension downscale is what actually
// saves the memory, not the encoding.
function createThumbnail(image, mimeType) {
  const longestEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(1, longestEdge));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);

  return mimeType === 'image/jpeg'
    ? canvas.toDataURL('image/jpeg', 0.85)
    : canvas.toDataURL('image/png');
}

async function readSessionPayloadFromIndexedDb() {
  const db = await openSessionDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_DB_STORE, 'readonly');
    const store = transaction.objectStore(SESSION_DB_STORE);
    const request = store.get(SESSION_STORAGE_KEY);

    request.onsuccess = () => {
      const value = request.result;
      if (!value || typeof value !== 'object') {
        resolve(null);
        return;
      }
      resolve(value);
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
  });
}

async function writeSessionPayloadToIndexedDb(payload) {
  const db = await openSessionDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_DB_STORE, 'readwrite');
    const store = transaction.objectStore(SESSION_DB_STORE);
    store.put(payload, SESSION_STORAGE_KEY);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
  });
}

async function readSessionPayload() {
  try {
    const payload = await readSessionPayloadFromIndexedDb();
    if (payload) return payload;
  } catch {
    // IndexedDB can be unavailable in some file:// or privacy contexts.
  }

  try {
    if (!window.name.startsWith(WINDOW_NAME_SESSION_PREFIX)) return null;
    const raw = window.name.slice(WINDOW_NAME_SESSION_PREFIX.length);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSessionPayload(payload) {
  try {
    await writeSessionPayloadToIndexedDb(payload);
  } catch {
    // ignored; fallback below keeps file:// sessions working in the same tab.
  }

  try {
    window.name = `${WINDOW_NAME_SESSION_PREFIX}${JSON.stringify(payload)}`;
  } catch {
    // ignored
  }
}

function updateStatChips() {
  const assigned = state.grid.filter(Boolean).length;
  if (els.assetCount) {
    els.assetCount.textContent = `${state.assets.length} image${state.assets.length === 1 ? '' : 's'}`;
  }
  if (els.slotCount) {
    els.slotCount.textContent = `${state.grid.length} slots`;
  }
  if (els.assignedCount) {
    els.assignedCount.textContent = `${assigned} placed`;
  }
}

function persistSession() {
  const payload = {
    assets: state.assets,
    grid: state.grid,
    rows: state.rows,
    cols: state.cols,
    globalGapX: state.globalGapX,
    columnGaps: state.columnGaps,
    gapX: state.gapX,
    gapY: state.gapY,
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    contentOffsetX: state.contentOffsetX,
    contentOffsetY: state.contentOffsetY,
    holdingAssetIds: state.holdingAssetIds,
    fit: 'contain',
    cellWidth: state.cellWidth,
    cellHeight: state.cellHeight,
    textSize: state.textSize
  };

  void writeSessionPayload(payload);
}

async function restoreSession() {
  try {
    const saved = await readSessionPayload();
    if (!saved) return false;

    state.assets = Array.isArray(saved.assets) ? saved.assets : [];
    // No upper bound here: GRID_LIMIT is only a UI-stepper/search-window
    // constant, not a real grid-size cap. Clamping to it on restore used to
    // silently truncate large auto-fit grids (e.g. 4x72 -> 4x20) on refresh.
    state.rows = Math.max(1, Math.round(Number(saved.rows || 3)) || 3);
    state.cols = Math.max(1, Math.round(Number(saved.cols || 3)) || 3);
    const legacyGap = clamp(Number(saved.gap || 12), 0, 120);
    state.globalGapX = clamp(Number(saved.globalGapX ?? saved.gapX ?? legacyGap), 0, 120);
    state.gapX = state.globalGapX;
    state.columnGaps = Array.isArray(saved.columnGaps) ? saved.columnGaps.slice() : [];
    normalizeColumnGaps();
    state.gapY = clamp(Number(saved.gapY ?? legacyGap), 0, 120);
    state.cellWidth = clamp(Number(saved.cellWidth || 160), 40, 500);
    state.cellHeight = clamp(Number(saved.cellHeight || 120), 40, 500);
    state.textSize = clamp(Number(saved.textSize || 12), 8, 32);
    state.fit = 'contain';

    state.canvasWidth = Math.max(1, Number(saved.canvasWidth || 1280));
    state.canvasHeight = Math.max(1, Number(saved.canvasHeight || 720));
    state.contentOffsetX = Math.max(0, Number(saved.contentOffsetX || 0));
    state.contentOffsetY = Math.max(0, Number(saved.contentOffsetY || 0));

    const expectedLength = state.rows * state.cols;
    const rawGrid = Array.isArray(saved.grid) ? saved.grid.slice(0, expectedLength) : [];
    while (rawGrid.length < expectedLength) rawGrid.push(null);
    state.grid = rawGrid;

    const validIds = new Set(state.assets.map(asset => asset.id));
    state.holdingAssetIds = Array.isArray(saved.holdingAssetIds)
      ? saved.holdingAssetIds.filter(id => validIds.has(id))
      : [];

    normalizeGridReferences();
    fillUnplacedIntoEmpty();
    return state.assets.length > 0 || state.grid.some(Boolean);
  } catch {
    return false;
  }
}

function findAssetById(id) {
  return state.assets.find(asset => asset.id === id) || null;
}

function syncSettingsInputs() {
  els.rowsInput.value = String(state.rows);
  els.colsInput.value = String(state.cols);
  els.gapXInput.value = String(state.globalGapX);
  els.gapYInput.value = String(state.gapY);
  els.cellWidthInput.value = String(state.cellWidth);
  els.cellHeightInput.value = String(state.cellHeight);
  state.fit = 'contain';
  document.documentElement.style.setProperty('--cols', String(state.cols));
}

function getFitCanvasZoom() {
  if (!els.canvasViewport) return 1;
  const viewportWidth = Math.max(1, els.canvasViewport.clientWidth);
  const viewportHeight = Math.max(1, els.canvasViewport.clientHeight);
  const baseWidth = Math.max(1, state.canvasWidth);
  const baseHeight = Math.max(1, state.canvasHeight);
  return Math.min(viewportWidth / baseWidth, viewportHeight / baseHeight) * 0.92;
}

function clampZoom(value) {
  const fitZoom = Math.max(0.0001, getFitCanvasZoom());
  const minZoom = fitZoom * 0.01;
  const maxZoom = fitZoom * 8;
  return clamp(value, minZoom, maxZoom);
}

function updateZoomLabel() {
  if (!els.zoomLabel) return;
  const fitZoom = Math.max(0.0001, getFitCanvasZoom());
  const percent = Math.round((state.zoom / fitZoom) * 100);
  els.zoomLabel.textContent = `${percent}%`;
}

function applyCanvasTransform() {
  if (!els.canvasStage) return;
  els.canvasStage.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
  updateZoomLabel();
}

// Resizes the grid container to the current zoom level without touching any
// cell DOM nodes. Cell frames are positioned with percentages (see
// createGridCell/createGridEdgeButtons), so they automatically rescale when
// the container's pixel size changes — no need to tear down and recreate
// every cell (and re-decode every image) just because the zoom level moved.
function applyZoomSize() {
  if (!els.grid) return;
  const metrics = getLayoutMetrics();
  els.grid.style.width = `${metrics.width * state.zoom}px`;
  els.grid.style.height = `${metrics.height * state.zoom}px`;
}

function updateViewportLayout() {
  const targetWidth = 1480;
  const targetHeight = 900;
  const widthScale = window.innerWidth / targetWidth;
  const heightScale = window.innerHeight / targetHeight;
  const baseScale = clamp(Math.min(widthScale, heightScale), 0.82, 1);
  const uiScale = baseScale * state.uiScalePreference;
  document.documentElement.style.setProperty('--ui-scale', uiScale.toFixed(4));

  if (!els.appShell) return;
  const shellStyles = window.getComputedStyle(els.appShell);
  const gap = Number.parseFloat(shellStyles.rowGap || shellStyles.gap || '0') || 0;
  const padTop = Number.parseFloat(shellStyles.paddingTop || '0') || 0;
  const padBottom = Number.parseFloat(shellStyles.paddingBottom || '0') || 0;
  const topbarHeight = els.topbar ? els.topbar.offsetHeight : 0;
  const available = window.innerHeight - padTop - padBottom - topbarHeight - gap;
  const workspaceHeight = Math.max(420, Math.floor(available));
  document.documentElement.style.setProperty('--workspace-height', `${workspaceHeight}px`);
}

function centerCanvasView() {
  if (!els.canvasViewport || !els.grid) return;
  const viewportWidth = els.canvasViewport.clientWidth;
  const viewportHeight = els.canvasViewport.clientHeight;
  const baseWidth = els.grid.offsetWidth;
  const baseHeight = els.grid.offsetHeight;

  state.panX = (viewportWidth - baseWidth) / 2;
  state.panY = (viewportHeight - baseHeight) / 2;
  applyCanvasTransform();
}

function fitCanvasView({ recenter = true } = {}) {
  if (!els.canvasViewport || !els.grid) return;
  const fitZoom = getFitCanvasZoom();
  state.zoom = clampZoom(fitZoom);
  renderGrid();
  if (recenter) {
    centerCanvasView();
  }
}

function zoomAt(clientX, clientY, zoomDelta) {
  if (!els.canvasViewport) return;

  const rect = els.canvasViewport.getBoundingClientRect();
  const anchorX = clientX - rect.left;
  const anchorY = clientY - rect.top;
  const prevZoom = state.zoom;
  const nextZoom = clampZoom(state.zoom * zoomDelta);
  if (Math.abs(nextZoom - prevZoom) < 0.0001) return;

  const worldX = (anchorX - state.panX) / prevZoom;
  const worldY = (anchorY - state.panY) / prevZoom;
  state.zoom = nextZoom;
  state.panX = anchorX - worldX * nextZoom;
  state.panY = anchorY - worldY * nextZoom;
  // Zooming never changes which images are placed — just their on-screen
  // scale — so only resize the grid container instead of rebuilding every
  // cell (which would otherwise re-decode every image on each wheel tick).
  applyZoomSize();
  applyCanvasTransform();
}

function ensureGridShape() {
  resizeGridPreserve(state.rows, state.cols);
}

function normalizeFirstRowOffset(offset, cols) {
  const safeCols = Math.max(1, Number(cols) || 1);
  return clamp(Number(offset) || 0, 0, Math.max(0, safeCols - 1));
}

function capacityForDims(rows, cols, firstRowOffset = 0) {
  const safeRows = Math.max(0, Number(rows) || 0);
  const safeCols = Math.max(1, Number(cols) || 1);
  const offset = normalizeFirstRowOffset(firstRowOffset, safeCols);
  if (safeRows <= 0) return 0;
  const firstRowCapacity = Math.max(0, safeCols - offset);
  if (safeRows === 1) return firstRowCapacity;
  return firstRowCapacity + (safeRows - 1) * safeCols;
}

function recommendedDims(count, firstRowOffset = 0) {
  if (count <= 0) return { rows: 1, cols: 1 };
  let best = null;
  const minCols = Math.max(1, Number(firstRowOffset) + 1);
  // Search a range wide enough to find a good square-ish fit for any asset
  // count, instead of being artificially capped at GRID_LIMIT — a large
  // import (e.g. a 300-page PDF) should still get a sensible recommendation.
  const idealSide = Math.ceil(Math.sqrt(count));
  const maxCols = Math.max(GRID_LIMIT, idealSide * 2, minCols);

  for (let cols = minCols; cols <= maxCols; cols += 1) {
    const rows = minRowsForCols(cols, count, firstRowOffset);
    const area = rows * cols;
    const aspectDelta = Math.abs(rows - cols);
    // Weight aspect ratio more heavily (prefer square layouts)
    // aspectDelta weighted at 50x means a 1-unit aspect difference = 50 area units
    const score = area + aspectDelta * 50;
    if (!best || score < best.score) {
      best = { rows, cols, score };
    }
  }

  if (!best) {
    return { rows: count, cols: 1 };
  }

  const rows = best.rows;
  const cols = best.cols;
  return { rows, cols };
}

function minRowsForCols(cols, count, firstRowOffset = 0) {
  const minCols = Math.max(1, Number(firstRowOffset) + 1);
  const safeCols = Math.max(minCols, Number(cols) || 1);
  const remaining = Math.max(0, Number(count) || 0);
  if (remaining === 0) return 1;

  const offset = normalizeFirstRowOffset(firstRowOffset, safeCols);
  const firstRowCapacity = Math.max(0, safeCols - offset);
  if (remaining <= firstRowCapacity) return 1;
  return 1 + Math.ceil((remaining - firstRowCapacity) / safeCols);
}

function minColsForRows(rows, count, firstRowOffset = 0) {
  const safeRows = Math.max(1, Number(rows) || 1);
  const required = Math.max(0, Number(count) || 0);
  const offset = Math.max(0, Number(firstRowOffset) || 0);
  const minCols = Math.max(1, offset + 1);
  if (required === 0) return minCols;

  // capacityForDims(rows, cols, offset) === safeRows * cols - offset for any
  // cols > offset, so solve for the smallest cols that satisfies capacity >= required.
  const neededCols = Math.ceil((required + offset) / safeRows);
  return Math.max(minCols, neededCols);
}

function allAssignedIds(gridValues) {
  const ids = [];
  for (const value of gridValues) {
    if (value) ids.push(value);
  }
  return ids;
}

function findNextEmptySlot(grid, startIndex = 0, endIndex = grid.length) {
  const from = clamp(Math.floor(startIndex), 0, grid.length);
  const to = clamp(Math.floor(endIndex), 0, grid.length);
  for (let i = from; i < to; i += 1) {
    if (grid[i] === null) return i;
  }
  return -1;
}

function resizeGridPreserve(newRows, newCols, { preserveLeadingGaps = false } = {}) {
  const oldRows = state.rows;
  const oldCols = state.cols;
  const oldGrid = state.grid.slice();
  const newGrid = new Array(newRows * newCols).fill(null);
  const copied = new Set();

  for (let r = 0; r < Math.min(oldRows, newRows); r += 1) {
    for (let c = 0; c < Math.min(oldCols, newCols); c += 1) {
      const oldIndex = r * oldCols + c;
      const newIndex = r * newCols + c;
      const value = oldGrid[oldIndex] || null;
      newGrid[newIndex] = value;
      if (value) copied.add(value + ':' + oldIndex);
    }
  }

  const survivors = allAssignedIds(oldGrid);
  let appendStart = 0;
  if (preserveLeadingGaps) {
    for (let i = newGrid.length - 1; i >= 0; i -= 1) {
      if (newGrid[i]) {
        appendStart = i + 1;
        break;
      }
    }
  }
  const overflow = [];
  for (const id of survivors) {
    let alreadyPlaced = false;
    for (const v of newGrid) {
      if (v === id) {
        alreadyPlaced = true;
        break;
      }
    }
    if (alreadyPlaced) continue;
    let empty = -1;
    if (preserveLeadingGaps) {
      // Keep intentionally blank leading slots (for manual offsets/spreads)
      // unless we run out of trailing capacity.
      empty = findNextEmptySlot(newGrid, appendStart, newGrid.length);
      if (empty < 0) {
        empty = findNextEmptySlot(newGrid, 0, appendStart);
      }
    } else {
      empty = newGrid.findIndex(v => v === null);
    }
    if (empty >= 0) {
      newGrid[empty] = id;
    } else {
      overflow.push(id);
    }
  }

  const colsChanged = state.cols !== newCols;
  state.rows = newRows;
  state.cols = newCols;
  if (colsChanged) {
    normalizeColumnGaps();
  }
  state.grid = newGrid;
  return overflow;
}

async function loadImage(src) {
  if (imageCache.has(src)) {
    return imageCache.get(src);
  }
  const imagePromise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  imageCache.set(src, imagePromise);
  return imagePromise;
}

function objectFitRect(container, source, fit) {
  const containerRatio = container.width / container.height;
  const sourceRatio = source.width / source.height;
  let width = container.width;
  let height = container.height;
  let x = container.x;
  let y = container.y;

  if (fit === 'contain') {
    if (sourceRatio > containerRatio) {
      height = width / sourceRatio;
      y += (container.height - height) / 2;
    } else {
      width = height * sourceRatio;
      x += (container.width - width) / 2;
    }
  } else if (sourceRatio > containerRatio) {
    width = height * sourceRatio;
    x -= (width - container.width) / 2;
  } else {
    height = width / sourceRatio;
    y -= (height - container.height) / 2;
  }

  return { x, y, width, height };
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeGridReferences() {
  const validIds = new Set(state.assets.map(asset => asset.id));
  state.grid = state.grid.map(assetId => (assetId && validIds.has(assetId) ? assetId : null));
}

function placeSequenceInGrid(sequence, firstRowOffset = 0) {
  const next = new Array(state.rows * state.cols).fill(null);
  const startIndex = normalizeFirstRowOffset(firstRowOffset, state.cols);
  const placeable = Math.max(0, next.length - startIndex);
  const count = Math.min(placeable, sequence.length);
  for (let i = 0; i < count; i += 1) {
    next[startIndex + i] = sequence[i];
  }
  state.grid = next;
}

function placeLayoutInGrid(layout) {
  const next = new Array(state.rows * state.cols).fill(null);
  const count = Math.min(next.length, layout.length);
  for (let i = 0; i < count; i += 1) {
    next[i] = layout[i] ?? null;
  }
  state.grid = next;
}

function queueOverflowSequence(sequence, options = {}) {
  const firstRowOffset = normalizeFirstRowOffset(options.firstRowOffset || 0, state.cols);
  state.pendingGridSequence = sequence.slice();
  state.pendingGridIsLayout = false;
  state.pendingGridPlacementOffset = firstRowOffset;
  placeSequenceInGrid(sequence, firstRowOffset);
  openOverflowModal(sequence.length, firstRowOffset);
}

function queueOverflowLayout(layout) {
  state.pendingGridSequence = layout.slice();
  state.pendingGridIsLayout = true;
  state.pendingGridPlacementOffset = 0;
  placeLayoutInGrid(layout);
  openOverflowModal(layout.filter(Boolean).length, 0);
}

function fillUnplacedIntoEmpty() {
  const assigned = new Set(state.grid.filter(Boolean));
  const held = new Set(state.holdingAssetIds);
  const unplaced = state.assets.filter(asset => !assigned.has(asset.id) && !held.has(asset.id));
  if (unplaced.length === 0) return;

  for (const asset of unplaced) {
    const empty = state.grid.findIndex(slot => slot === null);
    if (empty < 0) break;
    state.grid[empty] = asset.id;
  }
}

function pushAssetsToHolding(assetIds = []) {
  const valid = new Set(state.assets.map(asset => asset.id));
  const current = new Set(state.holdingAssetIds);
  let hadItems = current.size > 0;
  for (const assetId of assetIds) {
    if (!assetId || !valid.has(assetId)) continue;
    current.add(assetId);
  }
  state.holdingAssetIds = Array.from(current);
  // Auto-open tray if new items added
  if (state.holdingAssetIds.length > 0 && !hadItems && els.imageTrayPanel) {
    els.imageTrayPanel.classList.remove('collapsed');
    if (els.toggleTrayBtn) {
      els.toggleTrayBtn.setAttribute('aria-expanded', 'true');
    }
  }
}

function removeAssetFromHolding(assetId) {
  state.holdingAssetIds = state.holdingAssetIds.filter(id => id !== assetId);
}

function removeAssetFromTray(assetId) {
  state.holdingAssetIds = state.holdingAssetIds.filter(id => id !== assetId);
  state.assets = state.assets.filter(asset => asset.id !== assetId);
  void pruneOrphanedAssetBlobs();
  renderAll();
  showToast('Image removed from tray');
}

function clearHoldingTray() {
  if (state.holdingAssetIds.length === 0) {
    showToast('Tray is already empty');
    return;
  }
  if (!confirmAction(`Permanently remove ${state.holdingAssetIds.length} staged image${state.holdingAssetIds.length === 1 ? '' : 's'}?`)) {
    return;
  }
  const idsToRemove = new Set(state.holdingAssetIds);
  state.holdingAssetIds = [];
  state.assets = state.assets.filter(asset => !idsToRemove.has(asset.id));
  void pruneOrphanedAssetBlobs();
  renderAll();
  showToast('Tray cleared');
}

function renderHoldingTray() {
  if (!els.holdingTray) return;
  const validIds = new Set(state.assets.map(asset => asset.id));
  state.holdingAssetIds = state.holdingAssetIds.filter(id => validIds.has(id));

  els.holdingTray.innerHTML = '';
  els.holdingTray.setAttribute('role', 'list');
  if (els.holdingCount) {
    const count = state.holdingAssetIds.length;
    els.holdingCount.textContent = `${count} staged`;
  }
  if (els.holdingCountHandle) {
    const count = state.holdingAssetIds.length;
    els.holdingCountHandle.textContent = `${count} staged`;
  }

  if (state.holdingAssetIds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'holding-empty hint';
    empty.textContent = 'No staged images yet';
    els.holdingTray.appendChild(empty);
    return;
  }

  for (const assetId of state.holdingAssetIds) {
    const asset = findAssetById(assetId);
    if (!asset) continue;
    const tile = document.createElement('div');
    tile.className = 'holding-tile';
    tile.setAttribute('role', 'listitem');

    const placeBtn = document.createElement('button');
    placeBtn.type = 'button';
    placeBtn.className = 'holding-tile-place';
    placeBtn.draggable = true;
    placeBtn.title = `Place ${asset.name}`;
    placeBtn.setAttribute('aria-label', `Place ${asset.name} from the image tray`);

    const img = document.createElement('img');
    img.src = asset.thumbUrl;
    img.alt = '';
    img.draggable = false;
    placeBtn.appendChild(img);

    const label = document.createElement('span');
    label.textContent = asset.name;
    placeBtn.appendChild(label);

    placeBtn.addEventListener('click', () => {
      beginKeyboardPlacementFromTray(assetId);
    });

    placeBtn.addEventListener('dragstart', event => {
      ensureDragTooltipImage(event);
      clearFlowPreview();
      state.dragPayload = { type: 'asset', assetId, source: 'holding' };
      announceDragExpansion(`Dragging staged image ${asset.name}`);
      beginAutoExpandSession();
      state.lastDragExpandAt = 0;
    });

    placeBtn.addEventListener('dragend', () => {
      clearFlowPreview();
      const collapsed = finalizeAutoExpandSession();
      state.dragPayload = null;
      state.lastDragExpandAt = 0;
      clearDragEdgeIndicators();
      if (collapsed) {
        renderAll();
      }
    });

    tile.appendChild(placeBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'holding-tile-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${asset.name} from tray`;
    removeBtn.setAttribute('aria-label', `Remove ${asset.name} from tray`);
    removeBtn.addEventListener('click', event => {
      event.stopPropagation();
      removeAssetFromTray(assetId);
    });
    tile.appendChild(removeBtn);

    els.holdingTray.appendChild(tile);
  }
}

async function fileToAsset(file) {
  const importKey = `${file.name}::${file.size}::${file.lastModified}`;
  const objectUrl = URL.createObjectURL(file);
  let image;
  try {
    image = await loadImageOnce(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const id = uid();
  const thumbUrl = createThumbnail(image, file.type);
  // Full-resolution original stored out-of-band in IndexedDB; `state.assets`
  // only ever holds the (much smaller) thumbnail from here on.
  await writeAssetBlob(id, file);

  return {
    id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    importKey,
    thumbUrl,
    width: image.naturalWidth,
    height: image.naturalHeight
  };
}

async function addFiles(files) {
  const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    showToast('No image files found in selection');
    return;
  }

  const existingKeys = new Set(
    state.assets
      .map(asset => asset.importKey || `${asset.name}::${asset.size ?? ''}::${asset.lastModified ?? ''}`)
      .filter(Boolean)
  );
  const batchKeys = new Set();
  const uniqueFiles = [];
  let skipped = 0;

  for (const file of imageFiles) {
    const key = `${file.name}::${file.size}::${file.lastModified}`;
    if (existingKeys.has(key) || batchKeys.has(key)) {
      skipped += 1;
      continue;
    }
    batchKeys.add(key);
    uniqueFiles.push(file);
  }

  if (uniqueFiles.length === 0) {
    showToast('All selected images are already imported');
    return;
  }

  state.pendingImportFiles = uniqueFiles;
  state.awaitingAppendSelection = false;
  openImportModeModal(uniqueFiles.length);
  if (skipped > 0) {
    showToast(`${skipped} duplicate${skipped === 1 ? '' : 's'} skipped before import mode`);
  }
}

function clearGridSlot(index) {
  if (!state.grid[index]) {
    showToast(`Slot ${index + 1} is already empty`);
    return;
  }
  pushHistory(`Clear slot ${index + 1}`);
  const assetId = state.grid[index];
  state.grid[index] = null;
  state.multiSelectedSlots = state.multiSelectedSlots.filter(slotIndex => slotIndex !== index);
  state.dragPayload = null;
  pushAssetsToHolding([assetId]);
  renderAll();
  showToast(`Moved image to tray from slot ${index + 1}`);
}

async function replaceGridSlot(index) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = false;

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    pushHistory(`Replace slot ${index + 1}`);
    const asset = await fileToAsset(file);
    state.assets.push(asset);
    state.grid[index] = asset.id;
    await renderAll();
    showToast(`Added ${asset.name}`);
  });

  picker.click();
}

function swapGridSlots(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  pushHistory(`Swap slots ${fromIndex + 1} and ${toIndex + 1}`);
  const next = state.grid.slice();
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  state.grid = next;
  state.dragPayload = null;
  renderAll();
}

function placeAssetInSlot(assetId, slotIndex) {
  if (!findAssetById(assetId)) return;
  pushHistory(`Place image in slot ${slotIndex + 1}`);
  removeAssetFromHolding(assetId);

  for (let i = 0; i < state.grid.length; i += 1) {
    if (state.grid[i] === assetId) {
      state.grid[i] = null;
    }
  }

  const displaced = state.grid[slotIndex];
  if (displaced && displaced !== assetId) {
    pushAssetsToHolding([displaced]);
  }

  state.grid[slotIndex] = assetId;
  state.dragPayload = null;
  renderAll();
}

function placeAssetInRowFlow(assetId, targetRow, insertCol) {
  if (!findAssetById(assetId)) return false;
  const safeRow = clamp(targetRow, 0, state.rows - 1);
  const oldCols = state.cols;
  const rowStart = safeRow * oldCols;

  removeAssetFromHolding(assetId);
  const tempGrid = state.grid.slice();
  for (let i = 0; i < tempGrid.length; i += 1) {
    if (tempGrid[i] === assetId) {
      tempGrid[i] = null;
    }
  }

  const rowItems = tempGrid.slice(rowStart, rowStart + oldCols);
  const col = clamp(insertCol, 0, oldCols);
  const leftItems = rowItems.slice(0, col);
  const rightItems = rowItems.slice(col);
  const newRowItems = [...leftItems, assetId, ...rightItems];

  if (newRowItems.length > oldCols) {
    const addCols = newRowItems.length - oldCols;
    const newCols = oldCols + addCols;
    const expandedGrid = [];
    for (let r = 0; r < state.rows; r += 1) {
      for (let c = 0; c < oldCols; c += 1) expandedGrid.push(tempGrid[r * oldCols + c] ?? null);
      for (let c = 0; c < addCols; c += 1) expandedGrid.push(null);
    }
    state.cols = newCols;
    state.grid = expandedGrid;
    state.canvasWidth = Math.max(1, state.canvasWidth + addCols * (state.cellWidth + state.globalGapX));
  } else {
    state.grid = tempGrid;
  }

  const newRowStart = safeRow * state.cols;
  const paddedRow = [...newRowItems];
  while (paddedRow.length < state.cols) paddedRow.push(null);
  for (let c = 0; c < state.cols; c += 1) {
    state.grid[newRowStart + c] = paddedRow[c] ?? null;
  }

  pushHistory(`Insert image into row ${safeRow + 1}`);
  state.selectedSlotIndex = newRowStart + col;
  state.multiSelectedSlots = [];
  state.dragPayload = null;
  renderAll();
  showToast(`Inserted image into row ${safeRow + 1}`);
  return true;
}

function normalizeMultiSelection() {
  state.multiSelectedSlots = state.multiSelectedSlots
    .filter(index => Number.isInteger(index) && index >= 0 && index < state.grid.length && Boolean(state.grid[index]))
    .filter((index, position, array) => array.indexOf(index) === position)
    .sort((a, b) => a - b);
}

function clearGridSelection({ rerender = true } = {}) {
  const hadSelection = state.selectedSlotIndex !== null || state.multiSelectedSlots.length > 0;
  if (!hadSelection) return false;
  state.selectedSlotIndex = null;
  state.multiSelectedSlots = [];
  if (rerender) {
    renderGrid();
  }
  return true;
}

function getSlotRowCol(index) {
  return {
    row: Math.floor(index / state.cols),
    col: index % state.cols
  };
}

function getGridSlotButton(index) {
  if (!els.grid) return null;
  return els.grid.querySelector(`.grid-cell-slot[data-index="${index}"]`);
}

function focusGridSlot(index) {
  const button = getGridSlotButton(index);
  if (!button) return false;
  button.focus();
  return true;
}

function focusAfterRender(index) {
  requestAnimationFrame(() => {
    focusGridSlot(index);
  });
}

function buildSlotAriaLabel(index, assetId = state.grid[index]) {
  const { row, col } = getSlotRowCol(index);
  const parts = [`Slot ${index + 1}`, `row ${row + 1}`, `column ${col + 1}`];
  const asset = assetId ? findAssetById(assetId) : null;

  if (asset) {
    parts.push(`filled with ${getDisplayName(asset.name)}`);
  } else {
    parts.push('empty');
  }

  if (state.selectedSlotIndex === index) {
    parts.push('selected');
  }

  if (state.keyboardPlacement?.type === 'slot' && state.keyboardPlacement.slotIndex === index) {
    parts.push('picked up for move');
  }

  parts.push('Press Enter or Space to select');
  if (asset) {
    parts.push('Press M to move');
    parts.push('Press P to preview');
  }
  if (state.keyboardPlacement) {
    parts.push('Press Enter to place here or Escape to cancel');
    parts.push('Press Shift+Enter to insert with row reflow');
  }

  return parts.join(', ');
}

function moveGridFocus(index, key) {
  const { row, col } = getSlotRowCol(index);
  let nextIndex = index;

  if (key === 'ArrowRight' && col < state.cols - 1) nextIndex = index + 1;
  if (key === 'ArrowLeft' && col > 0) nextIndex = index - 1;
  if (key === 'ArrowDown' && row < state.rows - 1) nextIndex = index + state.cols;
  if (key === 'ArrowUp' && row > 0) nextIndex = index - state.cols;

  if (nextIndex !== index) {
    focusGridSlot(nextIndex);
    return true;
  }
  return false;
}

function expandGridForKeyboardPlacement(index, key) {
  const { row, col } = getSlotRowCol(index);
  let expansion = null;
  let nextIndex = index;

  if (key === 'ArrowRight' && col === state.cols - 1) {
    expansion = resizeGridWithDirectionalExpansion({ right: 1 });
    nextIndex = row * state.cols + col + 1;
  } else if (key === 'ArrowLeft' && col === 0) {
    expansion = resizeGridWithDirectionalExpansion({ left: 1 });
    nextIndex = row * state.cols;
  } else if (key === 'ArrowDown' && row === state.rows - 1) {
    expansion = resizeGridWithDirectionalExpansion({ bottom: 1 });
    nextIndex = (row + 1) * state.cols + col;
  } else if (key === 'ArrowUp' && row === 0) {
    expansion = resizeGridWithDirectionalExpansion({ top: 1 });
    nextIndex = col;
  }

  if (!expansion?.changed) {
    return false;
  }

  state.selectedSlotIndex = clamp(nextIndex, 0, Math.max(0, state.grid.length - 1));
  renderAll();
  focusAfterRender(state.selectedSlotIndex);
  showToast(`Expanded grid to ${state.cols} columns by ${state.rows} rows while moving.`);
  return true;
}

function beginKeyboardPlacementFromSlot(index) {
  if (!state.grid[index]) return false;
  state.keyboardPlacement = { type: 'slot', slotIndex: index };
  state.selectedSlotIndex = index;
  state.multiSelectedSlots = [index];
  renderGrid();
  focusAfterRender(index);
  showToast(`Picked up slot ${index + 1}. Move with arrow keys, press Enter to drop, or Escape to cancel.`);
  return true;
}

function beginKeyboardPlacementFromTray(assetId) {
  const asset = findAssetById(assetId);
  if (!asset) return false;
  state.keyboardPlacement = { type: 'asset', assetId };
  renderHoldingTray();
  const emptyIndex = state.grid.findIndex(slot => slot === null);
  const targetIndex = Number.isInteger(state.selectedSlotIndex)
    ? clamp(state.selectedSlotIndex, 0, Math.max(0, state.grid.length - 1))
    : (emptyIndex >= 0 ? emptyIndex : 0);
  focusAfterRender(targetIndex);
  showToast(`Ready to place ${asset.name}. Move to a slot and press Enter, or Escape to cancel.`);
  return true;
}

function cancelKeyboardPlacement() {
  if (!state.keyboardPlacement) return false;
  const focusIndex = Number.isInteger(state.selectedSlotIndex) ? state.selectedSlotIndex : 0;
  state.keyboardPlacement = null;
  renderAll();
  focusAfterRender(focusIndex);
  showToast('Move cancelled');
  return true;
}

function completeKeyboardPlacement(targetIndex) {
  const placement = state.keyboardPlacement;
  if (!placement) return false;

  state.keyboardPlacement = null;
  state.selectedSlotIndex = targetIndex;
  state.multiSelectedSlots = state.grid[targetIndex] ? [targetIndex] : [];

  if (placement.type === 'slot') {
    if (placement.slotIndex === targetIndex) {
      renderAll();
      focusAfterRender(targetIndex);
      showToast(`Kept image in slot ${targetIndex + 1}`);
      return true;
    }
    swapGridSlots(placement.slotIndex, targetIndex);
    focusAfterRender(targetIndex);
    showToast(`Moved image to slot ${targetIndex + 1}`);
    return true;
  }

  if (placement.type === 'asset') {
    placeAssetInSlot(placement.assetId, targetIndex);
    focusAfterRender(targetIndex);
    showToast(`Placed image into slot ${targetIndex + 1}`);
    return true;
  }

  return false;
}

function completeKeyboardFlowPlacement(targetIndex, placement = 'before') {
  const move = state.keyboardPlacement;
  if (!move) return false;

  const targetRow = Math.floor(targetIndex / state.cols);
  const targetCol = targetIndex % state.cols;
  const insertCol = clamp(placement === 'after' ? targetCol + 1 : targetCol, 0, state.cols);

  state.keyboardPlacement = null;
  state.selectedSlotIndex = targetIndex;

  if (move.type === 'slot') {
    const sourceIndex = move.slotIndex;
    if (!Number.isInteger(sourceIndex) || !state.grid[sourceIndex]) {
      renderAll();
      return false;
    }
    placeGroupInRowFlow([sourceIndex], targetRow, insertCol);
    focusAfterRender(Math.min(targetRow * state.cols + insertCol, state.grid.length - 1));
    return true;
  }

  if (move.type === 'asset') {
    placeAssetInRowFlow(move.assetId, targetRow, insertCol);
    focusAfterRender(Math.min(targetRow * state.cols + insertCol, state.grid.length - 1));
    return true;
  }

  return false;
}

function renderGapControls() {
  if (!els.gapControlsContainer) return;

  if (state.cols <= 1) {
    els.gapControlsContainer.innerHTML = '<p class="hint gap-controls-empty">Add at least 2 columns to configure spread links.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < state.columnGaps.length; i += 1) {
    const button = document.createElement('button');
    const isLinked = getGapAfterColumn(i) === 0;
    button.type = 'button';
    button.className = `mini-button spread-toggle-btn${isLinked ? ' linked' : ''}`;
    button.dataset.gapIndex = String(i);
    button.setAttribute('aria-pressed', isLinked ? 'true' : 'false');
    button.title = isLinked
      ? `Unlink columns ${i + 1} and ${i + 2}`
      : `Link columns ${i + 1} and ${i + 2}`;
    button.textContent = isLinked
      ? `Linked ${i + 1}↔${i + 2}`
      : `Gap ${i + 1}|${i + 2}`;
    fragment.appendChild(button);
  }

  els.gapControlsContainer.replaceChildren(fragment);
}

function toggleMultiSelection(index) {
  if (!state.grid[index]) return;
  const next = new Set(state.multiSelectedSlots);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  state.multiSelectedSlots = Array.from(next).sort((a, b) => a - b);
}

function getActiveDragSlots(startIndex) {
  normalizeMultiSelection();
  if (state.multiSelectedSlots.length > 1 && state.multiSelectedSlots.includes(startIndex)) {
    return state.multiSelectedSlots.slice();
  }
  return [startIndex];
}

function clearFlowPreview() {
  state.flowPreview = null;
  hideDragTooltip();
  if (!els.grid) return;
    const existingLine = els.grid.querySelector('.grid-insert-line');
    if (existingLine) existingLine.classList.add('hidden');
    els.grid.querySelectorAll('.flow-insert-before, .flow-insert-after, .swap-mode, .shift-preview-right').forEach(node => {
      node.classList.remove('flow-insert-before', 'flow-insert-after', 'swap-mode', 'shift-preview-right');
  });
}

function closeCellActionMenus(except = null) {
  document.querySelectorAll('.cell-actions.open').forEach(container => {
    if (!(container instanceof HTMLElement)) return;
    if (except && container === except) return;
    container.classList.remove('open');
    const toggle = container.querySelector('.cell-actions-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

  function updateInsertPreview(targetIndex, placement) {
    if (!els.grid) return;
    const metrics = getLayoutMetrics();
    const row = Math.floor(targetIndex / state.cols);
    const col = targetIndex % state.cols;
    const insertCol = placement === 'before' ? col : col + 1;

    els.grid.querySelectorAll('.shift-preview-right').forEach(el => el.classList.remove('shift-preview-right'));
    els.grid.querySelectorAll('.grid-cell').forEach(cellEl => {
      const cellIndex = parseInt(cellEl.dataset.index, 10);
      if (isNaN(cellIndex)) return;
      const cellRow = Math.floor(cellIndex / state.cols);
      const cellCol = cellIndex % state.cols;
      if (cellRow === row && cellCol >= insertCol) {
        cellEl.classList.add('shift-preview-right');
      }
    });

    const line = els.grid.querySelector('.grid-insert-line');
    if (!line) return;

    let lineX;
    if (insertCol <= 0) {
      lineX = -2;
    } else if (insertCol >= state.cols) {
      lineX = metrics.width - 2;
    } else if (getGapAfterColumn(insertCol - 1) <= 0) {
      lineX = metrics.columnOffsets[insertCol] - 2;
    } else {
      const rightOfPrev = metrics.columnOffsets[insertCol - 1] + metrics.cellWidth;
      const leftOfNext = metrics.columnOffsets[insertCol];
      lineX = (rightOfPrev + leftOfNext) / 2 - 2;
    }

    const rowY = row * (metrics.cellHeight + state.gapY);
    line.style.left = `${(lineX / Math.max(1, metrics.width)) * 100}%`;
    line.style.top = `${(rowY / Math.max(1, metrics.height)) * 100}%`;
    line.style.height = `${(metrics.cellHeight / Math.max(1, metrics.height)) * 100}%`;
    line.classList.remove('hidden');
  }

function resolveFlowInsertionForCell(index, event) {
  const target = event.currentTarget;
  const rect = target?.getBoundingClientRect?.();
  if (!rect) {
    return {
      insertionIndex: index,
      placement: 'before',
      nearBetween: false
    };
  }

  const useHorizontalAxis = state.cols > 1;
  const axisSize = useHorizontalAxis ? rect.width : rect.height;
  const ratioRaw = useHorizontalAxis
    ? (event.clientX - rect.left) / Math.max(1, rect.width)
    : (event.clientY - rect.top) / Math.max(1, rect.height);
  const ratio = clamp(ratioRaw, 0, 1);
  const placement = ratio >= 0.5 ? 'after' : 'before';
  const insertionIndex = placement === 'before' ? index : Math.min(index + 1, state.grid.length);
  // Only trigger insert/reflow when the pointer is genuinely near the cell edge.
  const edgeBandPx = clamp(axisSize * 0.16, 10, 22);
  const edgeRatio = edgeBandPx / Math.max(1, axisSize);
  const nearBetween = event.shiftKey || ratio <= edgeRatio || ratio >= (1 - edgeRatio);

  return {
    insertionIndex,
    placement,
    nearBetween
  };
}

function resolveFlowInsertionForGap(event) {
  const gridRect = els.grid?.getBoundingClientRect?.();
  if (!gridRect || !state.grid.length || state.cols < 1 || state.rows < 1) {
    return null;
  }
  const metrics = getLayoutMetrics();
  const scaleX = gridRect.width / Math.max(1, metrics.width);
  const scaleY = gridRect.height / Math.max(1, metrics.height);
  const cellWidth = metrics.cellWidth * scaleX;
  const cellHeight = metrics.cellHeight * scaleY;
  const gapY = state.gapY * scaleY;
  const strideY = cellHeight + gapY;
  if (cellWidth <= 0 || cellHeight <= 0 || strideY <= 0) return null;

  const relX = event.clientX - gridRect.left;
  const relY = event.clientY - gridRect.top;
  if (relX < 0 || relX > gridRect.width || relY < 0 || relY > gridRect.height) return null;

  const row = Math.floor(relY / strideY);
  if (row < 0 || row >= state.rows) return null;

  const localY = relY - row * strideY;
  if (localY < 0 || localY > cellHeight) {
    return null;
  }

  for (let col = 0; col < state.cols - 1; col += 1) {
    const gapStart = metrics.columnOffsets[col] * scaleX + cellWidth;
    const gapWidth = getGapAfterColumn(col) * scaleX;
    const gapEnd = gapStart + gapWidth;
    if (gapWidth > 0 && relX >= gapStart && relX <= gapEnd) {
      const targetIndex = row * state.cols + col;
      const placement = 'after';
      const insertionIndex = Math.min(targetIndex + 1, state.grid.length);
      return { targetIndex, insertionIndex, placement, nearBetween: true };
    }
  }

  return null;
}

function placeGroupInFlow(slotIndices, targetIndex) {
  const uniqueSlots = Array.from(new Set(slotIndices)).sort((a, b) => a - b);
  if (uniqueSlots.length === 0) return false;

  const slotSet = new Set(uniqueSlots);
  const groupAssets = uniqueSlots.map(index => state.grid[index]).filter(Boolean);
  if (groupAssets.length === 0) return false;

  const remaining = [];
  for (let i = 0; i < state.grid.length; i += 1) {
    if (!slotSet.has(i)) {
      remaining.push(state.grid[i]);
    }
  }

  const slotsBeforeTarget = uniqueSlots.filter(index => index < targetIndex).length;
  const insertAt = clamp(targetIndex - slotsBeforeTarget, 0, remaining.length);
  const nextGrid = [
    ...remaining.slice(0, insertAt),
    ...groupAssets,
    ...remaining.slice(insertAt)
  ].slice(0, state.grid.length);

  while (nextGrid.length < state.grid.length) {
    nextGrid.push(null);
  }

  const unchanged = nextGrid.length === state.grid.length && nextGrid.every((value, index) => value === state.grid[index]);
  if (unchanged) {
    state.dragPayload = null;
    return false;
  }

  pushHistory(`Reflow move ${groupAssets.length} image${groupAssets.length === 1 ? '' : 's'}`);

  state.grid = nextGrid;
  state.multiSelectedSlots = [];
  for (let i = insertAt; i < insertAt + groupAssets.length && i < state.grid.length; i += 1) {
    if (state.grid[i]) state.multiSelectedSlots.push(i);
  }
  state.selectedSlotIndex = targetIndex;
  state.dragPayload = null;
  renderAll();
  return true;
}

function placeGroupInRowFlow(slotIndices, targetRow, insertCol) {
  const uniqueSlots = [...new Set(slotIndices)]
    .filter(i => Number.isInteger(i) && i >= 0 && i < state.grid.length);
  const groupAssets = uniqueSlots.map(i => state.grid[i]).filter(Boolean);
  if (groupAssets.length === 0) return false;

  const oldCols = state.cols;
  const tempGrid = state.grid.slice();
  for (const i of uniqueSlots) tempGrid[i] = null;

  const rowStart = targetRow * oldCols;
  const rowItems = tempGrid.slice(rowStart, rowStart + oldCols);
  const col = clamp(insertCol, 0, oldCols);
  // Preserve null positions — do NOT compact with filter(Boolean)
  const leftItems = rowItems.slice(0, col);
  const rightItems = rowItems.slice(col);
  const newRowItems = [...leftItems, ...groupAssets, ...rightItems];

  if (newRowItems.length > oldCols) {
    const addCols = newRowItems.length - oldCols;
    const newCols = oldCols + addCols;
    const expandedGrid = [];
    for (let r = 0; r < state.rows; r += 1) {
      for (let c = 0; c < oldCols; c += 1) expandedGrid.push(tempGrid[r * oldCols + c] ?? null);
      for (let c = 0; c < addCols; c += 1) expandedGrid.push(null);
    }
    state.cols = newCols;
    state.grid = expandedGrid;
    state.canvasWidth = Math.max(1, state.canvasWidth + addCols * (state.cellWidth + state.globalGapX));
  } else {
    state.grid = tempGrid;
  }

  const newRowStart = targetRow * state.cols;
  const paddedRow = [...newRowItems];
  while (paddedRow.length < state.cols) paddedRow.push(null);
  for (let c = 0; c < state.cols; c += 1) {
    state.grid[newRowStart + c] = paddedRow[c] ?? null;
  }

  pushHistory(`Insert into row ${targetRow + 1}`);
  state.multiSelectedSlots = [];
  const insertedCount = groupAssets.length;
  for (let c = col; c < col + insertedCount && c < state.cols; c += 1) {
    if (state.grid[newRowStart + c]) state.multiSelectedSlots.push(newRowStart + c);
  }
  state.dragPayload = null;
  renderAll();
  showToast(`Inserted into row ${targetRow + 1}`);
  return true;
}

function removeRowAt(rowIndex) {
  if (state.rows <= 1 || rowIndex < 0 || rowIndex >= state.rows) return;
  pushHistory(`Remove row ${rowIndex + 1}`);
  const metrics = getLayoutMetrics();
  const oldRows = state.rows;
  const oldCols = state.cols;
  const oldGrid = state.grid.slice();
  const removedIds = [];
  const nextRows = oldRows - 1;
  const nextGrid = [];

  for (let r = 0; r < oldRows; r += 1) {
    if (r === rowIndex) {
      for (let c = 0; c < oldCols; c += 1) {
        const removedId = oldGrid[r * oldCols + c];
        if (removedId) removedIds.push(removedId);
      }
      continue;
    }
    for (let c = 0; c < oldCols; c += 1) {
      nextGrid.push(oldGrid[r * oldCols + c] || null);
    }
  }

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / oldCols);
    const col = index % oldCols;
    if (row === rowIndex) return null;
    const nextRow = row > rowIndex ? row - 1 : row;
    return nextRow * oldCols + col;
  };

  state.rows = nextRows;
  state.grid = nextGrid;
  state.canvasHeight = Math.max(1, state.canvasHeight - (metrics.cellHeight + state.gapY));
  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }
  pushAssetsToHolding(removedIds);
  state.multiSelectedSlots = state.multiSelectedSlots.map(mapIndex).filter(index => index != null);
  normalizeMultiSelection();
  renderAll();
  showToast(`Removed row ${rowIndex + 1}`);
}

function removeColumnAt(colIndex) {
  if (state.cols <= 1 || colIndex < 0 || colIndex >= state.cols) return;
  pushHistory(`Remove column ${colIndex + 1}`);
  const metrics = getLayoutMetrics();
  const oldRows = state.rows;
  const oldCols = state.cols;
  const oldGrid = state.grid.slice();
  const removedIds = [];
  const nextCols = oldCols - 1;
  const nextGrid = [];

  for (let r = 0; r < oldRows; r += 1) {
    for (let c = 0; c < oldCols; c += 1) {
      if (c === colIndex) {
        const removedId = oldGrid[r * oldCols + c];
        if (removedId) removedIds.push(removedId);
        continue;
      }
      nextGrid.push(oldGrid[r * oldCols + c] || null);
    }
  }

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / oldCols);
    const col = index % oldCols;
    if (col === colIndex) return null;
    const nextCol = col > colIndex ? col - 1 : col;
    return row * nextCols + nextCol;
  };

  const nextGaps = state.columnGaps.slice();
  if (nextGaps.length > 0) {
    const removeGapAt = clamp(colIndex, 0, nextGaps.length - 1);
    nextGaps.splice(removeGapAt, 1);
  }

  state.cols = nextCols;
  state.columnGaps = nextGaps;
  normalizeColumnGaps();
  state.grid = nextGrid;
  state.canvasWidth = Math.max(1, state.canvasWidth - (metrics.cellWidth + state.globalGapX));
  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }
  pushAssetsToHolding(removedIds);
  state.multiSelectedSlots = state.multiSelectedSlots.map(mapIndex).filter(index => index != null);
  normalizeMultiSelection();
  renderAll();
  showToast(`Removed column ${colIndex + 1}`);
}

function insertColumnAt(insertAt) {
  const oldRows = state.rows;
  const oldCols = state.cols;
  const boundedInsertAt = clamp(insertAt, 0, oldCols);
  const newCols = oldCols + 1;
  const oldGrid = state.grid.slice();
  const newGrid = new Array(oldRows * newCols).fill(null);

  for (let row = 0; row < oldRows; row += 1) {
    for (let col = 0; col < oldCols; col += 1) {
      const sourceIndex = row * oldCols + col;
      const targetCol = col >= boundedInsertAt ? col + 1 : col;
      const targetIndex = row * newCols + targetCol;
      newGrid[targetIndex] = oldGrid[sourceIndex] || null;
    }
  }

  const oldGaps = state.columnGaps.slice();
  const newGaps = [];
  for (let gapIndex = 0; gapIndex < newCols - 1; gapIndex += 1) {
    if (boundedInsertAt === 0) {
      newGaps.push(gapIndex === 0 ? state.globalGapX : (oldGaps[gapIndex - 1] ?? state.globalGapX));
      continue;
    }
    if (boundedInsertAt === oldCols) {
      newGaps.push(gapIndex === newCols - 2 ? state.globalGapX : (oldGaps[gapIndex] ?? state.globalGapX));
      continue;
    }
    if (gapIndex < boundedInsertAt - 1) {
      newGaps.push(oldGaps[gapIndex] ?? state.globalGapX);
    } else if (gapIndex === boundedInsertAt - 1) {
      newGaps.push(state.globalGapX);
    } else if (gapIndex === boundedInsertAt) {
      newGaps.push(oldGaps[boundedInsertAt - 1] ?? state.globalGapX);
    } else {
      newGaps.push(oldGaps[gapIndex - 1] ?? state.globalGapX);
    }
  }

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / oldCols);
    const col = index % oldCols;
    const nextCol = col >= boundedInsertAt ? col + 1 : col;
    return row * newCols + nextCol;
  };

  pushHistory(`Insert column ${boundedInsertAt + 1}`);
  state.cols = newCols;
  state.grid = newGrid;
  state.columnGaps = newGaps;
  normalizeColumnGaps();
  state.canvasWidth = Math.max(1, state.canvasWidth + state.cellWidth + state.globalGapX);

  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }

  if (state.dragPayload?.type === 'slot' && Number.isInteger(state.dragPayload.slotIndex)) {
    state.dragPayload.slotIndex = mapIndex(state.dragPayload.slotIndex);
  }
  if (state.dragPayload?.type === 'group' && Array.isArray(state.dragPayload.slotIndices)) {
    state.dragPayload.slotIndices = state.dragPayload.slotIndices.map(mapIndex).filter(index => index != null);
  }
  if (state.keyboardPlacement?.type === 'slot' && Number.isInteger(state.keyboardPlacement.slotIndex)) {
    state.keyboardPlacement.slotIndex = mapIndex(state.keyboardPlacement.slotIndex);
  }
  state.multiSelectedSlots = state.multiSelectedSlots.map(mapIndex).filter(index => index != null);

  clearFlowPreview();
  renderAll();
  showToast(`Inserted column ${boundedInsertAt + 1}`);
}

function insertRowAt(insertAt) {
  const oldRows = state.rows;
  const oldCols = state.cols;
  const boundedInsertAt = clamp(insertAt, 0, oldRows);
  const newRows = oldRows + 1;
  const oldGrid = state.grid.slice();
  const newGrid = new Array(newRows * oldCols).fill(null);

  for (let row = 0; row < oldRows; row += 1) {
    const targetRow = row >= boundedInsertAt ? row + 1 : row;
    for (let col = 0; col < oldCols; col += 1) {
      const sourceIndex = row * oldCols + col;
      const targetIndex = targetRow * oldCols + col;
      newGrid[targetIndex] = oldGrid[sourceIndex] || null;
    }
  }

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / oldCols);
    const col = index % oldCols;
    const nextRow = row >= boundedInsertAt ? row + 1 : row;
    return nextRow * oldCols + col;
  };

  pushHistory(`Insert row ${boundedInsertAt + 1}`);
  state.rows = newRows;
  state.grid = newGrid;
  state.canvasHeight = Math.max(1, state.canvasHeight + state.cellHeight + state.gapY);

  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }

  if (state.dragPayload?.type === 'slot' && Number.isInteger(state.dragPayload.slotIndex)) {
    state.dragPayload.slotIndex = mapIndex(state.dragPayload.slotIndex);
  }
  if (state.dragPayload?.type === 'group' && Array.isArray(state.dragPayload.slotIndices)) {
    state.dragPayload.slotIndices = state.dragPayload.slotIndices.map(mapIndex).filter(index => index != null);
  }
  if (state.keyboardPlacement?.type === 'slot' && Number.isInteger(state.keyboardPlacement.slotIndex)) {
    state.keyboardPlacement.slotIndex = mapIndex(state.keyboardPlacement.slotIndex);
  }
  state.multiSelectedSlots = state.multiSelectedSlots.map(mapIndex).filter(index => index != null);

  clearFlowPreview();
  renderAll();
  showToast(`Inserted row ${boundedInsertAt + 1}`);
}

// "Reflow" counterparts to removeRowAt/removeColumnAt: instead of trimming the
// last row/column straight to the Image Tray, grow the other dimension just
// enough to keep every image on the grid, matching the same behavior direct
// number-input edits already use (see applyNumberSettings).
function reflowShrinkRows() {
  const nextRows = Math.max(1, state.rows - 1);
  const required = state.assets.length;
  const nextCols = required > 0 ? minColsForRows(nextRows, required) : state.cols;
  pushHistory(`Decrease rows to ${nextRows} (reflow)`);
  const overflowIds = resizeGridPreserve(nextRows, nextCols, { preserveLeadingGaps: true });
  if (overflowIds.length > 0) {
    pushAssetsToHolding(overflowIds);
    showToast(`${overflowIds.length} image${overflowIds.length === 1 ? '' : 's'} didn't fit and ${overflowIds.length === 1 ? 'was' : 'were'} staged in the Image Tray.`);
  } else {
    showToast(nextCols !== state.cols ? `Rows reduced to ${nextRows}; columns adjusted to ${nextCols} to fit all images` : `Rows reduced to ${nextRows}`);
  }
  renderAll();
}

function reflowShrinkCols() {
  const nextCols = Math.max(1, state.cols - 1);
  const required = state.assets.length;
  const nextRows = required > 0 ? minRowsForCols(nextCols, required) : state.rows;
  pushHistory(`Decrease columns to ${nextCols} (reflow)`);
  const overflowIds = resizeGridPreserve(nextRows, nextCols, { preserveLeadingGaps: true });
  if (overflowIds.length > 0) {
    pushAssetsToHolding(overflowIds);
    showToast(`${overflowIds.length} image${overflowIds.length === 1 ? '' : 's'} didn't fit and ${overflowIds.length === 1 ? 'was' : 'were'} staged in the Image Tray.`);
  } else {
    showToast(nextRows !== state.rows ? `Columns reduced to ${nextCols}; rows adjusted to ${nextRows} to fit all images` : `Columns reduced to ${nextCols}`);
  }
  renderAll();
}

function beginAutoExpandSession() {
  if (!state.dragPayload) return;
  if (!['slot', 'group', 'asset'].includes(state.dragPayload.type)) return;

  const rect = els.grid ? els.grid.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
  const metrics = getLayoutMetrics();
  const strideX = Math.max(1, (metrics.cellWidth + state.globalGapX) * state.zoom);
  const strideY = Math.max(1, (metrics.cellHeight + state.gapY) * state.zoom);

  state.autoExpandSession = {
    baseRows: state.rows,
    baseCols: state.cols,
    baseCanvasWidth: state.canvasWidth,
    baseCanvasHeight: state.canvasHeight,
    anchorLeft: rect.left,
    anchorRight: rect.right,
    anchorTop: rect.top,
    anchorBottom: rect.bottom,
    strideX,
    strideY,
    addedLeft: 0,
    addedRight: 0,
    addedTop: 0,
    addedBottom: 0
  };
}

function trackAutoExpansion(expansion) {
  if (!state.autoExpandSession || !expansion?.changed) return;
  state.autoExpandSession.addedLeft += expansion.left || 0;
  state.autoExpandSession.addedRight += expansion.right || 0;
  state.autoExpandSession.addedTop += expansion.top || 0;
  state.autoExpandSession.addedBottom += expansion.bottom || 0;
}

function isDropInAutoExpandedArea(dropIndex) {
  const session = state.autoExpandSession;
  if (!session || !Number.isInteger(dropIndex)) return false;

  const row = Math.floor(dropIndex / state.cols);
  const col = dropIndex % state.cols;
  const minRow = session.addedTop;
  const maxRow = session.addedTop + session.baseRows - 1;
  const minCol = session.addedLeft;
  const maxCol = session.addedLeft + session.baseCols - 1;
  return row < minRow || row > maxRow || col < minCol || col > maxCol;
}

function collapseAutoExpandedGrid() {
  const session = state.autoExpandSession;
  if (!session) return false;

  const addedCount = session.addedLeft + session.addedRight + session.addedTop + session.addedBottom;
  if (addedCount === 0) return false;

  const collapsedGrid = new Array(session.baseRows * session.baseCols).fill(null);
  for (let r = 0; r < session.baseRows; r += 1) {
    for (let c = 0; c < session.baseCols; c += 1) {
      const sourceRow = r + session.addedTop;
      const sourceCol = c + session.addedLeft;
      const sourceIndex = sourceRow * state.cols + sourceCol;
      const nextIndex = r * session.baseCols + c;
      collapsedGrid[nextIndex] = state.grid[sourceIndex] || null;
    }
  }

  const mapIndex = index => {
    if (!Number.isInteger(index)) return null;
    const row = Math.floor(index / state.cols) - session.addedTop;
    const col = (index % state.cols) - session.addedLeft;
    if (row < 0 || row >= session.baseRows || col < 0 || col >= session.baseCols) return null;
    return row * session.baseCols + col;
  };

  state.rows = session.baseRows;
  state.cols = session.baseCols;
  state.canvasWidth = session.baseCanvasWidth;
  state.canvasHeight = session.baseCanvasHeight;
  state.grid = collapsedGrid;

  state.selectedSlotIndex = mapIndex(state.selectedSlotIndex);
  if (state.previewModalOpen) {
    state.previewSlotIndex = mapIndex(state.previewSlotIndex);
  }

  return true;
}

function finalizeAutoExpandSession(dropIndex = null) {
  const session = state.autoExpandSession;
  if (!session) return false;

  const keepExpansion = isDropInAutoExpandedArea(dropIndex);
  let collapsed = false;
  if (!keepExpansion) {
    collapsed = collapseAutoExpandedGrid();
  }

  state.autoExpandSession = null;
  return collapsed;
}

function maybeCollapseAutoExpansionForCellHover(index) {
  const session = state.autoExpandSession;
  if (!session) return false;
  if (isDropInAutoExpandedArea(index)) return false;

  const reduction = shrinkGridWithDirectionalReduction({
    left: session.addedLeft,
    right: session.addedRight,
    top: session.addedTop,
    bottom: session.addedBottom
  });
  if (!reduction.changed) return false;

  session.addedLeft = Math.max(0, session.addedLeft - reduction.left);
  session.addedRight = Math.max(0, session.addedRight - reduction.right);
  session.addedTop = Math.max(0, session.addedTop - reduction.top);
  session.addedBottom = Math.max(0, session.addedBottom - reduction.bottom);

  if (session.addedLeft + session.addedRight + session.addedTop + session.addedBottom === 0) {
    state.autoExpandSession = null;
  }

  return true;
}

function setDragEdgeIndicators({ left = false, right = false, top = false, bottom = false } = {}) {
  if (!els.grid) return;
  els.grid.classList.toggle('drag-expand-left', left);
  els.grid.classList.toggle('drag-expand-right', right);
  els.grid.classList.toggle('drag-expand-top', top);
  els.grid.classList.toggle('drag-expand-bottom', bottom);
  els.grid.classList.toggle('drag-expand-active', left || right || top || bottom);
}

function clearDragEdgeIndicators() {
  state.dragEdgeHint = null;
  setDragEdgeIndicators();
}

function announceDragExpansion(message) {
  if (els.dragExpandStatus) {
    els.dragExpandStatus.textContent = message;
  }
  if (els.toastStatus) {
    els.toastStatus.textContent = message;
  }
}

function maybeExpandGridForDragHover(event) {
  if (!state.dragPayload || isFileDrag(event)) return;
  if (!els.grid || !els.canvasViewport) return;

  if (!state.autoExpandSession) {
    beginAutoExpandSession();
  }

  const session = state.autoExpandSession;
  if (!session) return;

  const rect = els.grid.getBoundingClientRect();
  const colStridePx = Math.max(1, session.strideX || 1);
  const rowStridePx = Math.max(1, session.strideY || 1);
  const edgeHintThreshold = 34;
  const expandThreshold = 16;
  const collapseBufferPx = 12;

  const leftDistance = Math.max(0, session.anchorLeft - event.clientX);
  const rightDistance = Math.max(0, event.clientX - session.anchorRight);
  const topDistance = Math.max(0, session.anchorTop - event.clientY);
  const bottomDistance = Math.max(0, event.clientY - session.anchorBottom);

  const rawDesired = (distance, stride) => (distance >= expandThreshold
    ? 1 + Math.floor((distance - expandThreshold) / stride)
    : 0);

  const stableDesired = (distance, stride, currentAdded) => {
    const desired = rawDesired(distance, stride);
    if (currentAdded > desired) {
      const keepBoundary = expandThreshold + (currentAdded - 1) * stride - collapseBufferPx;
      if (distance >= keepBoundary) return currentAdded;
    }
    return desired;
  };

  const desiredLeft = stableDesired(leftDistance, colStridePx, session.addedLeft || 0);
  const desiredRight = stableDesired(rightDistance, colStridePx, session.addedRight || 0);
  const desiredTop = stableDesired(topDistance, rowStridePx, session.addedTop || 0);
  const desiredBottom = stableDesired(bottomDistance, rowStridePx, session.addedBottom || 0);

  const hintLeft = event.clientX < rect.left + edgeHintThreshold || desiredLeft > 0;
  const hintRight = event.clientX > rect.right - edgeHintThreshold || desiredRight > 0;
  const hintTop = event.clientY < rect.top + edgeHintThreshold || desiredTop > 0;
  const hintBottom = event.clientY > rect.bottom - edgeHintThreshold || desiredBottom > 0;
  setDragEdgeIndicators({ left: hintLeft, right: hintRight, top: hintTop, bottom: hintBottom });

  const hasAnyDesiredExpansion = desiredLeft > 0 || desiredRight > 0 || desiredTop > 0 || desiredBottom > 0;
  let didChange = false;

  if (state.autoExpandSession) {
    const reduction = shrinkGridWithDirectionalReduction({
      left: Math.max(0, session.addedLeft - desiredLeft),
      right: Math.max(0, session.addedRight - desiredRight),
      top: Math.max(0, session.addedTop - desiredTop),
      bottom: Math.max(0, session.addedBottom - desiredBottom)
    });

    if (reduction.changed) {
      session.addedLeft = Math.max(0, session.addedLeft - reduction.left);
      session.addedRight = Math.max(0, session.addedRight - reduction.right);
      session.addedTop = Math.max(0, session.addedTop - reduction.top);
      session.addedBottom = Math.max(0, session.addedBottom - reduction.bottom);
      didChange = true;
    }

    if (
      session.addedLeft + session.addedRight + session.addedTop + session.addedBottom === 0
      && !hasAnyDesiredExpansion
    ) {
      state.autoExpandSession = null;
    }

    const addLeft = Math.max(0, desiredLeft - session.addedLeft);
    const addRight = Math.max(0, desiredRight - session.addedRight);
    const addTop = Math.max(0, desiredTop - session.addedTop);
    const addBottom = Math.max(0, desiredBottom - session.addedBottom);

    if (addLeft || addRight || addTop || addBottom) {
      const expansion = resizeGridWithDirectionalExpansion({
        left: addLeft,
        right: addRight,
        top: addTop,
        bottom: addBottom
      });
      if (expansion.changed) {
        trackAutoExpansion(expansion);
        const direction = [
          expansion.left ? 'left' : null,
          expansion.right ? 'right' : null,
          expansion.top ? 'top' : null,
          expansion.bottom ? 'bottom' : null
        ].filter(Boolean).join(' + ');
        announceDragExpansion(`Expanded ${direction}. Grid is now ${state.cols} columns by ${state.rows} rows.`);
        didChange = true;
      }
    }
  } else {
    state.dragEdgeHint = null;
  }

  if (didChange) {
    renderAll();
  }
}

function getPreviewSpreadGroup(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= state.grid.length) return [];
  if (!state.grid[slotIndex]) return [];

  const row = Math.floor(slotIndex / state.cols);
  let startCol = slotIndex % state.cols;
  let endCol = startCol;

  while (startCol > 0) {
    const leftIndex = row * state.cols + (startCol - 1);
    const currentIndex = row * state.cols + startCol;
    if (getGapAfterColumn(startCol - 1) !== 0) break;
    if (!state.grid[leftIndex] || !state.grid[currentIndex]) break;
    startCol -= 1;
  }

  while (endCol < state.cols - 1) {
    const currentIndex = row * state.cols + endCol;
    const rightIndex = row * state.cols + (endCol + 1);
    if (getGapAfterColumn(endCol) !== 0) break;
    if (!state.grid[currentIndex] || !state.grid[rightIndex]) break;
    endCol += 1;
  }

  const group = [];
  for (let col = startCol; col <= endCol; col += 1) {
    const idx = row * state.cols + col;
    if (!state.grid[idx]) break;
    group.push(idx);
  }
  return group;
}

function getPreviewSlotGroups() {
  const groups = [];
  for (let row = 0; row < state.rows; row += 1) {
    for (let col = 0; col < state.cols;) {
      const slotIndex = row * state.cols + col;
      if (!state.grid[slotIndex]) {
        col += 1;
        continue;
      }

      const spreadGroup = getPreviewSpreadGroup(slotIndex);
      if (spreadGroup.length > 1 && spreadGroup[0] === slotIndex) {
        groups.push(spreadGroup);
        col = (spreadGroup[spreadGroup.length - 1] % state.cols) + 1;
      } else {
        groups.push([slotIndex]);
        col += 1;
      }
    }
  }
  return groups;
}

let previewRenderToken = 0;
const PREVIEW_SPREAD_MAX_DIM = 8192;

function getPreviewSpreadRenderScale(sortedSlots, metrics, { fullRes = false } = {}) {
  if (!fullRes) return 1;

  let desiredScale = 1;
  for (const slotIndex of sortedSlots) {
    const assetId = state.grid[slotIndex];
    const asset = assetId ? findAssetById(assetId) : null;
    if (!asset) continue;
    const xScale = (asset.width || metrics.cellWidth) / Math.max(1, metrics.cellWidth);
    const yScale = (asset.height || metrics.cellHeight) / Math.max(1, metrics.cellHeight);
    desiredScale = Math.max(desiredScale, xScale, yScale);
  }

  const baseWidth = Math.max(1, (metrics.columnOffsets[sortedSlots[sortedSlots.length - 1] % state.cols] || 0)
    - (metrics.columnOffsets[sortedSlots[0] % state.cols] || 0) + metrics.cellWidth);
  const baseHeight = Math.max(1, metrics.cellHeight);
  const maxBaseDim = Math.max(baseWidth, baseHeight);
  const maxSafeScale = Math.max(1, PREVIEW_SPREAD_MAX_DIM / maxBaseDim);
  return clamp(desiredScale, 1, maxSafeScale);
}

async function renderPreviewGroupDataUrl(slotIndices, { fullRes = false } = {}) {
  const validSlots = slotIndices.filter(index => Number.isInteger(index) && state.grid[index]);
  if (validSlots.length === 0) return null;

  const metrics = getLayoutMetrics();
  const sorted = validSlots.slice().sort((a, b) => a - b);
  const firstCol = sorted[0] % state.cols;
  const lastCol = sorted[sorted.length - 1] % state.cols;

  const left = metrics.columnOffsets[firstCol] || 0;
  const right = (metrics.columnOffsets[lastCol] || 0) + metrics.cellWidth;
  const baseWidth = Math.max(1, right - left);
  const baseHeight = Math.max(1, metrics.cellHeight);
  const renderScale = getPreviewSpreadRenderScale(sorted, metrics, { fullRes });
  const width = Math.max(1, Math.round(baseWidth * renderScale));
  const height = Math.max(1, Math.round(baseHeight * renderScale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f3f7fc';
  ctx.fillRect(0, 0, width, height);

  const assetIds = sorted.map(index => state.grid[index]).filter(Boolean);
  const fullResUrls = fullRes ? await getFullResObjectUrls(assetIds) : null;

  try {
    for (const slotIndex of sorted) {
      const assetId = state.grid[slotIndex];
      const asset = assetId ? findAssetById(assetId) : null;
      if (!asset) continue;

      const col = slotIndex % state.cols;
      const x = ((metrics.columnOffsets[col] || 0) - left) * renderScale;
      const y = 0;
      const scaledCellWidth = metrics.cellWidth * renderScale;
      const scaledCellHeight = metrics.cellHeight * renderScale;
      const src = fullRes
        ? (fullResUrls.get(assetId) || asset.thumbUrl)
        : asset.thumbUrl;
      const image = fullRes ? await loadImageOnce(src) : await loadImage(src);
      const rect = objectFitRect({ x, y, width: scaledCellWidth, height: scaledCellHeight }, image, state.fit);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, scaledCellWidth, scaledCellHeight);
      ctx.clip();
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
  } finally {
    if (fullResUrls) {
      for (const url of fullResUrls.values()) {
        if (url) URL.revokeObjectURL(url);
      }
    }
  }

  return canvas.toDataURL('image/png');
}

async function getPreviewImageSource(slotIndices, { fullRes = false } = {}) {
  const group = slotIndices.filter(index => Number.isInteger(index) && state.grid[index]);
  if (group.length === 0) return { src: null, objectUrl: false };

  if (group.length === 1) {
    const assetId = state.grid[group[0]];
    const asset = findAssetById(assetId);
    if (!asset) return { src: null, objectUrl: false };
    if (!fullRes) return { src: asset.thumbUrl, objectUrl: false };
    const blob = await readAssetBlob(assetId);
    if (!blob) return { src: asset.thumbUrl, objectUrl: false };
    return { src: URL.createObjectURL(blob), objectUrl: true };
  }

  const src = await renderPreviewGroupDataUrl(group, { fullRes });
  return { src, objectUrl: false };
}

// Object URL currently backing the full-resolution preview image, if any.
// Revoked whenever the preview closes or moves to a different image so the
// decoded full-size bitmap isn't kept alive longer than it's on screen.
let previewObjectUrl = null;

function releasePreviewObjectUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function closePreviewModal() {
  state.previewModalOpen = false;
  state.previewSlotIndex = null;
  previewRenderToken += 1;
  releasePreviewObjectUrl();
  closeModal(els.previewModal);
}

async function syncPreviewModal() {
  if (!state.previewModalOpen) return;
  const groups = getPreviewSlotGroups();
  if (groups.length === 0) {
    closePreviewModal();
    showToast('No images available to preview');
    return;
  }

  let groupIndex = groups.findIndex(group => group.includes(state.previewSlotIndex ?? group[0]));
  if (groupIndex < 0) groupIndex = 0;
  const group = groups[groupIndex];
  if (!group || group.length === 0) {
    closePreviewModal();
    return;
  }

  state.previewSlotIndex = group[0];
  const slotIndex = group[0];
  const firstAssetId = state.grid[slotIndex];
  const firstAsset = firstAssetId ? findAssetById(firstAssetId) : null;
  if (!firstAsset) {
    closePreviewModal();
    return;
  }

  const row = Math.floor(slotIndex / state.cols) + 1;
  const firstCol = (group[0] % state.cols) + 1;
  const lastCol = (group[group.length - 1] % state.cols) + 1;
  const slotStart = group[0] + 1;
  const slotEnd = group[group.length - 1] + 1;
  const isSpread = group.length > 1;
  els.previewModalTitle.textContent = isSpread ? `Spread preview (${group.length} images)` : firstAsset.name;
  els.previewModalCaption.textContent = isSpread
    ? `Slots ${slotStart}-${slotEnd} (Row ${row}, Columns ${firstCol}-${lastCol})`
    : `Slot ${slotStart} of ${state.grid.length} (Row ${row}, Column ${firstCol})`;
  els.previewModalCounter.textContent = `${groupIndex + 1} / ${groups.length}`;
  els.previewPrevBtn.disabled = groups.length <= 1;
  els.previewNextBtn.disabled = groups.length <= 1;
  els.previewModal.classList.add('show');
  els.previewModal.setAttribute('aria-hidden', 'false');
  els.previewModalImage.alt = isSpread
    ? `Spread preview for slots ${slotStart} through ${slotEnd}`
    : firstAsset.name;

  const renderToken = ++previewRenderToken;
  releasePreviewObjectUrl();

  const thumbSource = await getPreviewImageSource(group, { fullRes: false });
  if (!thumbSource.src || renderToken !== previewRenderToken || !state.previewModalOpen || state.previewSlotIndex !== slotIndex) return;
  els.previewModalImage.src = thumbSource.src;

  const fullResSource = await getPreviewImageSource(group, { fullRes: true });
  if (!fullResSource.src || renderToken !== previewRenderToken || !state.previewModalOpen || state.previewSlotIndex !== slotIndex) return;
  if (fullResSource.objectUrl) {
    releasePreviewObjectUrl();
    previewObjectUrl = fullResSource.src;
  }
  els.previewModalImage.src = fullResSource.src;
}

function openPreviewModal(slotIndex) {
  const assetId = state.grid[slotIndex];
  if (!assetId) return;
  state.previewModalOpen = true;
  state.previewSlotIndex = slotIndex;
  openModal(els.previewModal, { focusTarget: els.previewCloseBtn });
  syncPreviewModal();
}

function stepPreview(direction) {
  if (!state.previewModalOpen) return;
  const groups = getPreviewSlotGroups();
  if (groups.length === 0) return closePreviewModal();
  const currentGroupIndex = groups.findIndex(group => group.includes(state.previewSlotIndex ?? group[0]));
  const nextGroupIndex = (currentGroupIndex < 0 ? 0 : currentGroupIndex + direction + groups.length) % groups.length;
  state.previewSlotIndex = groups[nextGroupIndex][0];
  syncPreviewModal();
}

function createGridEdgeButtons(metrics) {
  for (let boundary = 0; boundary <= state.cols; boundary += 1) {
    let x = 0;
    if (boundary === 0) {
      x = metrics.offsetX;
    } else if (boundary === state.cols) {
      x = metrics.offsetX + metrics.width;
    } else {
      const prevRight = metrics.offsetX + metrics.columnOffsets[boundary - 1] + metrics.cellWidth;
      const nextLeft = metrics.offsetX + metrics.columnOffsets[boundary];
      x = (prevRight + nextLeft) / 2;
    }

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'edge-add-btn edge-add-col';
    addColBtn.title = boundary === state.cols
      ? 'Add column at end'
      : `Add column before ${boundary + 1}`;
    addColBtn.setAttribute('aria-label', boundary === state.cols
      ? 'Add column at end'
      : `Add column before ${boundary + 1}`);
    addColBtn.textContent = '+';
    addColBtn.style.left = `${(x / metrics.width) * 100}%`;
    addColBtn.style.top = '0%';
    addColBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      insertColumnAt(boundary);
    });
    els.grid.appendChild(addColBtn);
  }

  for (let boundary = 0; boundary <= state.rows; boundary += 1) {
    let y = 0;
    if (boundary === 0) {
      y = metrics.offsetY;
    } else if (boundary === state.rows) {
      y = metrics.offsetY + metrics.height;
    } else {
      const prevBottom = metrics.offsetY + (boundary - 1) * (metrics.cellHeight + state.gapY) + metrics.cellHeight;
      const nextTop = metrics.offsetY + boundary * (metrics.cellHeight + state.gapY);
      y = (prevBottom + nextTop) / 2;
    }

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'edge-add-btn edge-add-row';
    addRowBtn.title = boundary === state.rows
      ? 'Add row at end'
      : `Add row before ${boundary + 1}`;
    addRowBtn.setAttribute('aria-label', boundary === state.rows
      ? 'Add row at end'
      : `Add row before ${boundary + 1}`);
    addRowBtn.textContent = '+';
    addRowBtn.style.left = '0%';
    addRowBtn.style.top = `${(y / metrics.height) * 100}%`;
    addRowBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      insertRowAt(boundary);
    });
    els.grid.appendChild(addRowBtn);
  }

  if (state.cols > 1) {
    for (let col = 0; col < state.cols; col += 1) {
      const x = metrics.offsetX + metrics.columnOffsets[col] + metrics.cellWidth / 2;
      const colBtn = document.createElement('button');
      colBtn.type = 'button';
      colBtn.className = 'edge-remove-btn edge-remove-col';
      colBtn.title = `Remove column ${col + 1}`;
      colBtn.setAttribute('aria-label', `Remove column ${col + 1}`);
      colBtn.textContent = '−';
      colBtn.style.left = `${(x / metrics.width) * 100}%`;
      colBtn.style.top = '0%';
      colBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        removeColumnAt(col);
      });
      els.grid.appendChild(colBtn);
    }
  }

  if (state.rows > 1) {
    for (let row = 0; row < state.rows; row += 1) {
      const y = metrics.offsetY + row * (metrics.cellHeight + state.gapY) + metrics.cellHeight / 2;
      const rowBtn = document.createElement('button');
      rowBtn.type = 'button';
      rowBtn.className = 'edge-remove-btn edge-remove-row';
      rowBtn.title = `Remove row ${row + 1}`;
      rowBtn.setAttribute('aria-label', `Remove row ${row + 1}`);
      rowBtn.textContent = '−';
      rowBtn.style.left = '0%';
      rowBtn.style.top = `${(y / metrics.height) * 100}%`;
      rowBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        removeRowAt(row);
      });
      els.grid.appendChild(rowBtn);
    }
  }
}

function fileFromClipboardData(dataTransfer) {
  if (!dataTransfer) return null;

  if (dataTransfer.files?.length) {
    for (const file of dataTransfer.files) {
      if (String(file.type || '').startsWith('image/')) return file;
    }
  }

  if (dataTransfer.items?.length) {
    for (const item of dataTransfer.items) {
      if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }

  return null;
}

async function readClipboardImageFile() {
  if (!navigator.clipboard?.read) {
    throw new Error('Clipboard read API unavailable');
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find(type => type.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    return new File([blob], `pasted-image.${extensionFromMime(imageType)}`, { type: imageType });
  }
  return null;
}

function extensionFromMime(mimeType) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff'
  };
  return map[mimeType] || 'png';
}

async function handlePaste(targetIndex, pasteEvent = null) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= state.grid.length) {
    showToast('Select a valid slot before pasting');
    return false;
  }

  try {
    let file = null;
    if (pasteEvent?.clipboardData) {
      file = fileFromClipboardData(pasteEvent.clipboardData);
    }
    if (!file) {
      file = await readClipboardImageFile();
    }

    if (!file) {
      showToast('No image found in clipboard');
      return false;
    }

    const asset = await fileToAsset(file);
    pushHistory(`Paste image in slot ${targetIndex + 1}`);
    state.assets.push(asset);
    state.grid[targetIndex] = asset.id;
    state.selectedSlotIndex = targetIndex;
    state.multiSelectedSlots = [targetIndex];
    await renderAll();
    showToast(`Pasted image into slot ${targetIndex + 1}`);
    return true;
  } catch (err) {
    console.error('Paste failed:', err);
    showToast('Paste failed. Check clipboard permissions.');
    return false;
  }
}

function createGridCell(assetId, index, frame) {
  const cell = document.createElement('div');
  cell.className = 'grid-cell';
  cell.dataset.index = String(index);
  cell.setAttribute('role', 'listitem');
  cell.setAttribute('aria-posinset', String(index + 1));
  cell.setAttribute('aria-setsize', String(state.grid.length));
  if (state.selectedSlotIndex === index) {
    cell.classList.add('selected');
  }
  if (state.multiSelectedSlots.includes(index)) {
    cell.classList.add('multi-selected');
  }
  if (state.keyboardPlacement?.type === 'slot' && state.keyboardPlacement.slotIndex === index) {
    cell.classList.add('keyboard-placement-source');
  }
  const col = index % state.cols;
  if (getGapAfterColumn(col) === 0) {
    cell.classList.add('spread-left');
  }
  if (col > 0 && getGapAfterColumn(col - 1) === 0) {
    cell.classList.add('spread-right');
  }
  cell.style.left = `${frame.left}%`;
  cell.style.top = `${frame.top}%`;
  cell.style.width = `${frame.width}%`;
  cell.style.height = `${frame.height}%`;

  const slotButton = document.createElement('button');
  slotButton.type = 'button';
  slotButton.className = 'grid-cell-slot';
  slotButton.dataset.index = String(index);
  slotButton.draggable = Boolean(assetId);
  slotButton.setAttribute('aria-label', buildSlotAriaLabel(index, assetId));

  const indexLabel = document.createElement('div');
  indexLabel.className = 'grid-cell-index';
  indexLabel.textContent = String(index + 1);
  slotButton.appendChild(indexLabel);

  const empty = document.createElement('div');
  empty.className = 'grid-cell-empty';

  const actions = document.createElement('div');
  actions.className = 'cell-actions';

  const actionToggle = document.createElement('button');
  actionToggle.type = 'button';
  actionToggle.className = 'cell-actions-toggle';
  actionToggle.textContent = '…';
  actionToggle.title = 'Cell actions';
  actionToggle.setAttribute('aria-label', `Open actions for slot ${index + 1}`);
  actionToggle.setAttribute('aria-haspopup', 'menu');
  actionToggle.setAttribute('aria-expanded', 'false');

  const actionMenu = document.createElement('div');
  actionMenu.className = 'cell-actions-popover';
  actionMenu.setAttribute('role', 'menu');
  actionMenu.setAttribute('aria-label', `Actions for slot ${index + 1}`);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.textContent = `◱ Preview`;
  previewBtn.title = 'Preview image';
  previewBtn.setAttribute('aria-label', 'Preview image');
  previewBtn.setAttribute('role', 'menuitem');
  previewBtn.disabled = !assetId;
  const moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.textContent = `↕ Move`;
  moveBtn.title = 'Move image with keyboard';
  moveBtn.setAttribute('aria-label', 'Move image with keyboard');
  moveBtn.setAttribute('role', 'menuitem');
  moveBtn.disabled = !assetId;
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.textContent = assetId ? '↺ Replace' : '+ Add';
  replaceBtn.title = assetId ? 'Replace image' : 'Add image';
  replaceBtn.setAttribute('aria-label', assetId ? 'Replace image' : 'Add image');
  replaceBtn.setAttribute('role', 'menuitem');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '× Clear';
  removeBtn.title = 'Clear cell';
  removeBtn.setAttribute('aria-label', 'Clear cell');
  removeBtn.setAttribute('role', 'menuitem');
  removeBtn.disabled = !assetId;
  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.textContent = '📋 Paste';
  pasteBtn.title = 'Paste image from clipboard';
  pasteBtn.setAttribute('aria-label', 'Paste image from clipboard');
  pasteBtn.setAttribute('role', 'menuitem');
  actionMenu.appendChild(previewBtn);
  actionMenu.appendChild(moveBtn);
  actionMenu.appendChild(replaceBtn);
  actionMenu.appendChild(removeBtn);
  actionMenu.appendChild(pasteBtn);
  actions.appendChild(actionToggle);
  actions.appendChild(actionMenu);

  if (assetId) {
    const asset = findAssetById(assetId);
    if (asset) {
      const img = document.createElement('img');
      img.className = 'grid-cell-image';
      img.src = asset.thumbUrl;
      img.alt = asset.name;
      img.draggable = false;
      // Let the browser decode off the main thread and defer offscreen
      // cells (large grids routinely have far more cells than are ever
      // visible at once through the pan/zoom viewport).
      img.decoding = 'async';
      img.loading = 'lazy';
      img.style.objectFit = state.fit;
      img.style.objectPosition = 'center';
      slotButton.appendChild(img);

      const caption = document.createElement('div');
      caption.className = 'grid-cell-caption';
      caption.textContent = getDisplayName(asset.name);
      caption.title = asset.name;
      slotButton.appendChild(caption);
    }
  }

  if (!assetId) {
    slotButton.appendChild(empty);
  }

  cell.appendChild(slotButton);
  cell.appendChild(actions);

  previewBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeCellActionMenus();
    openPreviewModal(index);
  });

  moveBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeCellActionMenus();
    beginKeyboardPlacementFromSlot(index);
  });

  replaceBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeCellActionMenus();
    replaceGridSlot(index);
  });

  removeBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeCellActionMenus();
    clearGridSlot(index);
  });

  pasteBtn.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    closeCellActionMenus();
    await handlePaste(index);
  });

  actionToggle.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const opening = !actions.classList.contains('open');
    closeCellActionMenus(actions);
    actions.classList.toggle('open', opening);
    actionToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  actionToggle.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    actions.classList.remove('open');
    actionToggle.setAttribute('aria-expanded', 'false');
    slotButton.focus();
  });

  slotButton.addEventListener('dragstart', event => {
    if (!assetId) return;
    ensureDragTooltipImage(event);
    clearFlowPreview();
    const dragSlots = getActiveDragSlots(index);
    if (dragSlots.length > 1) {
      state.dragPayload = { type: 'group', slotIndices: dragSlots.slice() };
      announceDragExpansion(`Dragging ${dragSlots.length} selected images as a group.`);
    } else {
      state.dragPayload = { type: 'slot', slotIndex: index, assetId };
      announceDragExpansion('Dragging image. Move near a canvas edge to expand the grid.');
    }
    beginAutoExpandSession();
    state.lastDragExpandAt = 0;
  });

  slotButton.addEventListener('dragend', () => {
    clearFlowPreview();
    const collapsed = finalizeAutoExpandSession();
    state.dragPayload = null;
    state.lastDragExpandAt = 0;
    clearDragEdgeIndicators();
    if (collapsed) {
      renderAll();
    }
  });

  cell.addEventListener('dragover', event => {
    cell.classList.add('drag-over');
    if (state.dragPayload?.type === 'slot' || state.dragPayload?.type === 'group' || state.dragPayload?.type === 'asset') {
      const flow = resolveFlowInsertionForCell(index, event);
      clearFlowPreview();
      if (flow.nearBetween) {
        updateInsertPreview(index, flow.placement);
        const groupSize = state.dragPayload.type === 'group' ? state.dragPayload.slotIndices?.length || 1 : 1;
        const tooltipText = groupSize > 1
          ? `⇔ Insert ${groupSize} (row reflow)`
          : '⇔ Insert (row reflow)';
        showDragTooltip(event.clientX, event.clientY, 'insert', tooltipText);
      } else {
        if (state.dragPayload.type === 'asset') {
          showDragTooltip(event.clientX, event.clientY, 'insert', '+ Place here');
        } else {
          cell.classList.add('swap-mode');
          showDragTooltip(event.clientX, event.clientY, 'swap', '⇄ Swap');
        }
      }
      state.flowPreview = {
        targetIndex: index,
        insertionIndex: flow.insertionIndex,
        placement: flow.placement,
        nearBetween: flow.nearBetween
      };
    }
    cell.classList.add('drag-over');
  });

  cell.addEventListener('dragleave', () => {
    cell.classList.remove('drag-over', 'swap-mode');
    cell.classList.remove('flow-insert-before', 'flow-insert-after');
  });

  cell.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    cell.classList.remove('drag-over', 'swap-mode');
    hideDragTooltip();
    if (!state.dragPayload) return;
    const flowPreview = state.flowPreview && state.flowPreview.targetIndex === index ? state.flowPreview : null;

    if (state.dragPayload.type === 'slot') {
      clearFlowPreview();
      if (flowPreview?.nearBetween) {
        const targetRow = Math.floor(index / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        finalizeAutoExpandSession(index);
        placeGroupInRowFlow([state.dragPayload.slotIndex], targetRow, insertCol);
      } else {
        swapGridSlots(state.dragPayload.slotIndex, index);
        const collapsed = finalizeAutoExpandSession(index);
        if (collapsed) renderAll();
      }
      return;
    }

    if (state.dragPayload.type === 'group') {
      clearFlowPreview();
      finalizeAutoExpandSession(index);
      if (flowPreview?.nearBetween) {
        const targetRow = Math.floor(index / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        placeGroupInRowFlow(state.dragPayload.slotIndices || [], targetRow, insertCol);
      } else {
        placeGroupInFlow(state.dragPayload.slotIndices || [], index);
      }
      return;
    }

    if (state.dragPayload.type === 'asset') {
      clearFlowPreview();
      if (flowPreview?.nearBetween) {
        const targetRow = Math.floor(index / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        finalizeAutoExpandSession(index);
        placeAssetInRowFlow(state.dragPayload.assetId, targetRow, insertCol);
      } else {
        placeAssetInSlot(state.dragPayload.assetId, index);
        const collapsed = finalizeAutoExpandSession(index);
        if (collapsed) renderAll();
        showToast(`Placed image into slot ${index + 1}`);
      }
      clearFlowPreview();
      return;
    }
  });

  const activateCell = async event => {
    state.selectedSlotIndex = index;

    if ((event.ctrlKey || event.metaKey) && assetId) {
      toggleMultiSelection(index);
      renderGrid();
      return;
    }

    if (!event.ctrlKey && !event.metaKey) {
      state.multiSelectedSlots = assetId ? [index] : [];
    }

    if (state.awaitingAppendSelection && state.pendingImportFiles?.length) {
      const files = state.pendingImportFiles;
      state.pendingImportFiles = null;
      state.awaitingAppendSelection = false;
      await executeImportMode(files, 'append-selected', index);
      return;
    }
    renderGrid();
    focusAfterRender(index);
  };

  slotButton.addEventListener('click', activateCell);

  slotButton.addEventListener('keydown', async event => {
    if (event.key.startsWith('Arrow')) {
      if (state.keyboardPlacement && expandGridForKeyboardPlacement(index, event.key)) {
        event.preventDefault();
        return;
      }
      if (moveGridFocus(index, event.key)) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (cancelKeyboardPlacement()) {
        event.preventDefault();
      }
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && state.keyboardPlacement) {
      event.preventDefault();
      if (event.shiftKey) {
        completeKeyboardFlowPlacement(index, event.altKey ? 'after' : 'before');
      } else {
        completeKeyboardPlacement(index);
      }
      return;
    }

    if (state.keyboardPlacement && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      completeKeyboardFlowPlacement(index, event.key === ']' ? 'after' : 'before');
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      await activateCell(event);
      return;
    }

    if (assetId && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      beginKeyboardPlacementFromSlot(index);
      return;
    }

    if (assetId && (event.key.toLowerCase() === 'p' || event.key.toLowerCase() === 'v')) {
      event.preventDefault();
      openPreviewModal(index);
    }
  });

  slotButton.addEventListener('dblclick', event => {
    event.preventDefault();
    if (assetId) {
      openPreviewModal(index);
    }
  });

  return cell;
}

function renderGrid() {
  els.grid.innerHTML = '';
  els.grid.setAttribute('role', 'list');
  normalizeMultiSelection();
  const metrics = getLayoutMetrics();

  applyZoomSize();

  for (let index = 0; index < state.grid.length; index += 1) {
    const row = Math.floor(index / state.cols);
    const col = index % state.cols;
    const x = metrics.offsetX + metrics.columnOffsets[col];
    const y = metrics.offsetY + row * (metrics.cellHeight + state.gapY);
    const frame = {
      left: (x / metrics.width) * 100,
      top: (y / metrics.height) * 100,
      width: (metrics.cellWidth / metrics.width) * 100,
      height: (metrics.cellHeight / metrics.height) * 100
    };
    els.grid.appendChild(createGridCell(state.grid[index], index, frame));
  }
  createGridEdgeButtons(metrics);
    const insertLineEl = document.createElement('div');
    insertLineEl.className = 'grid-insert-line hidden';
    els.grid.appendChild(insertLineEl);
  applyCanvasTransform();
}

// Draws the current layout onto `canvas`. By default this uses each asset's
// small in-memory thumbnail (fast, used for the Lucid-paste fallback preview
// image and the history timeline thumbnails). Pass `{ fullRes: true }` for
// real exports (PNG copy/download) \u2014 this pulls each used asset's original
// bytes out of IndexedDB as a short-lived Object URL, draws it, then revokes
// it immediately, so full-resolution bitmaps are never kept resident.
async function drawLayoutToCanvas(canvas, { fullRes = false } = {}) {
  const metrics = getLayoutMetrics();
  canvas.width = metrics.width;
  canvas.height = metrics.height;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const fullResUrls = fullRes
    ? await getFullResObjectUrls(state.grid.filter(Boolean))
    : null;

  try {
    for (let i = 0; i < state.grid.length; i += 1) {
      const row = Math.floor(i / state.cols);
      const col = i % state.cols;
      const x = metrics.offsetX + metrics.columnOffsets[col];
      const y = metrics.offsetY + row * (metrics.cellHeight + state.gapY);

      ctx.fillStyle = '#f3f7fc';
      ctx.fillRect(x, y, metrics.cellWidth, metrics.cellHeight);

      const assetId = state.grid[i];
      if (!assetId) {
        ctx.strokeStyle = '#d2deee';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, metrics.cellWidth, metrics.cellHeight);
        continue;
      }

      const asset = findAssetById(assetId);
      if (!asset) continue;

      const image = fullRes
        ? await loadImageOnce(fullResUrls.get(assetId) || asset.thumbUrl)
        : await loadImage(asset.thumbUrl);
      const rect = objectFitRect({ x, y, width: metrics.cellWidth, height: metrics.cellHeight }, image, state.fit);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, metrics.cellWidth, metrics.cellHeight);
      ctx.clip();
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
  } finally {
    if (fullResUrls) {
      for (const url of fullResUrls.values()) {
        if (url) URL.revokeObjectURL(url);
      }
    }
  }
}

async function renderPreview() {
  await drawLayoutToCanvas(els.previewCanvas);
}

async function buildSvgMarkup() {
  const metrics = getLayoutMetrics();

  const defs = [];
  const imageNodes = [];
  const fullResUrls = await getFullResDataUrls(state.grid.filter(Boolean));

  for (let i = 0; i < state.grid.length; i += 1) {
    const row = Math.floor(i / state.cols);
    const col = i % state.cols;
    const x = metrics.offsetX + metrics.columnOffsets[col];
    const y = metrics.offsetY + row * (metrics.cellHeight + state.gapY);
    const clipId = `clip-${i}`;

    defs.push(`<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${metrics.cellWidth}" height="${metrics.cellHeight}"/></clipPath>`);

    const assetId = state.grid[i];
    if (!assetId) {
      imageNodes.push(`<rect x="${x}" y="${y}" width="${metrics.cellWidth}" height="${metrics.cellHeight}" fill="#f3f7fc" stroke="#d2deee"/>`);
      continue;
    }

    const asset = findAssetById(assetId);
    if (!asset) continue;

    const fitRect = objectFitRect({ x, y, width: metrics.cellWidth, height: metrics.cellHeight }, { width: asset.width, height: asset.height }, state.fit);
    const href = fullResUrls.get(assetId) || asset.thumbUrl;
    imageNodes.push(`<rect x="${x}" y="${y}" width="${metrics.cellWidth}" height="${metrics.cellHeight}" fill="#f3f7fc"/>`);
    imageNodes.push(`<image href="${href}" x="${fitRect.x}" y="${fitRect.y}" width="${fitRect.width}" height="${fitRect.height}" clip-path="url(#${clipId})" preserveAspectRatio="none"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${metrics.width}" height="${metrics.height}" viewBox="0 0 ${metrics.width} ${metrics.height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<defs>${defs.join('')}</defs>`,
    imageNodes.join(''),
    '</svg>'
  ].join('');
}

function inferLucidPageLabel(asset, fallbackSlotIndex) {
  const name = String(asset?.name || '');
  const explicit = name.match(/page[^0-9]*(\d{1,6})/i);
  if (explicit) return `Page ${Number(explicit[1])}`;
  const trailing = name.match(/(\d{1,6})(?!.*\d)/);
  if (trailing) return `Page ${Number(trailing[1])}`;
  return `Page ${Math.max(1, Number(fallbackSlotIndex) || 1)}`;
}

function getSpreadEndColForLucid(row, startCol) {
  let endCol = startCol;
  for (let col = startCol; col < state.cols - 1; col += 1) {
    const leftIndex = row * state.cols + col;
    const rightIndex = row * state.cols + (col + 1);
    if (getGapAfterColumn(col) !== 0) break;
    if (!state.grid[leftIndex] || !state.grid[rightIndex]) break;
    endCol = col + 1;
  }
  return endCol;
}

function getLucidItemRenderScale(item) {
  const maxDim = 7000;
  let scale = 1;
  for (const slot of item.slots) {
    const asset = slot.asset;
    if (!asset) continue;
    const sx = (asset.width || slot.width) / Math.max(1, slot.width);
    const sy = (asset.height || item.height) / Math.max(1, item.height);
    scale = Math.max(scale, sx, sy);
  }
  const maxBase = Math.max(1, item.width, item.height);
  const maxSafe = Math.max(1, maxDim / maxBase);
  return clamp(scale, 1, maxSafe);
}

const LUCID_COPY_SINGLE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const LUCID_COPY_SINGLE_IMAGE_MAX_DIMENSION = 4000;
const LUCID_CLIPBOARD_MAX_DIM = LUCID_COPY_SINGLE_IMAGE_MAX_DIMENSION;
const LUCID_CLIPBOARD_JPEG_QUALITY = 0.97;

function mimeFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return '';
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return (match?.[1] || '').toLowerCase();
}

function canvasHasVisibleTransparency(canvasCtx, width, height) {
  const sw = Math.min(64, Math.max(1, width));
  const sh = Math.min(64, Math.max(1, height));
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvasCtx.canvas, 0, 0, sw, sh);
  const { data } = sctx.getImageData(0, 0, sw, sh);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

function dataUrlByteLength(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1).replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function encodeCopyImageWithinLimits(canvas, { hasAlpha, contextLabel }) {
  const width = canvas.width;
  const height = canvas.height;
  if (width > LUCID_COPY_SINGLE_IMAGE_MAX_DIMENSION || height > LUCID_COPY_SINGLE_IMAGE_MAX_DIMENSION) {
    throw new Error(
      `${contextLabel} is ${width}x${height}px, above Lucid's 4000x4000 pixel maximum. `
      + 'Reduce image pixel dimensions and try again.'
    );
  }

  if (hasAlpha) {
    const png = canvas.toDataURL('image/png');
    const pngBytes = dataUrlByteLength(png);
    if (pngBytes <= LUCID_COPY_SINGLE_IMAGE_MAX_BYTES) return png;
    throw new Error(
      `${contextLabel} is ${formatMb(pngBytes)} as PNG, above Lucid's 10MB per-image maximum. `
      + 'Reduce image pixel dimensions and try again.'
    );
  }

  const qualityAttempts = [
    LUCID_CLIPBOARD_JPEG_QUALITY,
    0.92,
    0.88,
    0.84,
    0.8,
    0.76,
    0.72,
    0.68,
    0.64,
    0.6
  ];
  const attempted = new Set();
  let smallest = null;

  for (const quality of qualityAttempts) {
    const q = clamp(Number(quality) || LUCID_CLIPBOARD_JPEG_QUALITY, 0.4, 1);
    if (attempted.has(q)) continue;
    attempted.add(q);
    const jpeg = canvas.toDataURL('image/jpeg', q);
    const bytes = dataUrlByteLength(jpeg);
    if (!smallest || bytes < smallest.bytes) smallest = { jpeg, bytes };
    if (bytes <= LUCID_COPY_SINGLE_IMAGE_MAX_BYTES) return jpeg;
  }

  throw new Error(
    `${contextLabel} is ${formatMb(smallest?.bytes || 0)} after JPEG compression, above Lucid's 10MB per-image maximum. `
    + 'Reduce image pixel dimensions and try again.'
  );
}

function clampImageSize(width, height, maxDim = LUCID_CLIPBOARD_MAX_DIM, pixelScale = 100) {
  const safeW = Math.max(1, Number(width) || 1);
  const safeH = Math.max(1, Number(height) || 1);
  const requestedScale = clamp(Number(pixelScale) || 100, 25, 200) / 100;
  const scaledW = safeW * requestedScale;
  const scaledH = safeH * requestedScale;
  const hardLimitScale = Math.min(1, maxDim / Math.max(1, scaledW, scaledH));
  return {
    width: Math.max(1, Math.round(scaledW * hardLimitScale)),
    height: Math.max(1, Math.round(scaledH * hardLimitScale))
  };
}

async function buildLucidPreparedImageDataUrl(sourceUrl, fallbackWidth, fallbackHeight, pixelScale = 100) {
  if (!sourceUrl) {
    return {
      url: null,
      width: Math.max(1, Math.round(fallbackWidth || 1)),
      height: Math.max(1, Math.round(fallbackHeight || 1))
    };
  }

  const image = await loadImageOnce(sourceUrl);
  const sourceW = image.naturalWidth || image.width || fallbackWidth || 1;
  const sourceH = image.naturalHeight || image.height || fallbackHeight || 1;
  const target = clampImageSize(sourceW, sourceH, LUCID_CLIPBOARD_MAX_DIM, pixelScale);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const sourceMime = mimeFromDataUrl(sourceUrl);
  if (sourceMime === 'image/jpeg' || sourceMime === 'image/jpg') {
    // JPEG cannot carry transparency.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
  } else {
    ctx.clearRect(0, 0, target.width, target.height);
  }
  ctx.drawImage(image, 0, 0, target.width, target.height);

  const hasAlpha = canvasHasVisibleTransparency(ctx, target.width, target.height);
  const contextLabel = 'Copied image';
  const encoded = encodeCopyImageWithinLimits(canvas, { hasAlpha, contextLabel });

  return {
    // Enforce Lucid copy/paste max constraints at encode time.
    url: encoded,
    width: target.width,
    height: target.height
  };
}

async function buildLucidComposedItemDataUrl(item, pixelScale = 100) {
  const images = [];
  for (const slot of item.slots) {
    if (!slot.url) continue;
    const image = await loadImageOnce(slot.url);
    images.push({ slot, image });
  }
  if (images.length === 0) {
    return { url: null, width: item.width, height: item.height };
  }

  const targetHeight = Math.max(1, ...images.map(({ image }) => image.naturalHeight || image.height || 1));
  const widths = images.map(({ image }) => {
    const sourceW = image.naturalWidth || image.width || 1;
    const sourceH = image.naturalHeight || image.height || 1;
    return Math.max(1, Math.round(sourceW * (targetHeight / sourceH)));
  });
  const composedWidth = widths.reduce((sum, w) => sum + w, 0);
  const composedHeight = targetHeight;
  const target = clampImageSize(composedWidth, composedHeight, LUCID_CLIPBOARD_MAX_DIM, pixelScale);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let drawX = 0;
  for (let i = 0; i < images.length; i += 1) {
    const { image } = images[i];
    const drawW = Math.max(1, Math.round(widths[i] * (target.width / composedWidth)));
    ctx.drawImage(image, drawX, 0, drawW, target.height);
    drawX += drawW;
  }

  const hasAlpha = canvasHasVisibleTransparency(ctx, target.width, target.height);
  const encoded = encodeCopyImageWithinLimits(canvas, {
    hasAlpha,
    contextLabel: item.slots.length > 1 ? 'Copied spread image' : 'Copied image'
  });

  return {
    // Enforce Lucid copy/paste max constraints at encode time.
    url: encoded,
    width: target.width,
    height: target.height
  };
}

async function buildLucidExportItemsForClipboard({
  mergeLinkedSpreads = true,
  imagePixelScale = 100,
  onProgress = () => {}
} = {}) {
  const metrics = getLayoutMetrics();
  const usedAssetIds = [...new Set(state.grid.filter(Boolean))];
  const fullResUrls = await getFullResDataUrls(usedAssetIds);
  const items = [];

  for (let row = 0; row < state.rows; row += 1) {
    for (let col = 0; col < state.cols;) {
      const slotIndex = row * state.cols + col;
      const assetId = state.grid[slotIndex];
      if (!assetId) {
        col += 1;
        continue;
      }

      const endCol = mergeLinkedSpreads ? getSpreadEndColForLucid(row, col) : col;
      const slots = [];
      for (let c = col; c <= endCol; c += 1) {
        const idx = row * state.cols + c;
        const id = state.grid[idx];
        if (!id) break;
        const asset = findAssetById(id);
        if (!asset) continue;
        slots.push({
          slotIndex: idx,
          asset,
          left: metrics.columnOffsets[c],
          width: metrics.cellWidth,
          url: fullResUrls.get(id) || asset.thumbUrl,
          label: inferLucidPageLabel(asset, idx + 1)
        });
      }
      if (slots.length === 0) {
        col += 1;
        continue;
      }

      const startCol = slots[0].slotIndex % state.cols;
      const finalCol = slots[slots.length - 1].slotIndex % state.cols;
      const x = metrics.columnOffsets[startCol];
      const y = row * (metrics.cellHeight + state.gapY);
      const width = (metrics.columnOffsets[finalCol] + metrics.cellWidth) - x;
      const height = metrics.cellHeight;

      items.push({
        row,
        startCol,
        endCol: finalCol,
        x,
        y,
        width,
        height,
        slots,
        isSpread: slots.length > 1
      });
      col = finalCol + 1;
    }
  }

  const prepared = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    onProgress(`Preparing Lucid copy ${i + 1} of ${items.length}…`);
    if (!item.isSpread) {
      const slot = item.slots[0];
      const rendered = await buildLucidPreparedImageDataUrl(slot.url, slot.asset.width, slot.asset.height, imagePixelScale);
      prepared.push({ ...item, renderedUrl: rendered.url, sourceWidth: rendered.width, sourceHeight: rendered.height });
      continue;
    }
    const rendered = await buildLucidComposedItemDataUrl(item, imagePixelScale);
    prepared.push({ ...item, renderedUrl: rendered.url, sourceWidth: rendered.width, sourceHeight: rendered.height });
  }

  return {
    items: prepared,
    width: metrics.width,
    height: metrics.height
  };
}

function createLucidLabelObject({ text, x, y, width, height, align = 'center', zOrder = 20, fontSize = 14 }) {
  const id = lucidId();
  const textValue = String(text || '');
  const safeFontSize = clamp(Number(fontSize) || 14, 8, 72);
  // Lucid text marks use an internal size unit where ~2.2222 equals 1px.
  const lucidTextSize = safeFontSize * 2.2222222222222223;
  const markEnd = Math.max(1, textValue.length);
  const marks = [
    { s: 0, n: 'c', v: '#000000ff', e: markEnd },
    { s: 0, n: 's', v: lucidTextSize, e: markEnd }
  ];
  if (align === 'left' || align === 'right') {
    marks.unshift({ s: 0, n: 'a', v: align });
  }
  return {
    id,
    IsBlock: true,
    Action: {
      Action: 'CreateBlock',
      Class: 'DefaultTextBlockNew',
      Properties: {
        BG: 0,
        DisabledFeatures: [],
        Hidden: 0,
        Opacity: 100,
        Restrictions: { acap: false, scap: false },
        RuleList: [],
        ZOrder: zOrder,
        BoundingBox: { x, y, w: width, h: height },
        DataSyncStateIconPosition: null,
        FillColor: '#FFFFFF',
        FlipX: false,
        FlipY: false,
        GutterPadding: 5,
        IgnoreTheme: {},
        ImageFillProps: false,
        InsetMargin: 5,
        LineColor: '#000000',
        LineWidth: 2,
        NoteHint: '',
        Rotation: 0,
        Rounding: null,
        StrokeStyle: 'solid',
        TextAlign: align,
        TRotation: 0,
        TextVAlign: 'middle',
        TextWrap: 'fit',
        TraitsKeySourceCache: [],
        TraitsLucidFieldToSourceCache: [],
        DefaultTextStyle: (align === 'left' || align === 'right') ? { align } : {},
        FixedWidth: false,
        FixedHeight: false,
        MaxWidth: 1000000,
        GrowInAlignmentDirection: false,
        Transparent: 0,
        Text: { t: textValue, m: marks },
        Text_DynamicFontSize: false,
        Font: 'Inter',
        Lock: 0
      }
    }
  };
}

function buildLucidPlainTextFromItems(items) {
  const rows = new Map();
  for (const item of items) {
    const rowItems = rows.get(item.row) || [];
    rowItems.push(item);
    rows.set(item.row, rowItems);
  }

  const rowKeys = [...rows.keys()].sort((a, b) => a - b);
  const lines = [];
  for (let r = 0; r < rowKeys.length; r += 1) {
    const rowItems = rows.get(rowKeys[r]).slice().sort((a, b) => a.startCol - b.startCol);
    for (const item of rowItems) {
      if (item.slots.length <= 1) {
        lines.push(item.slots[0]?.label || '');
      } else {
        const first = item.slots[0]?.label || '';
        const last = item.slots[item.slots.length - 1]?.label || '';
        lines.push(first);
        lines.push(last);
      }
    }
    if (r < rowKeys.length - 1) lines.push('');
  }

  return lines.join('\n');
}

async function buildLucidContentPayload(onProgress = () => {}) {
  const { loadLucidSettings } = window.__lucidExport || {};
  const lucidSettings = loadLucidSettings ? loadLucidSettings() : {};
  const imageScale = clamp(Number(lucidSettings.imageScale) || 100, 25, 400) / 100;
  const imagePixelScale = clamp(Number(lucidSettings.imagePixelScale) || 100, 25, 200);
  const labelTextSize = clamp(Number(lucidSettings.labelTextSize) || 14, 8, 72);
  const mergeLinkedSpreads = lucidSettings.mergeLinkedSpreads !== false;
  const includeOutline = lucidSettings.includeOutline !== false;
  const includePageLabels = lucidSettings.includePageLabels === true;

  onProgress('Preparing Lucid copy payload…');
  const prepared = await buildLucidExportItemsForClipboard({
    mergeLinkedSpreads,
    imagePixelScale,
    onProgress
  });

  // Keep the payload coordinate system stable and only scale block geometry.
  // Scaling both geometry and payload Size together can normalize away the
  // difference in Lucid paste, making 100% and 200% look identical.
  const baseScale = 10;
  const geometryScale = baseScale * imageScale;
  const base = { x: 10000, y: 1000 };
  const objects = [];
  const copiedItemIds = [];
  let zOrder = 20;
  const labelHeight = Math.max(28, Math.round(labelTextSize * 2.8 * imageScale));
  const labelGap = Math.max(8, Math.round(labelTextSize * 0.65 * imageScale));
  let maxBottom = 0;

  onProgress('Building Lucid objects…');
  for (const item of prepared.items) {
    const sourceW = Math.max(1, item.sourceWidth || item.width);
    const sourceH = Math.max(1, item.sourceHeight || item.height);
    const boxW = item.width;
    const boxH = boxW * (sourceH / sourceW);
    const boxX = item.x;
    const boxY = item.y;

    const id = lucidId();
    copiedItemIds.push(id);

    objects.push({
      id,
      IsBlock: true,
      Action: {
        Action: 'CreateBlock',
        Class: 'UserImage2Block',
        Properties: {
          BG: 0,
          DisabledFeatures: [],
          Hidden: 0,
          Opacity: 100,
          Restrictions: { acap: false, scap: false },
          RuleList: [],
          ZOrder: zOrder,
          AspectRatio: sourceW / sourceH,
          BoundingBox: {
            x: base.x + boxX * geometryScale,
            y: base.y + boxY * geometryScale,
            w: boxW * geometryScale,
            h: boxH * geometryScale
          },
          DataSyncStateIconPosition: null,
          DynamicFontSize: false,
          FillColor: {
            pos: 'fill',
            url: item.renderedUrl,
            polys: null
          },
          FlipX: false,
          FlipY: false,
          GutterPadding: 5,
          IgnoreTheme: {},
          ImageFillProps: {
            polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]],
            size: { width: sourceW, height: sourceH },
            url: item.renderedUrl
          },
          InsetMargin: 0,
          LineColor: '#000000ff',
          LineWidth: includeOutline ? 1 : 0,
          NoteHint: '',
          Rotation: 0,
          Rounding: includeOutline ? 12 : 0,
          StrokeStyle: 'solid',
          StylePresetId: 'ss_presetShapeStyle1',
          TextAlign: 'center',
          TRotation: 0,
          TextVAlign: 'middle',
          TraitsKeySourceCache: [],
          TraitsLucidFieldToSourceCache: [],
          Text: ''
        }
      }
    });

    zOrder += 1;

    if (includePageLabels) {
      const leftX = base.x + boxX * geometryScale;
      const labelY = base.y + (boxY * geometryScale) + (boxH * geometryScale) + labelGap;
      if (item.slots.length === 1) {
        const labelObj = createLucidLabelObject({
          text: item.slots[0].label,
          x: leftX,
          y: labelY,
          width: boxW * geometryScale,
          height: labelHeight,
          align: 'center',
          zOrder: zOrder + 1,
          fontSize: labelTextSize
        });
        objects.push(labelObj);
        copiedItemIds.push(labelObj.id);
        zOrder += 1;
      } else {
        const first = item.slots[0];
        const last = item.slots[item.slots.length - 1];
        const leftLabel = createLucidLabelObject({
          text: first.label,
          x: leftX,
          y: labelY,
          width: (boxW * geometryScale) / 2,
          height: labelHeight,
          align: 'left',
          zOrder: zOrder + 1,
          fontSize: labelTextSize
        });
        const rightLabel = createLucidLabelObject({
          text: last.label,
          x: leftX + ((boxW * geometryScale) / 2),
          y: labelY,
          width: (boxW * geometryScale) / 2,
          height: labelHeight,
          align: 'right',
          zOrder: zOrder + 2,
          fontSize: labelTextSize
        });
        objects.push(leftLabel, rightLabel);
        copiedItemIds.push(leftLabel.id, rightLabel.id);
        zOrder += 2;
      }
    }

    const itemBottom = (boxY * geometryScale) + (boxH * geometryScale) + (includePageLabels ? (labelHeight + labelGap + 4) : 0);
    if (itemBottom > maxBottom) maxBottom = itemBottom;
  }
  const size = {
    w: prepared.width * baseScale,
    h: Math.max(prepared.height * baseScale, maxBottom)
  };

  const contentPayload = {
    Objects: objects,
    Base: { ...base },
    Page: 'page1',
    Elements: {},
    Pages: {},
    Size: size,
    Plugins: ['/js/plugins/v2/default.js', '/js/plugins/v2/userimage.js'],
    Document: lucidId(),
    Panel: '',
    PanelOffset: { x: 0, y: 0 },
    BCUVersion: 157,
    CopiedItemIds: copiedItemIds
  };

  return {
    contentPayload,
    preparedItems: prepared.items
  };
}

async function buildLucidHtmlPayload(onProgress = () => {}) {
  const payloadResult = await buildLucidContentPayload(onProgress);
  const payloadJson = JSON.stringify(payloadResult.contentPayload);
  const escapedPayload = escapeHtmlAttr(payloadJson);
  const plainText = buildLucidPlainTextFromItems(payloadResult.preparedItems || []);

  const html = [
    '<html>',
    '<body>',
    '<!--StartFragment-->',
    `<span data-lucid-type="application/vnd.lucid.chart.objects" data-lucid-content="${escapedPayload}"> </span>`,
    '<!--EndFragment-->',
    '</body>',
    '</html>'
  ].join('');

  return {
    html,
    plainText: plainText || 'PNG Grid Lucid payload copied.'
  };
}

async function canvasToPngBlob() {
  await drawLayoutToCanvas(els.previewCanvas, { fullRes: true });
  return new Promise(resolve => {
    els.previewCanvas.toBlob(blob => resolve(blob), 'image/png');
  });
}

async function copyPreviewPng() {
  const pngBlob = await canvasToPngBlob();
  if (!pngBlob) {
    showToast('Preview PNG generation failed');
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })]);
  showToast('Copied PNG preview to clipboard');
}

async function copyLucidchartAsset() {
  try {
    const COPY_PROGRESS_TOAST_MS = 60000;
    const progress = (() => {
      let lastAt = 0;
      let lastMessage = '';
      return message => {
        const now = Date.now();
        if (message !== lastMessage || now - lastAt > 450) {
          showToast(message, COPY_PROGRESS_TOAST_MS);
          lastMessage = message;
          lastAt = now;
        }
      };
    })();
    progress('Preparing Lucid copy…');
    const lucidPayload = await buildLucidHtmlPayload(progress);
    const lucidHtml = lucidPayload.html;
    const plainText = lucidPayload.plainText;
    if (!lucidHtml || lucidHtml.length < 80) {
      throw new Error('Lucid HTML payload was empty.');
    }
    console.info('[copy-lucid] writing html payload', {
      htmlLength: lucidHtml.length,
      plainTextLength: plainText.length
    });
    const primaryItemData = {
      'text/html': new Blob([lucidHtml], { type: 'text/html' }),
      'text/plain': new Blob([plainText], { type: 'text/plain' })
    };
    progress('Copying to clipboard…');
    await navigator.clipboard.write([
      new ClipboardItem(primaryItemData)
    ]);
    showToast('Copied Lucid payload (HTML). Paste with Ctrl+V.');
    return;
  } catch (primaryError) {
    console.error('[copy-lucid] primary HTML payload write failed', primaryError);
    try {
      const svgMarkup = await buildSvgMarkup();
      const plainText = 'PNG Grid fallback payload copied. If Lucid paste fails, try Copy preview PNG.';
      const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob(['<html><body><!--StartFragment--><p>PNG Grid SVG fallback copied.</p><!--EndFragment--></body></html>'], { type: 'text/html' }),
          'image/svg+xml': svgBlob
        })
      ]);
      showToast('Lucid HTML blocked; copied SVG fallback.');
    } catch (svgError) {
      console.error('[copy-lucid] SVG fallback write failed', svgError);
      const pngBlob = await canvasToPngBlob();
      if (!pngBlob) {
        showToast('Lucid copy failed');
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob(['PNG Grid fallback PNG copied.'], { type: 'text/plain' }),
        'text/html': new Blob(['<html><body><!--StartFragment--><p>PNG Grid PNG fallback copied.</p><!--EndFragment--></body></html>'], { type: 'text/html' }),
        [pngBlob.type]: pngBlob
      })]);
      showToast('Clipboard fell back to static PNG.');
    }
  }
}

async function downloadPreviewPng() {
  const pngBlob = await canvasToPngBlob();
  if (!pngBlob) {
    showToast('Preview PNG generation failed');
    return;
  }

  const url = URL.createObjectURL(pngBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'png-grid-preview.png';
  link.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded png-grid-preview.png');
}

function autoPackGrid() {
  if (!state.grid.some(Boolean)) {
    showToast('Add images before auto-packing');
    return;
  }
  if (!confirmAction('Auto-pack will reorder current placements. Continue?')) {
    showToast('Auto-pack cancelled');
    return;
  }
  const packed = state.grid.filter(Boolean);
  for (const asset of state.assets) {
    if (!packed.includes(asset.id)) {
      packed.push(asset.id);
    }
  }
  while (packed.length < state.grid.length) {
    packed.push(null);
  }
  state.grid = packed.slice(0, state.grid.length);
  renderAll();
  showToast('Auto-packed grid');
}

function shuffleGrid() {
  if (!state.grid.some(Boolean)) {
    showToast('Add images before shuffling');
    return;
  }
  if (!confirmAction('Shuffle will randomize your current layout. Continue?')) {
    showToast('Shuffle cancelled');
    return;
  }
  const entries = state.grid.slice();
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  state.grid = entries;
  renderAll();
  showToast('Shuffled grid placements');
}

function clearGrid() {
  if (!state.assets.length && !state.grid.some(Boolean)) {
    showToast('Grid is already empty');
    return;
  }
  if (!confirmAction('Clear and Reset Grid will remove all imported images and reset layout settings. Continue?')) {
    showToast('Clear/reset cancelled');
    return;
  }
  pushHistory('Clear and reset grid');
  state.assets = [];
  state.rows = 3;
  state.cols = 3;
  state.globalGapX = 12;
  state.gapX = 12;
  state.columnGaps = [12, 12];
  state.gapY = 12;
  state.selectedSlotIndex = null;
  state.pendingImportFiles = null;
  state.pendingReplaceFiles = null;
  state.awaitingAppendSelection = false;
  state.pendingGridSequence = null;
  state.pendingGridIsLayout = false;
  state.pendingGridPlacementOffset = 0;
  state.holdingAssetIds = [];
  state.multiSelectedSlots = [];
  resetCanvasLayout();
  state.grid = new Array(9).fill(null);
  // Safe to prune right away: pushHistory() above already snapshotted the
  // old assets, so anything still reachable via undo/redo is preserved.
  void pruneOrphanedAssetBlobs();
  renderAll();
  fitCanvasView();
  showToast('Cleared and reset grid');
}

function applyNumberSettings() {
  const prevRows = state.rows;
  const prevCols = state.cols;
  const prevGlobalGapX = state.globalGapX;
  const prevGapY = state.gapY;
  const prevCellWidth = state.cellWidth;
  const prevCellHeight = state.cellHeight;

  state.globalGapX = clamp(Number(els.gapXInput.value || 0), 0, 120);
  state.gapX = state.globalGapX;
  if (state.globalGapX !== prevGlobalGapX) {
    state.columnGaps = state.columnGaps.map(gap => (gap === 0 ? 0 : state.globalGapX));
  }
  normalizeColumnGaps();
  state.gapY = clamp(Number(els.gapYInput.value || 0), 0, 120);
  state.cellWidth = clamp(Number(els.cellWidthInput.value || 160), 40, 500);
  state.cellHeight = clamp(Number(els.cellHeightInput.value || 120), 40, 500);
  state.fit = 'contain';

  let nextRows = Math.max(1, Number(els.rowsInput.value) || 1);
  let nextCols = Math.max(1, Number(els.colsInput.value) || 1);
  const required = state.assets.length;
  
  // Detect which dimension the user changed
  const colsChanged = nextCols !== prevCols;
  const rowsChanged = nextRows !== prevRows;
  
  if (required > 0 && state.shrinkMode === 'reflow') {
    if (rowsChanged && !colsChanged) {
      // User changed rows explicitly - keep that value fixed and grow columns
      // to fit everyone, with no upper limit.
      nextCols = minColsForRows(nextRows, required);
      showToast('Columns adjusted to fit all images');
    } else if (colsChanged && !rowsChanged) {
      // User changed columns explicitly - keep that value fixed and grow rows
      // to fit everyone, with no upper limit.
      nextRows = minRowsForCols(nextCols, required);
      showToast('Rows adjusted to fit all images');
    }
  }

  const changed =
    prevRows !== nextRows ||
    prevCols !== nextCols ||
    prevGlobalGapX !== state.globalGapX ||
    prevGapY !== state.gapY ||
    prevCellWidth !== state.cellWidth ||
    prevCellHeight !== state.cellHeight;

  if (changed) {
    pushHistory('Manual layout settings change');
  }

  const overflowIds = resizeGridPreserve(nextRows, nextCols, {
    preserveLeadingGaps: state.shrinkMode === 'reflow'
  });

  if (overflowIds.length > 0) {
    pushAssetsToHolding(overflowIds);
    showToast(`${overflowIds.length} image${overflowIds.length === 1 ? '' : 's'} didn't fit and ${overflowIds.length === 1 ? 'was' : 'were'} staged in the Image Tray.`);
  }

  renderAll();
}

function setControlsOpen(open) {
  state.controlsOpen = open;
  els.workspace.classList.toggle('sidebar-collapsed', !open);
  els.controlsPanel.classList.toggle('collapsed', !open);
  els.toggleControlsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  els.toggleControlsBtn.setAttribute('title', open ? 'Hide controls' : 'Show controls');
  els.toggleControlsBtn.setAttribute('aria-label', open ? 'Hide controls' : 'Show controls');
  if (els.revealControlsBtn) {
    els.revealControlsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    els.revealControlsBtn.setAttribute('title', open ? 'Hide controls' : 'Show controls');
    els.revealControlsBtn.setAttribute('aria-label', open ? 'Hide controls' : 'Show controls');
  }
}

function closeTopMenus() {
  if (els.importMenu && els.importMenuBtn) {
    els.importMenu.hidden = true;
    els.importMenuBtn.setAttribute('aria-expanded', 'false');
  }
  if (els.exportMenu && els.exportMenuBtn) {
    els.exportMenu.hidden = true;
    els.exportMenuBtn.setAttribute('aria-expanded', 'false');
  }
}

function toggleMenu(menuEl, buttonEl) {
  const willOpen = menuEl.hidden;
  closeTopMenus();
  menuEl.hidden = !willOpen;
  buttonEl.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (willOpen) {
    requestAnimationFrame(() => {
      const first = getFocusableElements(menuEl)[0];
      if (first) first.focus();
    });
  }
}

function getOpenModalElement() {
  return getManagedModals()
    .filter(modal => modal?.classList.contains('show'))
    .sort((left, right) => Number(right?.dataset.modalOrder || 0) - Number(left?.dataset.modalOrder || 0))[0] || null;
}

function getManagedModals() {
  return [
    els.docImportModal,
    els.docLightboxModal,
    els.previewModal,
    els.historyModal,
    els.exportLogModal,
    els.helpModal,
    els.replaceOptionsModal,
    els.importModeModal,
    els.overflowModal,
    els.lucidSendModal,
    els.lucidSettingsModal
  ].filter(Boolean);
}

function syncModalAccessibilityState() {
  const openModalEl = getOpenModalElement();
  const managedModals = getManagedModals();

  if (els.appShell) {
    els.appShell.inert = Boolean(openModalEl);
    if (openModalEl) {
      els.appShell.setAttribute('aria-hidden', 'true');
    } else {
      els.appShell.removeAttribute('aria-hidden');
    }
  }

  for (const modalEl of managedModals) {
    const isShown = modalEl.classList.contains('show');
    const isTop = modalEl === openModalEl;
    modalEl.inert = isShown && !isTop;
    if (isShown && isTop) {
      modalEl.removeAttribute('aria-hidden');
    } else {
      modalEl.setAttribute('aria-hidden', 'true');
    }
  }
}

function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => el instanceof HTMLElement && el.offsetParent !== null);
}

function focusFirstInModal(modalEl) {
  const first = getFocusableElements(modalEl)[0];
  if (first) {
    first.focus();
  }
}

function openModal(modalEl, { focusTarget = null } = {}) {
  if (!modalEl) return;
  if (!modalEl.classList.contains('show')) {
    state.modalFocusStack.push({
      modalEl,
      returnEl: document.activeElement instanceof HTMLElement ? document.activeElement : null
    });
  }
  modalEl.classList.add('show');
  modalEl.dataset.modalOrder = String(++modalOpenSequence);
  syncModalAccessibilityState();
  requestAnimationFrame(() => {
    if (focusTarget instanceof HTMLElement && modalEl.classList.contains('show')) {
      focusTarget.focus();
      return;
    }
    focusFirstInModal(modalEl);
  });
}

function closeModal(modalEl, { restoreFocus = true } = {}) {
  if (!modalEl) return;
  modalEl.classList.remove('show');
  delete modalEl.dataset.modalOrder;
  const stackIndex = state.modalFocusStack.findLastIndex(entry => entry.modalEl === modalEl);
  const stackEntry = stackIndex >= 0 ? state.modalFocusStack.splice(stackIndex, 1)[0] : null;
  syncModalAccessibilityState();
  if (restoreFocus && stackEntry?.returnEl instanceof HTMLElement) {
    stackEntry.returnEl.focus();
  }
}

function trapModalTabKey(event, modalEl) {
  const focusables = getFocusableElements(modalEl);
  if (focusables.length === 0) {
    event.preventDefault();
    return true;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function handleOpenModalKeydown(event) {
  const openModalEl = getOpenModalElement();
  if (!openModalEl) return false;

  if (event.key === 'Tab') {
    return trapModalTabKey(event, openModalEl);
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    if (openModalEl === els.replaceOptionsModal) {
      closeReplaceOptionsModal();
      state.pendingReplaceFiles = null;
      state.pendingImportFiles = null;
      showToast('Replace cancelled');
    } else if (openModalEl === els.importModeModal) {
      closeImportModeModal();
      state.pendingImportFiles = null;
      state.awaitingAppendSelection = false;
      showToast('Import cancelled');
    } else if (openModalEl === els.overflowModal) {
      closeOverflowModal();
      state.pendingGridSequence = null;
      state.pendingGridIsLayout = false;
      state.pendingGridPlacementOffset = 0;
      showToast('Resize cancelled');
    } else if (openModalEl === els.historyModal) {
      closeModal(els.historyModal);
    } else if (openModalEl === els.exportLogModal) {
      closeModal(els.exportLogModal);
    } else if (openModalEl === els.helpModal) {
      closeModal(els.helpModal);
    } else if (openModalEl === els.docLightboxModal) {
      closeDocLightbox();
    } else if (openModalEl === els.previewModal) {
      closePreviewModal();
    } else if (openModalEl === els.docImportModal) {
      closeDocImportModal();
    } else if (openModalEl === els.lucidSendModal) {
      closeModal(els.lucidSendModal);
    } else if (openModalEl === els.lucidSettingsModal) {
      closeModal(els.lucidSettingsModal);
    }
    return true;
  }

  return false;
}

function getReplaceSizingModeLabel(mode) {
  if (mode === 'current-cols') return 'Keep current columns';
  if (mode === 'current-rows') return 'Keep current rows';
  if (mode === 'keep-current') return 'Keep current grid size';
  if (mode === 'custom') return 'Custom rows and columns';
  return 'Recommended (close to square)';
}

function resolveReplaceGridDimensions(assetCount, firstRowOffset, sizingMode = 'recommended', customRows = state.rows, customCols = state.cols) {
  const mode = ['recommended', 'current-cols', 'current-rows', 'keep-current', 'custom'].includes(sizingMode)
    ? sizingMode
    : 'recommended';

  let rows = mode === 'custom' ? Number(customRows) || state.rows : state.rows;
  let cols = mode === 'custom'
    ? Math.max(Number(customCols) || state.cols, firstRowOffset + 1)
    : Math.max(state.cols, firstRowOffset + 1);

  if (mode === 'recommended') {
    // Get recommendation WITHOUT offset - recommend based purely on image count for square layout
    const rec = recommendedDims(assetCount);
    rows = rec.rows;
    cols = Math.max(rec.cols, firstRowOffset + 1);
  } else if (mode === 'current-cols') {
    rows = minRowsForCols(cols, assetCount, firstRowOffset);
  } else if (mode === 'current-rows') {
    cols = minColsForRows(rows, assetCount, firstRowOffset);
  } else if (mode === 'custom') {
    // Auto-grow rows to fit everyone at the user's chosen column count, but
    // never shrink below what the user explicitly entered. No upper cap —
    // extra rows are added instead of overflowing into the Image Tray.
    rows = Math.max(rows, minRowsForCols(cols, assetCount, firstRowOffset));
  }

  rows = Math.max(1, rows);
  cols = Math.max(1, firstRowOffset + 1, cols);

  return {
    rows,
    cols,
    capacity: capacityForDims(rows, cols, firstRowOffset),
    mode
  };
}

function populateReplaceOffsetOptions() {
  if (!els.replaceOffsetSelect) return;
  const count = state.pendingReplaceFiles?.length || 0;
  const sizingMode = els.replaceSizingSelect?.value || 'recommended';
  const customCols = Math.max(1, Number(els.replaceColsSelect?.value) || state.cols);
  const customRows = Math.max(1, Number(els.replaceRowsSelect?.value) || state.rows);
  const baseDims = count > 0
    ? resolveReplaceGridDimensions(count, 0, sizingMode, customRows, customCols)
    : { cols: sizingMode === 'custom' ? customCols : state.cols };
  const maxStartCol = Math.max(1, baseDims.cols || 1);
  const currentValue = clamp(Number(els.replaceOffsetSelect.value || 1), 1, maxStartCol);
  els.replaceOffsetSelect.innerHTML = '';
  for (let col = 1; col <= maxStartCol; col += 1) {
    const option = document.createElement('option');
    option.value = String(col);
    option.textContent = `Column ${col}`;
    els.replaceOffsetSelect.appendChild(option);
  }
  els.replaceOffsetSelect.value = String(currentValue);
}

function populateReplaceDimensionOptions() {
  if (!els.replaceRowsSelect || !els.replaceColsSelect) return;

  const currentRows = Math.max(1, Number(els.replaceRowsSelect.value) || state.rows);
  const currentCols = Math.max(1, Number(els.replaceColsSelect.value) || state.cols);

  els.replaceRowsSelect.value = String(currentRows);
  els.replaceColsSelect.value = String(currentCols);
}

function updateReplaceOptionsSummary() {
  const files = state.pendingReplaceFiles || [];
  const count = files.length;
  if (!count || !els.replaceOffsetSelect) return;

  const startCol = Math.max(1, Number(els.replaceOffsetSelect.value) || 1);
  const sizingMode = els.replaceSizingSelect?.value || 'recommended';
  const firstRowOffset = startCol - 1;
  const customRows = Math.max(1, Number(els.replaceRowsSelect?.value) || state.rows);
  const customCols = Math.max(1, Number(els.replaceColsSelect?.value) || state.cols);
  const rec = recommendedDims(count, firstRowOffset);
  const minRowsCurrentCols = minRowsForCols(Math.max(1, state.cols), count, firstRowOffset);
  const minColsCurrentRows = minColsForRows(Math.max(1, state.rows), count, firstRowOffset);
  const selectedDims = resolveReplaceGridDimensions(count, firstRowOffset, sizingMode, customRows, customCols);

  if (els.replaceRowsSelect) {
    els.replaceRowsSelect.value = String(selectedDims.rows);
    els.replaceRowsSelect.disabled = sizingMode !== 'custom';
  }
  if (els.replaceColsSelect) {
    els.replaceColsSelect.value = String(selectedDims.cols);
    els.replaceColsSelect.disabled = sizingMode !== 'custom';
  }

  if (els.replaceModeMessage) {
    els.replaceModeMessage.textContent = `${count} image${count === 1 ? '' : 's'} will replace the current grid.`;
  }
  if (els.replaceOffsetHint) {
    els.replaceOffsetHint.textContent = `First row starts at column ${startCol}; columns before that stay empty.`;
  }
  if (els.replaceModeRecommendation) {
    els.replaceModeRecommendation.textContent = `Suggested size with this offset: ${rec.cols} x ${rec.rows}. Selected mode (${getReplaceSizingModeLabel(sizingMode)}): ${selectedDims.cols} x ${selectedDims.rows}.`;
  }
  if (els.replaceModeMinimums) {
    const overflowNote = selectedDims.capacity < count
      ? ` ${count - selectedDims.capacity} image(s) will be staged in Image Tray due to size limits.`
      : '';
    els.replaceModeMinimums.textContent = `Minimums at this offset: ${minRowsCurrentCols} row(s) for current ${state.cols} column(s), or ${minColsCurrentRows} column(s) for current ${state.rows} row(s).${overflowNote}`;
  }
}

function openReplaceOptionsModal(files) {
  state.pendingReplaceFiles = Array.isArray(files) ? files.slice() : [];
  const count = state.pendingReplaceFiles.length;
  if (count === 0) return;

  populateReplaceOffsetOptions();
  populateReplaceDimensionOptions();
  if (els.replaceOffsetSelect) {
    els.replaceOffsetSelect.value = '1';
  }
  if (els.replaceSizingSelect) {
    els.replaceSizingSelect.value = 'recommended';
  }
  updateReplaceOptionsSummary();

  openModal(els.replaceOptionsModal);
}

function closeReplaceOptionsModal() {
  closeModal(els.replaceOptionsModal);
}

function openOverflowModal(assetCount, firstRowOffset = 0) {
  const rec = recommendedDims(assetCount, firstRowOffset);
  state.overflowModalOpen = true;
  state.pendingGridPlacementOffset = normalizeFirstRowOffset(firstRowOffset, state.cols);
  const startCol = state.pendingGridPlacementOffset + 1;
  const initialCols = Math.max(state.cols, rec.cols);
  const initialRows = Math.max(state.rows, rec.rows);
  state.pendingOverflowInitialCols = initialCols;
  state.pendingOverflowInitialRows = initialRows;
  els.overflowMessage.textContent = `${assetCount} images were imported, but the current grid has ${state.grid.length} spaces.`;
  els.overflowRecommendation.textContent = `Recommended size (offset starts at column ${startCol}): ${rec.cols} x ${rec.rows}.`;
  els.overflowColsInput.value = String(initialCols);
  els.overflowRowsInput.value = String(initialRows);
  openModal(els.overflowModal);
}

function openImportModeModal(fileCount) {
  const existingCount = state.assets.length;
  els.importModeMessage.textContent = `${fileCount} new image${fileCount === 1 ? '' : 's'} ready to import.`;
  if (existingCount > 0) {
    els.importExistingNotice.textContent = `Current session already has ${existingCount} image${existingCount === 1 ? '' : 's'}. Choose replace, fill, or append.`;
  } else {
    els.importExistingNotice.textContent = 'Current session is empty. Replace starts a fresh grid.';
  }
  openModal(els.importModeModal);
}

function closeImportModeModal() {
  closeModal(els.importModeModal);
}

async function executeImportMode(files, mode, selectedIndex = state.selectedSlotIndex, options = {}) {
  if (mode === 'replace' && state.assets.length > 0) {
    if (!confirmAction('Replace current grid? This will discard all existing imported images and layout assignments.')) {
      showToast('Replace cancelled');
      return;
    }
  }

  const nextAssets = [];
  for (const file of files) {
    nextAssets.push(await fileToAsset(file));
  }
  const nextIds = nextAssets.map(asset => asset.id);

  if (mode === 'replace') {
    const requestedFirstRowOffset = Math.max(0, Number(options.firstRowOffset || 0));
    const replaceSizing = options.replaceSizing || 'recommended';
    const customRows = Math.max(1, Number(options.customRows) || state.rows);
    const customCols = Math.max(1, Number(options.customCols) || state.cols);
    const previousAssetIds = state.assets.map(asset => asset.id);
    state.assets = nextAssets;
    // Nothing captures the pre-replace assets in undo history (this mode's
    // only pushHistory() call happens further below, after the swap), so the
    // old full-resolution blobs are already unreachable \u2014 safe to prune now.
    void deleteAssetBlobs(previousAssetIds);
    state.holdingAssetIds = [];
    const sequence = nextIds.slice();
    const dims = resolveReplaceGridDimensions(sequence.length, requestedFirstRowOffset, replaceSizing, customRows, customCols);
    if (dims.rows !== state.rows || dims.cols !== state.cols) {
      resizeGridPreserve(dims.rows, dims.cols);
    }

    const firstRowOffset = normalizeFirstRowOffset(requestedFirstRowOffset, state.cols);

    const placeCapacity = capacityForDims(state.rows, state.cols, firstRowOffset);
    const placed = sequence.slice(0, placeCapacity);
    const overflow = sequence.slice(placeCapacity);
    placeSequenceInGrid(placed, firstRowOffset);
    if (overflow.length > 0) {
      pushAssetsToHolding(overflow);
    }

    await renderAll();
    pushHistory(`Replace with ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
    if (overflow.length > 0) {
      showToast(`Replaced with ${placed.length} image${placed.length === 1 ? '' : 's'}; ${overflow.length} staged in Image Tray`);
    } else {
      showToast(`Replaced with ${nextAssets.length} images (${dims.cols} x ${dims.rows})`);
    }
    return;
  }

  state.assets = state.assets.concat(nextAssets);

  if (mode === 'fill') {
    const updated = state.grid.slice();
    const remaining = nextIds.slice();
    for (let i = 0; i < updated.length && remaining.length > 0; i += 1) {
      if (updated[i] === null) {
        updated[i] = remaining.shift();
      }
    }
    state.grid = updated;
    if (remaining.length > 0) {
      const layout = updated.slice();
      const lastOccupied = layout.map((id, i) => (id ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      layout.splice(lastOccupied + 1, 0, ...remaining);
      queueOverflowLayout(layout);
      await renderAll();
      pushHistory(`Fill ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
      showToast(`Imported ${nextAssets.length} images. Resize to place all.`);
      return;
    }
    await renderAll();
    pushHistory(`Fill ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
    showToast(`Added ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'} using gap fill`);
    return;
  }

  const layout = state.grid.slice();
  let insertIndex = 0;
  if (mode === 'append-start') {
    insertIndex = 0;
  } else if (mode === 'append-end') {
    const lastOccupied = layout.map((id, i) => (id ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    insertIndex = lastOccupied + 1;
  } else if (mode === 'append-selected') {
    const selected = selectedIndex ?? layout.length;
    insertIndex = clamp(selected, 0, layout.length);
  } else if (mode === 'tray') {
    // Add directly to holding tray without modifying grid
    pushAssetsToHolding(nextIds);
    await renderAll();
    pushHistory(`Add ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'} to tray`);
    showToast(`Added ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'} to tray`);
    return;
  } else {
    insertIndex = 0;
  }

  layout.splice(insertIndex, 0, ...nextIds);
  const capacity = state.grid.length;
  while (layout.length > capacity && layout[layout.length - 1] == null) {
    layout.pop();
  }

  if (layout.length > capacity) {
    queueOverflowLayout(layout);
    await renderAll();
    pushHistory(`Append ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
    showToast(`Imported ${nextAssets.length} images. Resize to place all.`);
    return;
  } else {
    placeLayoutInGrid(layout);
  }

  await renderAll();
  pushHistory(`Append ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
  showToast(`Appended ${nextAssets.length} image${nextAssets.length === 1 ? '' : 's'}`);
}

function closeOverflowModal() {
  state.overflowModalOpen = false;
  closeModal(els.overflowModal);
}

function applyOverflowDimensions() {
  const required = state.pendingGridSequence?.length || state.assets.length;
  let cols = Math.max(1, Number(els.overflowColsInput.value) || 1);
  let rows = Math.max(1, Number(els.overflowRowsInput.value) || 1);
  const rawOffset = Math.max(0, Number(state.pendingGridPlacementOffset) || 0);
  cols = Math.max(cols, rawOffset + 1);
  const firstRowOffset = normalizeFirstRowOffset(rawOffset, cols);

  // Detect which field the user actually edited so we know which axis to
  // treat as fixed, then grow the other one — with no upper limit — to fit
  // everyone instead of leaving a shortfall that gets staged in the tray.
  const colsChanged = cols !== state.pendingOverflowInitialCols;
  const rowsChanged = rows !== state.pendingOverflowInitialRows;

  if (required > 0) {
    if (rowsChanged && !colsChanged) {
      cols = Math.max(cols, minColsForRows(rows, required, firstRowOffset));
    } else {
      rows = Math.max(rows, minRowsForCols(cols, required, firstRowOffset));
    }
  }

  const capacity = capacityForDims(rows, cols, firstRowOffset);

  resizeGridPreserve(rows, cols);
  let overflowIds = [];
  if (state.pendingGridSequence && state.pendingGridSequence.length > 0) {
    if (state.pendingGridSequence.length > capacity) {
      overflowIds = state.pendingGridSequence.slice(capacity);
    }
    if (state.pendingGridIsLayout) {
      placeLayoutInGrid(state.pendingGridSequence);
    } else {
      const adjustedOffset = normalizeFirstRowOffset(state.pendingGridPlacementOffset || 0, cols);
      placeSequenceInGrid(state.pendingGridSequence, adjustedOffset);
    }
  } else {
    fillUnplacedIntoEmpty();
  }
  state.pendingGridSequence = null;
  state.pendingGridIsLayout = false;
  state.pendingGridPlacementOffset = 0;
  state.pendingOverflowInitialRows = null;
  state.pendingOverflowInitialCols = null;
  closeOverflowModal();

  if (overflowIds.length > 0) {
    pushAssetsToHolding(overflowIds);
    renderAll();
    showToast(`Grid resized to ${cols} x ${rows}. ${overflowIds.length} image${overflowIds.length === 1 ? '' : 's'} didn't fit and ${overflowIds.length === 1 ? 'was' : 'were'} staged in the Image Tray.`);
  } else {
    renderAll();
    showToast(`Grid resized to ${cols} x ${rows}`);
  }
}

async function readDirectoryEntry(entry, collected) {
  const reader = entry.createReader();

  const readBatch = async () => {
    const entries = await new Promise(resolve => reader.readEntries(resolve));
    if (entries.length === 0) return;

    for (const child of entries) {
      if (child.isFile) {
        const file = await new Promise(resolve => child.file(resolve));
        if (file.type.startsWith('image/')) {
          collected.push(file);
        }
      } else if (child.isDirectory) {
        await readDirectoryEntry(child, collected);
      }
    }

    await readBatch();
  };

  await readBatch();
}

function isDocumentFile(file) {
  const docExts = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'];
  const fileName = file.name.toLowerCase();
  return docExts.some(ext => fileName.endsWith(ext));
}

function bindGlobalDrop() {
  const showCurtain = () => els.dropCurtain.classList.add('show');
  const hideCurtain = () => els.dropCurtain.classList.remove('show');
  const resetDropOverlay = () => {
    state.dropDepth = 0;
    hideCurtain();
    clearDragEdgeIndicators();
  };

  window.addEventListener('dragenter', event => {
    if (!isFileDrag(event) && state.dropDepth === 0) return;
    event.preventDefault();
    event.stopPropagation();
    state.dropDepth += 1;
    showCurtain();
  }, true);

  window.addEventListener('dragover', event => {
    if (!isFileDrag(event) && state.dropDepth === 0) return;
    event.preventDefault();
    event.stopPropagation();
    showCurtain();
  }, true);

  window.addEventListener('dragleave', event => {
    if (!isFileDrag(event) && state.dropDepth === 0) return;
    event.preventDefault();
    event.stopPropagation();
    state.dropDepth = Math.max(0, state.dropDepth - 1);
    if (state.dropDepth === 0) {
      hideCurtain();
      clearDragEdgeIndicators();
    }
  }, true);

  window.addEventListener('drop', async event => {
    try {
      // Skip if import modal is open - let modal drop listener handle it
      if (els.docImportModal?.classList.contains('show')) {
        return;
      }

      const dt = event.dataTransfer;
      const hasFileItems = Boolean(dt && ((dt.files && dt.files.length > 0) || (dt.items && Array.from(dt.items).some(item => item.kind === 'file'))));
      if (!hasFileItems) {
        if (state.dropDepth > 0) {
          resetDropOverlay();
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const files = [];
      for (const item of dt?.items || []) {
        if (item.kind !== 'file') continue;
        try {
          const entry = item.webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            await readDirectoryEntry(entry, files);
            continue;
          }
          const file = item.getAsFile();
          if (file) files.push(file);
        } catch {
          const fallbackFile = item.getAsFile?.();
          if (fallbackFile) files.push(fallbackFile);
        }
      }

      if (files.length === 0 && dt?.files?.length) {
        files.push(...Array.from(dt.files));
      }

      if (files.length === 0) {
        showToast('No files found in drop');
        return;
      }

      // Separate documents from images
      const docFiles = files.filter(f => isDocumentFile(f));
      const imageFiles = files.filter(f => !isDocumentFile(f));

      // If there are documents, process the first one via import modal
      if (docFiles.length > 0) {
        openDocImportModal();
        await processDocFile(docFiles[0]);
        // If there are also images, queue them for after import
        if (imageFiles.length > 0) {
          showToast(`Imported document. ${imageFiles.length} image file(s) ready to add separately.`);
        }
      } else if (imageFiles.length > 0) {
        // Only images - use existing flow
        await addFiles(imageFiles);
      } else {
        showToast('No supported files found in drop');
        return;
      }
    } catch (error) {
      console.error('Drop import failed', error);
      showToast('Drop import failed. Try Add files.');
    } finally {
      resetDropOverlay();
    }
  }, true);

  window.addEventListener('dragend', resetDropOverlay);
  window.addEventListener('blur', resetDropOverlay);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      resetDropOverlay();
    }
  });
}

function bindCanvasInteractions() {
  let panStartX = 0;
  let panStartY = 0;

  els.canvasViewport.addEventListener('dragover', event => {
    if (!state.dragPayload || isFileDrag(event)) return;
    event.preventDefault();
    maybeExpandGridForDragHover(event);
    const hoveredCell = event.target instanceof Element ? event.target.closest('.grid-cell') : null;
    if ((state.dragPayload?.type === 'slot' || state.dragPayload?.type === 'group' || state.dragPayload?.type === 'asset') && !hoveredCell) {
      const gap = resolveFlowInsertionForGap(event);
      if (gap) {
        clearFlowPreview();
        updateInsertPreview(gap.targetIndex, gap.placement);
        const groupSize = state.dragPayload.type === 'group' ? state.dragPayload.slotIndices?.length || 1 : 1;
        const tooltipText = groupSize > 1
          ? `⇔ Insert ${groupSize} (row reflow)`
          : '⇔ Insert (row reflow)';
        showDragTooltip(event.clientX, event.clientY, 'insert', tooltipText);
        state.flowPreview = gap;
      }
    }
  });

  els.canvasViewport.addEventListener('drop', event => {
    if (isFileDrag(event)) return;
    const hoveredCell = event.target instanceof Element ? event.target.closest('.grid-cell') : null;
    const flowPreview = state.flowPreview;
    clearFlowPreview();
    
    // Handle gap-based insertion (from dragover on canvas)
    if (flowPreview?.nearBetween && !hoveredCell) {
      if (state.dragPayload?.type === 'slot') {
        const targetRow = Math.floor(flowPreview.targetIndex / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        finalizeAutoExpandSession(flowPreview.targetIndex);
        placeGroupInRowFlow([state.dragPayload.slotIndex], targetRow, insertCol);
        state.dragPayload = null;
        return;
      } else if (state.dragPayload?.type === 'group') {
        const targetRow = Math.floor(flowPreview.targetIndex / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        finalizeAutoExpandSession(flowPreview.targetIndex);
        placeGroupInFlow(state.dragPayload.slotIndices, flowPreview.insertionIndex);
        state.dragPayload = null;
        return;
      } else if (state.dragPayload?.type === 'asset') {
        const targetRow = Math.floor(flowPreview.targetIndex / state.cols);
        const insertCol = clamp(flowPreview.insertionIndex - targetRow * state.cols, 0, state.cols);
        finalizeAutoExpandSession(flowPreview.targetIndex);
        placeAssetInRowFlow(state.dragPayload.assetId, targetRow, insertCol);
        state.dragPayload = null;
        return;
      }
    }
    
    const collapsed = finalizeAutoExpandSession();
    state.dragPayload = null;
    state.lastDragExpandAt = 0;
    clearDragEdgeIndicators();
    if (collapsed) {
      renderAll();
    }
  });

  els.canvasViewport.addEventListener('contextmenu', event => {
    event.preventDefault();
  });

  // Coalesce rapid wheel events (trackpads especially can fire many per
  // frame) into a single zoom update per animation frame, instead of doing
  // a full anchor-recalculation + style write for every individual tick.
  let pendingWheelFactor = 1;
  let pendingWheelX = 0;
  let pendingWheelY = 0;
  let wheelRafId = null;
  els.canvasViewport.addEventListener('wheel', event => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    pendingWheelFactor *= factor;
    pendingWheelX = event.clientX;
    pendingWheelY = event.clientY;
    if (wheelRafId == null) {
      wheelRafId = requestAnimationFrame(() => {
        wheelRafId = null;
        const combinedFactor = pendingWheelFactor;
        pendingWheelFactor = 1;
        zoomAt(pendingWheelX, pendingWheelY, combinedFactor);
      });
    }
  }, { passive: false });

  els.canvasViewport.addEventListener('mousedown', event => {
    if (event.button === 2) {
      event.preventDefault();
      state.isPanning = true;
      panStartX = event.clientX - state.panX;
      panStartY = event.clientY - state.panY;
      els.canvasViewport.classList.add('panning');
      return;
    }

    const isBackground = event.target === els.canvasViewport || event.target === els.canvasStage || event.target === els.grid;
    if (!isBackground || event.button !== 0) return;

    state.isPanning = true;
    panStartX = event.clientX - state.panX;
    panStartY = event.clientY - state.panY;
    els.canvasViewport.classList.add('panning');
  });

  window.addEventListener('mousemove', event => {
    if (!state.isPanning) return;
    state.panX = event.clientX - panStartX;
    state.panY = event.clientY - panStartY;
    applyCanvasTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!state.isPanning) return;
    state.isPanning = false;
    els.canvasViewport.classList.remove('panning');
  });

  window.addEventListener('dragend', () => {
    clearFlowPreview();
    const collapsed = finalizeAutoExpandSession();
    state.dragPayload = null;
    state.lastDragExpandAt = 0;
    clearDragEdgeIndicators();
    if (collapsed) {
      renderAll();
    }
  });

  els.zoomInBtn.addEventListener('click', () => {
    const rect = els.canvasViewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.15);
  });

  els.zoomOutBtn.addEventListener('click', () => {
    const rect = els.canvasViewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.87);
  });

  els.resetViewBtn.addEventListener('click', () => {
    state.zoom = clampZoom(getFitCanvasZoom());
    renderGrid();
  });

  els.fitViewBtn.addEventListener('click', () => {
    fitCanvasView();
  });

  window.addEventListener('resize', () => {
    updateViewportLayout();
    if (!els.canvasViewport) return;
    fitCanvasView();
  });
}

// ─── Document import feature ──────────────────────────────────────────────────

const docImportState = {
  thumbnails: [],      // [{dataUrl, label, width, height}]
  selected: new Set(), // indices of selected pages
  abortController: null,
  activeIndex: -1,
  lightboxIndex: -1,
};

function openDocImportModal() {
  openModal(els.docImportModal);
  resetDocImportToDropZone();
}

function closeDocImportModal() {
  docImportState.abortController?.abort();
  docImportState.abortController = null;
  closeModal(els.docImportModal);
}

function showDocImportStep(step) {
  const showUpload = step === 'upload';
  if (els.docImportStepUpload) els.docImportStepUpload.hidden = !showUpload;
  if (els.docImportStepExplorer) els.docImportStepExplorer.hidden = showUpload;
}

function resetDocImportToDropZone() {
  docImportState.thumbnails = [];
  docImportState.selected.clear();
  docImportState.activeIndex = -1;
  docImportState.lightboxIndex = -1;
  showDocImportStep('upload');
  els.docImportDropZone.hidden = false;
  els.docImportProgress.hidden = true;
  els.docImportBackBtn.hidden = true;
  els.docImportConfirmBtn.disabled = true;
  els.docSelectionCount.textContent = '';
  els.docImportSubtitle.textContent = 'Step 1 of 2 · Select and import a document';
  if (els.docPreviewImage) {
    els.docPreviewImage.hidden = true;
    els.docPreviewImage.src = '';
  }
  if (els.docPreviewEmpty) els.docPreviewEmpty.hidden = false;
  if (els.docPreviewLabel) els.docPreviewLabel.textContent = '';
  if (els.docFileInput) els.docFileInput.value = '';
}

function setDocProgress(current, total, label) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.docProgressBar.style.width = `${pct}%`;
  els.docProgressLabel.textContent = label || `${current} / ${total}`;
}

function updateDocSelectionCount() {
  const n = docImportState.selected.size;
  const total = docImportState.thumbnails.length;
  els.docSelectionCount.textContent = n > 0 ? `${n} of ${total} selected` : '';
  els.docImportConfirmBtn.disabled = n === 0;
}

function setDocActiveIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= docImportState.thumbnails.length) return;
  docImportState.activeIndex = index;
  renderDocPreviewPanel();
}

function renderDocPreviewPanel() {
  const idx = docImportState.activeIndex;
  const thumb = docImportState.thumbnails[idx];
  if (!thumb) {
    if (els.docPreviewImage) {
      els.docPreviewImage.hidden = true;
      els.docPreviewImage.src = '';
    }
    if (els.docPreviewEmpty) els.docPreviewEmpty.hidden = false;
    if (els.docPreviewLabel) els.docPreviewLabel.textContent = '';
    return;
  }

  if (els.docPreviewImage) {
    els.docPreviewImage.src = thumb.dataUrl;
    els.docPreviewImage.alt = thumb.label;
    els.docPreviewImage.hidden = false;
  }
  if (els.docPreviewEmpty) els.docPreviewEmpty.hidden = true;
  if (els.docPreviewLabel) {
    const dims = thumb.width && thumb.height ? ` (${Math.round(thumb.width)} x ${Math.round(thumb.height)})` : '';
    els.docPreviewLabel.textContent = `${thumb.label}${dims}`;
  }
}

function openDocLightbox(startIndex = docImportState.activeIndex) {
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= docImportState.thumbnails.length) return;
  docImportState.lightboxIndex = startIndex;
  renderDocLightbox();
  openModal(els.docLightboxModal);
}

function closeDocLightbox() {
  closeModal(els.docLightboxModal);
  docImportState.lightboxIndex = -1;
}

function stepDocLightbox(delta) {
  if (!docImportState.thumbnails.length) return;
  const total = docImportState.thumbnails.length;
  const base = Number.isInteger(docImportState.lightboxIndex) && docImportState.lightboxIndex >= 0
    ? docImportState.lightboxIndex
    : 0;
  const next = (base + delta + total) % total;
  docImportState.lightboxIndex = next;
  docImportState.activeIndex = next;
  renderDocLightbox();
  renderDocPreviewPanel();
}

function renderDocLightbox() {
  const idx = docImportState.lightboxIndex;
  const thumb = docImportState.thumbnails[idx];
  if (!thumb) return;
  if (els.docLightboxImage) {
    els.docLightboxImage.src = thumb.dataUrl;
    els.docLightboxImage.alt = thumb.label;
  }
  if (els.docLightboxLabel) {
    els.docLightboxLabel.textContent = `${thumb.label} (${idx + 1} / ${docImportState.thumbnails.length})`;
  }
}

function renderDocThumbnails() {
  els.docThumbGrid.innerHTML = '';
  els.docThumbGrid.setAttribute('role', 'listbox');
  els.docThumbGrid.setAttribute('aria-multiselectable', 'true');
  const thumbs = docImportState.thumbnails;
  els.docResultsInfo.textContent = `${thumbs.length} page${thumbs.length === 1 ? '' : 's'} found`;

  if (thumbs.length > 0 && (docImportState.activeIndex < 0 || docImportState.activeIndex >= thumbs.length)) {
    docImportState.activeIndex = 0;
  }

  thumbs.forEach((thumb, idx) => {
    const item = document.createElement('div');
    item.className = 'doc-thumb-item'
      + (docImportState.selected.has(idx) ? ' selected' : '')
      + (docImportState.activeIndex === idx ? ' active' : '');
    item.setAttribute('role', 'option');
    item.tabIndex = 0;
    item.setAttribute('aria-selected', docImportState.selected.has(idx) ? 'true' : 'false');
    item.setAttribute('aria-label', `${thumb.label}${docImportState.selected.has(idx) ? ', selected' : ', not selected'}`);

    const img = document.createElement('img');
    img.className = 'doc-thumb-img';
    img.src = thumb.dataUrl;
    img.alt = thumb.label;
    img.loading = 'lazy';
    item.appendChild(img);

    const check = document.createElement('div');
    check.className = 'doc-thumb-check';
    check.innerHTML = docImportState.selected.has(idx) ? '✓' : '';
    item.appendChild(check);

    const label = document.createElement('div');
    label.className = 'doc-thumb-label';
    label.textContent = thumb.label;
    item.appendChild(label);

    const toggle = () => {
      docImportState.activeIndex = idx;
      if (docImportState.selected.has(idx)) {
        docImportState.selected.delete(idx);
        item.classList.remove('selected');
        check.innerHTML = '';
        item.setAttribute('aria-selected', 'false');
        item.setAttribute('aria-label', `${thumb.label}, not selected`);
      } else {
        docImportState.selected.add(idx);
        item.classList.add('selected');
        check.innerHTML = '✓';
        item.setAttribute('aria-selected', 'true');
        item.setAttribute('aria-label', `${thumb.label}, selected`);
      }
      updateDocSelectionCount();
      renderDocThumbnails();
    };

    check.addEventListener('click', e => {
      e.stopPropagation();
      toggle();
    });
    item.addEventListener('click', () => {
      if (docImportState.activeIndex === idx) return;
      docImportState.activeIndex = idx;
      renderDocThumbnails();
    });
    item.addEventListener('dblclick', () => {
      docImportState.activeIndex = idx;
      openDocLightbox(idx);
    });
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        docImportState.activeIndex = idx;
        openDocLightbox(idx);
      }
    });

    els.docThumbGrid.appendChild(item);
  });

  updateDocSelectionCount();
  renderDocPreviewPanel();
}

function parsePageRange(str, max) {
  const indices = new Set();
  const parts = str.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10) - 1;
      if (n >= 0 && n < max) indices.add(n);
    } else if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split('-').map(Number);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        const n = i - 1;
        if (n >= 0 && n < max) indices.add(n);
      }
    }
  }
  return indices;
}

async function processDocFile(file) {
  if (file.size > 50 * 1024 * 1024) {
    showToast('Large document detected. Parsing may take longer.');
  }

  const importer = window.__docImporter;
  if (!importer) {
    showToast('Document importer not available. Make sure the page is served via HTTP (not file://).');
    return;
  }

  // Check for INDD upfront
  if (file.name.toLowerCase().endsWith('.indd')) {
    showToast('InDesign (.indd) files cannot be processed in the browser. Export your InDesign file as PDF first, then import.');
    return;
  }

  // Show progress
  showDocImportStep('upload');
  els.docImportDropZone.hidden = true;
  els.docImportProgress.hidden = false;
  els.docImportSubtitle.textContent = `Step 1 of 2 · Processing ${file.name}`;
  setDocProgress(0, 1, 'Loading libraries…');

  docImportState.abortController = new AbortController();

  try {
    const thumbs = await importer.extractDocumentThumbnails(file, {
      signal: docImportState.abortController.signal,
      onProgress: ({ current, total, label }) => setDocProgress(current, total, label),
    });

    if (docImportState.abortController.signal.aborted) return;

    docImportState.thumbnails = thumbs;
    docImportState.selected = new Set(thumbs.map((_, i) => i)); // all selected by default
    docImportState.activeIndex = thumbs.length > 0 ? 0 : -1;

    els.docImportProgress.hidden = true;
    showDocImportStep('explorer');
    els.docImportBackBtn.hidden = false;
    els.docImportSubtitle.textContent = `Step 2 of 2 · Explore and select pages from ${file.name}`;

    renderDocThumbnails();

  } catch (err) {
    els.docImportProgress.hidden = true;
    els.docImportDropZone.hidden = false;

    if (err.code === 'INDD_UNSUPPORTED') {
      showToast('InDesign (.indd) files require export as PDF. Open in InDesign → File → Export → Adobe PDF, then import the PDF here.');
    } else if (err.code === 'CFB_UNSUPPORTED') {
      showToast(err.message);
    } else if (err.message?.includes('CDN') || err.message?.includes('Failed to load')) {
      showToast('Could not load parsing library. Check your internet connection and try again.');
    } else {
      showToast(`Could not parse document: ${err.message}`);
    }
    console.error('[doc-importer]', err);
  }
}

async function confirmDocImport() {
  const indices = Array.from(docImportState.selected).sort((a, b) => a - b);
  if (indices.length === 0) {
    showToast('No pages selected');
    return;
  }

  const selected = indices.map(i => docImportState.thumbnails[i]);
  closeDocImportModal();

  // Convert dataUrls to File-like objects (Blob + name) for the standard pipeline
  const fileObjects = await Promise.all(selected.map(async (thumb, i) => {
    const resp = await fetch(thumb.dataUrl);
    const blob = await resp.blob();
    return new File([blob], `${thumb.label.replace(/[^a-z0-9]/gi, '_')}.png`, { type: 'image/png' });
  }));

  await addFiles(fileObjects);
}

function bindDocImportEvents() {
  if (!els.importDocBtn) return;

  els.importDocBtn.addEventListener('click', () => {
    closeTopMenus();
    openDocImportModal();
  });

  els.docImportCloseBtn.addEventListener('click', closeDocImportModal);

  els.docImportModal.addEventListener('click', event => {
    if (event.target === els.docImportModal) closeDocImportModal();
  });

  // Drop zone click
  els.docImportDropZone.addEventListener('click', () => els.docFileInput?.click());
  els.docImportDropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.docFileInput?.click(); }
  });

  // File input
  if (els.docFileInput) {
    els.docFileInput.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (file) await processDocFile(file);
      e.target.value = '';
    });
  }

  // Drag-over drop zone
  els.docImportDropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    els.docImportDropZone.classList.add('drag-over');
  });
  els.docImportDropZone.addEventListener('dragleave', e => {
    e.stopPropagation();
    els.docImportDropZone.classList.remove('drag-over');
  });
  els.docImportDropZone.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    els.docImportDropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) await processDocFile(file);
  });

  els.docPreviewStage?.addEventListener('dblclick', () => {
    if (docImportState.activeIndex >= 0) {
      openDocLightbox(docImportState.activeIndex);
    }
  });

  els.docPreviewStage?.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && docImportState.activeIndex >= 0) {
      e.preventDefault();
      openDocLightbox(docImportState.activeIndex);
    }
  });

  els.docPreviewOpenBtn?.addEventListener('click', () => {
    if (docImportState.activeIndex >= 0) {
      openDocLightbox(docImportState.activeIndex);
    }
  });

  els.docLightboxCloseBtn?.addEventListener('click', closeDocLightbox);
  els.docLightboxPrevBtn?.addEventListener('click', () => stepDocLightbox(-1));
  els.docLightboxNextBtn?.addEventListener('click', () => stepDocLightbox(1));
  els.docLightboxZoomOutBtn?.addEventListener('click', () => zoomLightbox(-0.1));
  els.docLightboxZoomInBtn?.addEventListener('click', () => zoomLightbox(0.1));
  els.docLightboxFitBtn?.addEventListener('click', resetLightboxZoom);
  els.docLightboxResetBtn?.addEventListener('click', resetLightboxZoom);

  els.docLightboxModal?.addEventListener('click', event => {
    if (event.target === els.docLightboxModal) {
      closeDocLightbox();
    }
  });

  document.addEventListener('keydown', event => {
    if (!els.docLightboxModal?.classList.contains('show')) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepDocLightbox(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepDocLightbox(1);
    }
  });

  // Cancel extraction
  els.docImportCancelBtn.addEventListener('click', () => {
    docImportState.abortController?.abort();
    resetDocImportToDropZone();
    showToast('Extraction cancelled');
  });

  // Select / deselect all
  els.docSelectAllBtn.addEventListener('click', () => {
    docImportState.selected = new Set(docImportState.thumbnails.map((_, i) => i));
    renderDocThumbnails();
  });

  els.docDeselectAllBtn.addEventListener('click', () => {
    docImportState.selected.clear();
    renderDocThumbnails();
  });

  // Range apply
  els.docRangeApplyBtn.addEventListener('click', () => {
    const raw = els.docRangeInput?.value || '';
    if (!raw.trim()) return;
    const indices = parsePageRange(raw, docImportState.thumbnails.length);
    docImportState.selected = indices;
    renderDocThumbnails();
    els.docRangeInput.value = '';
  });

  // Back button
  els.docImportBackBtn.addEventListener('click', resetDocImportToDropZone);

  // Confirm import
  els.docImportConfirmBtn.addEventListener('click', confirmDocImport);
}

// ─── Zoom/Pan for Lightbox ────────────────────────────────────────
const lightboxZoomState = {
  zoom: 1,
  panX: 0,
  panY: 0,
};

function updateLightboxTransform() {
  if (!els.docLightboxImage) return;
  els.docLightboxImage.style.transform = `translate(${lightboxZoomState.panX}px, ${lightboxZoomState.panY}px) scale(${lightboxZoomState.zoom})`;
  if (els.docLightboxZoomLabel) {
    els.docLightboxZoomLabel.textContent = `${Math.round(lightboxZoomState.zoom * 100)}%`;
  }
}

function zoomLightbox(delta) {
  lightboxZoomState.zoom = Math.max(0.1, Math.min(5, lightboxZoomState.zoom + delta));
  updateLightboxTransform();
}

function resetLightboxZoom() {
  lightboxZoomState.zoom = 1;
  lightboxZoomState.panX = 0;
  lightboxZoomState.panY = 0;
  updateLightboxTransform();
}

function openDocLightboxWithZoomReset(startIndex) {
  lightboxZoomState.zoom = 1;
  lightboxZoomState.panX = 0;
  lightboxZoomState.panY = 0;
  openDocLightbox(startIndex);
  setTimeout(updateLightboxTransform, 50);
}

// ─── Zoom/Pan for Preview Modal ─────────────────────────────────
const previewZoomState = {
  zoom: 1,
  panX: 0,
  panY: 0,
};

function updatePreviewTransform() {
  if (!els.previewModalImage) return;
  els.previewModalImage.style.transform = `translate(${previewZoomState.panX}px, ${previewZoomState.panY}px) scale(${previewZoomState.zoom})`;
  if (els.previewZoomLabel) {
    els.previewZoomLabel.textContent = `${Math.round(previewZoomState.zoom * 100)}%`;
  }
}

function zoomPreview(delta) {
  previewZoomState.zoom = Math.max(0.1, Math.min(5, previewZoomState.zoom + delta));
  updatePreviewTransform();
}

function resetPreviewZoom() {
  previewZoomState.zoom = 1;
  previewZoomState.panX = 0;
  previewZoomState.panY = 0;
  updatePreviewTransform();
}

// ─── Lightbox Interactive Canvas ────────────────────────────────────
function setupLightboxCanvasInteractions() {
  if (!els.docLightboxContainer || !els.docLightboxImage) return;

  const panState = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false
  };

  els.docLightboxContainer.addEventListener('wheel', e => {
    if (!els.docLightboxModal?.classList.contains('show')) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    zoomLightbox(delta);
  }, { passive: false });

  els.docLightboxContainer.addEventListener('pointerdown', e => {
    if (!els.docLightboxModal?.classList.contains('show')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    panState.active = true;
    panState.pointerId = e.pointerId;
    panState.startX = e.clientX;
    panState.startY = e.clientY;
    panState.startPanX = lightboxZoomState.panX;
    panState.startPanY = lightboxZoomState.panY;
    panState.moved = false;
    els.docLightboxContainer.classList.add('grabbing');
    els.docLightboxContainer.setPointerCapture(e.pointerId);
  });

  els.docLightboxContainer.addEventListener('pointermove', e => {
    if (!panState.active || panState.pointerId !== e.pointerId) return;
    const deltaX = e.clientX - panState.startX;
    const deltaY = e.clientY - panState.startY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      panState.moved = true;
    }
    lightboxZoomState.panX = panState.startPanX + deltaX;
    lightboxZoomState.panY = panState.startPanY + deltaY;
    updateLightboxTransform();
  });

  const endPan = e => {
    if (!panState.active || panState.pointerId !== e.pointerId) return;
    panState.active = false;
    panState.pointerId = null;
    els.docLightboxContainer.classList.remove('grabbing');
  };

  els.docLightboxContainer.addEventListener('pointerup', endPan);
  els.docLightboxContainer.addEventListener('pointercancel', endPan);

  els.docLightboxContainer.addEventListener('click', e => {
    if (panState.moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  els.docLightboxContainer.style.touchAction = 'none';
  els.docLightboxImage.style.userSelect = 'none';
  els.docLightboxImage.addEventListener('dragstart', e => e.preventDefault());
}

// ─── Preview Modal Interactive Canvas ────────────────────────────────
function setupPreviewCanvasInteractions() {
  if (!els.previewImageContainer || !els.previewModalImage) return;

  const panState = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false
  };

  els.previewImageContainer.addEventListener('wheel', e => {
    if (!els.previewModal?.classList.contains('show')) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    zoomPreview(delta);
  }, { passive: false });

  els.previewImageContainer.addEventListener('pointerdown', e => {
    if (!els.previewModal?.classList.contains('show')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    panState.active = true;
    panState.pointerId = e.pointerId;
    panState.startX = e.clientX;
    panState.startY = e.clientY;
    panState.startPanX = previewZoomState.panX;
    panState.startPanY = previewZoomState.panY;
    panState.moved = false;
    els.previewImageContainer.classList.add('grabbing');
    els.previewImageContainer.setPointerCapture(e.pointerId);
  });

  els.previewImageContainer.addEventListener('pointermove', e => {
    if (!panState.active || panState.pointerId !== e.pointerId) return;
    const deltaX = e.clientX - panState.startX;
    const deltaY = e.clientY - panState.startY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      panState.moved = true;
    }
    previewZoomState.panX = panState.startPanX + deltaX;
    previewZoomState.panY = panState.startPanY + deltaY;
    updatePreviewTransform();
  });

  const endPan = e => {
    if (!panState.active || panState.pointerId !== e.pointerId) return;
    panState.active = false;
    panState.pointerId = null;
    els.previewImageContainer.classList.remove('grabbing');
  };

  els.previewImageContainer.addEventListener('pointerup', endPan);
  els.previewImageContainer.addEventListener('pointercancel', endPan);

  els.previewImageContainer.addEventListener('click', e => {
    if (panState.moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  els.previewImageContainer.style.touchAction = 'none';
  els.previewModalImage.style.userSelect = 'none';
  els.previewModalImage.addEventListener('dragstart', e => e.preventDefault());

  // Click to open fullscreen lightbox (for document page previews)
  els.docPreviewImage?.addEventListener('click', () => {
    if (els.docPreviewImage.hidden) return;
    openDocLightboxWithZoomReset(docImportState.activeIndex);
  });
}

// ─── End document import feature ─────────────────────────────────────────────

function bindEvents() {
  els.toggleControlsBtn.addEventListener('click', event => {
    event.preventDefault();
    setControlsOpen(!state.controlsOpen);
  });

  els.revealControlsBtn.addEventListener('click', event => {
    event.preventDefault();
    setControlsOpen(!state.controlsOpen);
  });

  els.importMenuBtn.addEventListener('click', event => {
    event.preventDefault();
    toggleMenu(els.importMenu, els.importMenuBtn);
  });

  els.exportMenuBtn.addEventListener('click', event => {
    event.preventDefault();
    toggleMenu(els.exportMenu, els.exportMenuBtn);
  });

  els.importFolderBtn.addEventListener('click', () => {
    closeTopMenus();
    if (els.folderInput) {
      els.folderInput.click();
    } else {
      showToast('Folder import control is unavailable in this layout');
    }
  });

  els.importFilesBtn.addEventListener('click', () => {
    closeTopMenus();
    if (els.filesInput) {
      els.filesInput.click();
    } else {
      showToast('File import control is unavailable in this layout');
    }
  });

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionContainer = target.closest('.cell-actions');
    if (actionContainer instanceof HTMLElement) {
      closeCellActionMenus(actionContainer);
      return;
    }
    closeCellActionMenus();
    if (target.closest('.menu-wrap')) return;
    closeTopMenus();

    if (target.closest('.grid-cell') || target.closest('.holding-tile')) {
      return;
    }
    clearGridSelection();
  });

  els.gapControlsContainer?.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[data-gap-index]');
    if (!button) return;

    const gapIndex = Number(button.dataset.gapIndex);
    if (!Number.isInteger(gapIndex) || gapIndex < 0 || gapIndex >= state.columnGaps.length) return;
    const wasLinked = getGapAfterColumn(gapIndex) === 0;
    pushHistory(`${wasLinked ? 'Unlink' : 'Link'} columns ${gapIndex + 1}-${gapIndex + 2}`);
    state.columnGaps[gapIndex] = wasLinked ? state.globalGapX : 0;
    renderAll();
  });

  window.addEventListener('paste', async event => {
    if (state.selectedSlotIndex == null) return;
    if (isEditableElement(event.target)) return;
    event.preventDefault();
    await handlePaste(state.selectedSlotIndex, event);
  });

  document.addEventListener('keydown', event => {
    if (handleOpenModalKeydown(event)) {
      return;
    }

    if (isEditableElement(event.target)) {
      return;
    }

    // Undo/Redo shortcuts
    if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
      if (event.shiftKey) {
        event.preventDefault();
        redo();
      } else {
        event.preventDefault();
        undo();
      }
      return;
    }
    
    // Alternative redo shortcut (Ctrl+Y)
    if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    
    if (event.key === 'Escape') {
      closeCellActionMenus();
      closeTopMenus();
    }
  });

  if (els.folderInput) {
    els.folderInput.addEventListener('change', async event => {
      await addFiles(event.target.files || []);
      els.folderInput.value = '';
    });
  }

  if (els.filesInput) {
    els.filesInput.addEventListener('change', async event => {
      await addFiles(event.target.files || []);
      els.filesInput.value = '';
    });
  }

  [els.rowsInput, els.colsInput, els.gapXInput, els.gapYInput, els.cellWidthInput, els.cellHeightInput].forEach(control => {
    if (!control) return;
    control.addEventListener('change', applyNumberSettings);
  });

  els.importReplaceBtn.addEventListener('click', () => {
    const files = state.pendingImportFiles || [];
    closeImportModeModal();
    openReplaceOptionsModal(files);
  });

  els.replaceOffsetSelect?.addEventListener('change', () => {
    updateReplaceOptionsSummary();
  });

  els.replaceSizingSelect?.addEventListener('change', () => {
    populateReplaceOffsetOptions();
    updateReplaceOptionsSummary();
  });

  els.replaceRowsSelect?.addEventListener('change', () => {
    if (els.replaceSizingSelect && els.replaceSizingSelect.value !== 'custom') {
      els.replaceSizingSelect.value = 'custom';
    }
    updateReplaceOptionsSummary();
  });

  els.replaceColsSelect?.addEventListener('change', () => {
    if (els.replaceSizingSelect && els.replaceSizingSelect.value !== 'custom') {
      els.replaceSizingSelect.value = 'custom';
    }
    populateReplaceOffsetOptions();
    updateReplaceOptionsSummary();
  });

  els.replaceCancelBtn?.addEventListener('click', () => {
    closeReplaceOptionsModal();
    state.pendingReplaceFiles = null;
    state.pendingImportFiles = null;
    showToast('Replace cancelled');
  });

  els.replaceApplyBtn?.addEventListener('click', async () => {
    const files = state.pendingReplaceFiles || [];
    const startCol = Math.max(1, Number(els.replaceOffsetSelect?.value) || 1);
    const firstRowOffset = startCol - 1;
    const replaceSizing = els.replaceSizingSelect?.value || 'recommended';
    const customRows = Math.max(1, Number(els.replaceRowsSelect?.value) || state.rows);
    const customCols = Math.max(1, Number(els.replaceColsSelect?.value) || state.cols);
    closeReplaceOptionsModal();
    state.pendingReplaceFiles = null;
    state.pendingImportFiles = null;
    await executeImportMode(files, 'replace', state.selectedSlotIndex, { firstRowOffset, replaceSizing, customRows, customCols });
  });

  els.importFillBtn.addEventListener('click', async () => {
    const files = state.pendingImportFiles || [];
    closeImportModeModal();
    state.pendingImportFiles = null;
    await executeImportMode(files, 'fill');
  });

  els.importAppendStartBtn.addEventListener('click', async () => {
    const files = state.pendingImportFiles || [];
    closeImportModeModal();
    state.pendingImportFiles = null;
    await executeImportMode(files, 'append-start');
  });

  els.importAppendEndBtn?.addEventListener('click', async () => {
    const files = state.pendingImportFiles || [];
    closeImportModeModal();
    state.pendingImportFiles = null;
    await executeImportMode(files, 'append-end');
  });

  els.importAppendSelectedBtn.addEventListener('click', () => {
    const files = state.pendingImportFiles || [];
    if (files.length === 0) {
      closeImportModeModal();
      return;
    }
    closeImportModeModal();
    state.pendingImportFiles = files;
    state.awaitingAppendSelection = true;
    showToast('Select a slot on the canvas to append at that position');
  });

  els.importTrayBtn?.addEventListener('click', async () => {
    const files = state.pendingImportFiles || [];
    closeImportModeModal();
    state.pendingImportFiles = null;
    await executeImportMode(files, 'tray');
  });

  els.replaceOptionsModal?.addEventListener('click', event => {
    if (event.target === els.replaceOptionsModal) {
      closeReplaceOptionsModal();
      state.pendingReplaceFiles = null;
      state.pendingImportFiles = null;
      showToast('Replace cancelled');
    }
  });

  els.clearTrayBtn?.addEventListener('click', () => {
    clearHoldingTray();
  });

  els.rowsUpBtn.addEventListener('click', () => {
    pushHistory(`Increase rows to ${state.rows + 1}`);
    // Math.max, not clamp to GRID_LIMIT: GRID_LIMIT is only a UI-stepper
    // constant, not a real cap, and clamping the absolute next value used to
    // shrink any grid already larger than 20 rows down to 20 on a single +
    // click.
    resizeGridPreserve(Math.max(1, state.rows + 1), state.cols);
    renderAll();
  });

  els.rowsDownBtn.addEventListener('click', () => {
    if (state.rows <= 1) return;
    if (state.shrinkMode === 'reflow') {
      reflowShrinkRows();
    } else {
      removeRowAt(state.rows - 1);
    }
  });

  els.colsUpBtn.addEventListener('click', () => {
    pushHistory(`Increase columns to ${state.cols + 1}`);
    // See rowsUpBtn above: GRID_LIMIT must never clamp an already-larger grid.
    resizeGridPreserve(state.rows, Math.max(1, state.cols + 1));
    renderAll();
  });

  els.colsDownBtn.addEventListener('click', () => {
    if (state.cols <= 1) return;
    if (state.shrinkMode === 'reflow') {
      reflowShrinkCols();
    } else {
      removeColumnAt(state.cols - 1);
    }
  });

  els.shrinkModeSelect?.addEventListener('change', () => {
    state.shrinkMode = els.shrinkModeSelect.value === 'reflow' ? 'reflow' : 'trim';
    saveShrinkMode(state.shrinkMode);
  });

  els.autoPackBtn.addEventListener('click', () => {
    pushHistory('Auto pack grid');
    autoPackGrid();
  });
  
  els.shuffleBtn.addEventListener('click', () => {
    pushHistory('Shuffle layout');
    shuffleGrid();
  });
  
  els.clearGridBtn.addEventListener('click', () => {
    clearGrid();
  });

  els.importModeModal?.addEventListener('click', event => {
    if (event.target === els.importModeModal) {
      closeImportModeModal();
      state.pendingImportFiles = null;
      state.awaitingAppendSelection = false;
      showToast('Import cancelled');
    }
  });

  els.overflowModal?.addEventListener('click', event => {
    if (event.target === els.overflowModal) {
      closeOverflowModal();
      state.pendingGridSequence = null;
      state.pendingGridIsLayout = false;
      state.pendingGridPlacementOffset = 0;
      showToast('Resize cancelled');
    }
  });

  els.toggleTrayBtn.addEventListener('click', () => {
    if (els.imageTrayPanel) {
      els.imageTrayPanel.classList.toggle('collapsed');
      const isCollapsed = els.imageTrayPanel.classList.contains('collapsed');
      els.toggleTrayBtn.setAttribute('aria-expanded', !isCollapsed);
    }
  });

  // Wire slider labels for dynamic feedback and state changes
  [
    { input: 'gapXInput', label: 'gapXLabel', stateKey: 'gapX' },
    { input: 'gapYInput', label: 'gapYLabel', stateKey: 'gapY' },
    { input: 'cellWidthInput', label: 'cellWidthLabel', stateKey: 'cellWidth' },
    { input: 'cellHeightInput', label: 'cellHeightLabel', stateKey: 'cellHeight' }
  ].forEach(({ input, label, stateKey }) => {
    const el = document.getElementById(input);
    if (el) {
      let changeTimeout;
      el.addEventListener('input', () => {
        updateSizeLabel(input, label);
        // Update state immediately for visual feedback
        if (stateKey === 'gapX') {
          state.globalGapX = Number(el.value);
          state.gapX = state.globalGapX;
          state.columnGaps = state.columnGaps.map(gap => (gap === 0 ? 0 : state.globalGapX));
          normalizeColumnGaps();
        } else {
          state[stateKey] = Number(el.value);
        }
        renderAll();
        // Debounce history push to avoid too many entries while dragging slider
        clearTimeout(changeTimeout);
        changeTimeout = setTimeout(() => {
          const labelKey = stateKey === 'gapX' ? 'globalGapX' : stateKey;
          pushHistory(`Change ${labelKey} to ${el.value}`);
        }, 500);
      });
      updateSizeLabel(input, label);
    }
  });

  els.copyPngBtn.addEventListener('click', async () => {
    closeTopMenus();
    try {
      await copyPreviewPng();
    } catch {
      showToast('Clipboard blocked by browser settings');
    }
  });

  els.copyLucidBtn.addEventListener('click', async () => {
    closeTopMenus();
    try {
      await copyLucidchartAsset();
    } catch {
      showToast('Clipboard blocked by browser settings');
    }
  });

  els.downloadPngBtn.addEventListener('click', async () => {
    closeTopMenus();
    try {
      await downloadPreviewPng();
    } catch {
      showToast('Failed to download preview PNG');
    }
  });

  // ── Send to Lucid ───────────────────────────────────────────────────────
  els.sendToLucidBtn?.addEventListener('click', async () => {
    closeTopMenus();
    const { loadLucidSettings } = window.__lucidExport || {};
    if (!loadLucidSettings) {
      showToast('Lucid export module not loaded yet — try again in a moment.');
      return;
    }
    const settings = loadLucidSettings();
    if (!settings.apiKey) {
      showToast('Set your Lucid API key first (Export ▾ → Lucid API settings…)');
      return;
    }
    const activeCount = state.grid.filter(Boolean).length;
    if (activeCount === 0) {
      showToast('Grid is empty — add images before sending to Lucid.');
      return;
    }
    openLucidSendModal();
  });

  // ── Send to Lucid modal ─────────────────────────────────────────────────────
  let lucidSendSelectedDoc = null; // { documentId, title, parent, editUrl }
  let lucidSearchDebounce = null;

  function openLucidSendModal() {
    const { loadLucidSettings } = window.__lucidExport || {};
    const settings = loadLucidSettings ? loadLucidSettings() : {};
    lucidSendSelectedDoc = null;

    if (els.lucidSendTitleInput) {
      els.lucidSendTitleInput.value = settings.title || 'PNG Grid Export';
    }
    if (els.lucidDocSearchInput) els.lucidDocSearchInput.value = '';
    if (els.lucidDocResults) { els.lucidDocResults.hidden = true; els.lucidDocResults.innerHTML = ''; }
    if (els.lucidDocSelection) els.lucidDocSelection.hidden = true;
    updateSendFolderNote();

    openModal(els.lucidSendModal, { focusTarget: els.lucidSendTitleInput });
  }

  function closeLucidSendModal() {
    closeModal(els.lucidSendModal);
  }

  function updateSendFolderNote() {
    if (!els.lucidSendFolderNote) return;
    if (lucidSendSelectedDoc) {
      els.lucidSendFolderNote.innerHTML =
        `A new document will be created in the same folder as <strong>${escapeHtml(lucidSendSelectedDoc.title)}</strong>.`;
    } else {
      els.lucidSendFolderNote.innerHTML = 'A new document will be created in <strong>My Documents</strong>.';
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderDocResults(docs) {
    if (!els.lucidDocResults) return;
    els.lucidDocResults.setAttribute('role', 'list');
    if (!docs.length) {
      els.lucidDocResults.innerHTML = '<p class="hint" style="padding:8px 10px;margin:0">No documents found.</p>';
      els.lucidDocResults.hidden = false;
      return;
    }
    els.lucidDocResults.innerHTML = docs.map(doc => {
      const date = doc.lastModified ? new Date(doc.lastModified).toLocaleDateString() : '';
      return `<button class="lucid-doc-result-item" type="button"
                   data-doc-id="${escapeHtml(doc.documentId)}"
                   data-doc-title="${escapeHtml(doc.title)}"
                   data-doc-parent="${doc.parent ?? ''}"
                   data-doc-edit="${escapeHtml(doc.editUrl || '')}">
                <span class="doc-result-title">${escapeHtml(doc.title)}</span>
                <span class="doc-result-meta">${escapeHtml(doc.product || '')}${date ? ' · ' + date : ''}</span>
              </button>`;
    }).join('');
    els.lucidDocResults.hidden = false;
  }

  async function runDocSearch() {
    const { searchLucidDocs, loadLucidSettings } = window.__lucidExport || {};
    if (!searchLucidDocs) return;
    const settings = loadLucidSettings ? loadLucidSettings() : {};
    if (!settings.apiKey) return;
    const keywords = els.lucidDocSearchInput?.value.trim() || '';
    const product = settings.product || 'lucidchart';

    if (els.lucidDocResults) {
      els.lucidDocResults.innerHTML = '<p class="hint" style="padding:8px 10px;margin:0">Searching…</p>';
      els.lucidDocResults.hidden = false;
    }
    try {
      const docs = await searchLucidDocs(settings.apiKey, keywords, product);
      renderDocResults(docs);
    } catch (err) {
      if (els.lucidDocResults) {
        els.lucidDocResults.innerHTML = `<p class="hint" style="padding:8px 10px;margin:0;color:#f87171">Error: ${escapeHtml(err.message)}</p>`;
      }
    }
  }

  els.lucidSendModal?.addEventListener('click', e => {
    if (e.target === els.lucidSendModal) closeLucidSendModal();
  });
  els.lucidSendCancelBtn?.addEventListener('click', closeLucidSendModal);

  els.lucidDocSearchInput?.addEventListener('input', () => {
    clearTimeout(lucidSearchDebounce);
    lucidSearchDebounce = setTimeout(runDocSearch, 400);
  });

  els.lucidDocSearchBtn?.addEventListener('click', () => {
    clearTimeout(lucidSearchDebounce);
    runDocSearch();
  });

  els.lucidDocSearchInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(lucidSearchDebounce); runDocSearch(); }
  });

  els.lucidDocResults?.addEventListener('click', e => {
    const item = e.target.closest('.lucid-doc-result-item');
    if (!item) return;
    lucidSendSelectedDoc = {
      documentId: item.dataset.docId,
      title: item.dataset.docTitle,
      parent: item.dataset.docParent || null,
      editUrl: item.dataset.docEdit
    };
    if (els.lucidDocSelectionLabel) {
      els.lucidDocSelectionLabel.textContent = `Folder of: ${lucidSendSelectedDoc.title}`;
    }
    els.lucidDocResults.hidden = true;
    els.lucidDocSelection.hidden = false;
    updateSendFolderNote();
  });

  els.lucidDocClearBtn?.addEventListener('click', () => {
    lucidSendSelectedDoc = null;
    els.lucidDocSelection.hidden = true;
    els.lucidDocResults.hidden = true;
    els.lucidDocResults.innerHTML = '';
    if (els.lucidDocSearchInput) els.lucidDocSearchInput.value = '';
    updateSendFolderNote();
  });

  els.lucidSendConfirmBtn?.addEventListener('click', async () => {
    const { sendGridToLucid, loadLucidSettings, getLucidDoc } = window.__lucidExport || {};
    if (!sendGridToLucid) return;
    const settings = loadLucidSettings ? loadLucidSettings() : {};
    const title = els.lucidSendTitleInput?.value.trim() || settings.title || 'PNG Grid Export';

    // Resolve parent folder: if user selected a doc, use that doc's parent folder
    let parentFolderId = null;
    if (lucidSendSelectedDoc) {
      if (lucidSendSelectedDoc.parent) {
        parentFolderId = lucidSendSelectedDoc.parent;
      } else if (getLucidDoc) {
        // parent wasn't in search results — fetch it now
        try {
          const doc = await getLucidDoc(settings.apiKey, lucidSendSelectedDoc.documentId);
          parentFolderId = doc.parent ?? null;
        } catch { /* fall through to My Documents */ }
      }
    }

    els.lucidSendConfirmBtn.disabled = true;
    const originalLabel = els.lucidSendConfirmBtn.textContent;
    const setLabel = (() => {
      let lastAt = 0;
      let lastMessage = '';
      return t => {
        if (els.lucidSendConfirmBtn) els.lucidSendConfirmBtn.textContent = t;
        const now = Date.now();
        if (t !== lastMessage || now - lastAt > 450) {
          showToast(t, 1400);
          lastMessage = t;
          lastAt = now;
        }
      };
    })();

    try {
      setLabel('Preparing images…');
      // sendGridToLucid (js/lucid-export.js) expects each asset to carry its
      // full-resolution `dataUrl` \u2014 pull those back out of IndexedDB just
      // for the assets actually used in the grid, right before sending.
      const usedAssetIds = [...new Set(state.grid.filter(Boolean))];
      const fullResUrls = await getFullResDataUrls(usedAssetIds);
      const assetsForExport = state.assets.map(asset => ({
        ...asset,
        dataUrl: fullResUrls.get(asset.id) || asset.thumbUrl
      }));

      const result = await sendGridToLucid(
        {
          grid: state.grid,
          rows: state.rows,
          cols: state.cols,
          cellWidth: state.cellWidth,
          cellHeight: state.cellHeight,
          gapX: state.globalGapX,
          columnGaps: state.columnGaps.slice(),
          gapY: state.gapY,
          assets: assetsForExport
        },
        {
          apiKey: settings.apiKey,
          title,
          product: settings.product || 'lucidchart',
          parentFolderId,
          imageScale: clamp(Number(settings.imageScale) || 100, 25, 400) / 100,
          imagePixelScale: clamp(Number(settings.imagePixelScale) || 100, 25, 200),
          labelTextSize: clamp(Number(settings.labelTextSize) || 14, 8, 72),
          compressImages: settings.compressImages !== false,
          mergeLinkedSpreads: settings.mergeLinkedSpreads !== false,
          includeOutline: settings.includeOutline !== false,
          includePageLabels: settings.includePageLabels === true,
          compressionLevel: settings.compressionLevel || 'balanced',
          compressionFormat: settings.compressionFormat || 'auto',
          customQuality: settings.customQuality,
          customMaxDimension: settings.customMaxDimension
        },
        setLabel
      );
      closeLucidSendModal();
      addExportLogEntry(result);
      showToast(`Sent! Opening in Lucid… (see 📤 Exports for the link)`);
      window.open(result.editUrl, '_blank', 'noopener');
    } catch (err) {
      showToast(`Lucid error: ${err.message}`, 12000);
      console.error('[send-to-lucid]', err);
    } finally {
      els.lucidSendConfirmBtn.disabled = false;
      els.lucidSendConfirmBtn.textContent = originalLabel;
    }
  });

  // ── Lucid settings modal ─────────────────────────────────────────────────
  function updateCustomCompressionVisibility() {
    const isCustom = els.lucidCompressionLevelSelect?.value === 'custom';
    if (els.lucidCustomCompressionFields) els.lucidCustomCompressionFields.style.display = isCustom ? '' : 'none';
  }

  els.lucidCompressionLevelSelect?.addEventListener('change', updateCustomCompressionVisibility);

  function normalizeNumericInput(el, min, max, fallback, step = null) {
    if (!el) return fallback;
    let value = clamp(Number(el.value) || fallback, min, max);
    if (Number.isFinite(step) && step > 0) {
      value = Math.round(value / step) * step;
      value = clamp(value, min, max);
    }
    el.value = String(value);
    return value;
  }

  // UI scale is a display preference, not a Lucid export setting — apply and
  // persist it immediately as the numeric value changes, independent of the
  // modal's Save/Cancel buttons (which only govern Lucid API settings).
  const applyUiScaleInput = () => {
    const pct = normalizeNumericInput(els.uiScaleInput, UI_SCALE_MIN * 100, UI_SCALE_MAX * 100, UI_SCALE_DEFAULT * 100, 5);
    state.uiScalePreference = pct / 100;
    saveUiScalePreference(state.uiScalePreference);
    updateViewportLayout();
  };
  els.uiScaleInput?.addEventListener('input', applyUiScaleInput);
  els.uiScaleInput?.addEventListener('change', applyUiScaleInput);

  function openLucidSettings() {
    closeTopMenus();
    const { loadLucidSettings } = window.__lucidExport || {};
    const settings = loadLucidSettings ? loadLucidSettings() : {};
    const uiScalePct = Math.round(state.uiScalePreference * 100);
    if (els.uiScaleInput) els.uiScaleInput.value = uiScalePct;
    if (els.lucidApiKeyInput) els.lucidApiKeyInput.value = settings.apiKey || '';
    if (els.lucidDocTitleInput) els.lucidDocTitleInput.value = settings.title || '';
    if (els.lucidProductSelect) els.lucidProductSelect.value = settings.product || 'lucidchart';
    const imageScalePct = clamp(Number(settings.imageScale) || 100, 25, 400);
    if (els.lucidImageScaleInput) els.lucidImageScaleInput.value = imageScalePct;
    const imagePixelScalePct = clamp(Number(settings.imagePixelScale) || 100, 25, 200);
    if (els.lucidImagePixelScaleInput) els.lucidImagePixelScaleInput.value = imagePixelScalePct;
    const lucidLabelTextSize = clamp(Number(settings.labelTextSize) || 14, 8, 72);
    if (els.lucidLabelTextSizeInput) els.lucidLabelTextSizeInput.value = lucidLabelTextSize;
    if (els.lucidCompressImagesInput) els.lucidCompressImagesInput.checked = settings.compressImages !== false;
    if (els.lucidMergeSpreadsInput) els.lucidMergeSpreadsInput.checked = settings.mergeLinkedSpreads !== false;
    if (els.lucidIncludeOutlineInput) els.lucidIncludeOutlineInput.checked = settings.includeOutline !== false;
    if (els.lucidIncludePageLabelsInput) els.lucidIncludePageLabelsInput.checked = settings.includePageLabels === true;
    if (els.lucidCompressionFormatSelect) els.lucidCompressionFormatSelect.value = settings.compressionFormat || 'auto';
    if (els.lucidCompressionLevelSelect) els.lucidCompressionLevelSelect.value = settings.compressionLevel || 'balanced';
    if (els.lucidCustomQualityInput) els.lucidCustomQualityInput.value = settings.customQuality ?? 80;
    if (els.lucidCustomMaxDimensionInput) els.lucidCustomMaxDimensionInput.value = settings.customMaxDimension ?? 1800;
    updateCustomCompressionVisibility();
    openModal(els.lucidSettingsModal, { focusTarget: els.lucidApiKeyInput });
  }

  function closeLucidSettings() {
    closeModal(els.lucidSettingsModal);
  }

  els.lucidSettingsBtn?.addEventListener('click', () => openLucidSettings());

  const normalizeLucidSettingsNumbers = () => {
    normalizeNumericInput(els.lucidImageScaleInput, 25, 400, 100, 5);
    normalizeNumericInput(els.lucidImagePixelScaleInput, 25, 200, 100, 5);
    normalizeNumericInput(els.lucidLabelTextSizeInput, 8, 72, 14, 1);
    normalizeNumericInput(els.lucidCustomQualityInput, 1, 100, 80, 1);
    normalizeNumericInput(els.lucidCustomMaxDimensionInput, 200, 4000, 1800, 50);
  };

  els.lucidImageScaleInput?.addEventListener('change', normalizeLucidSettingsNumbers);
  els.lucidImagePixelScaleInput?.addEventListener('change', normalizeLucidSettingsNumbers);
  els.lucidLabelTextSizeInput?.addEventListener('change', normalizeLucidSettingsNumbers);
  els.lucidCustomQualityInput?.addEventListener('change', normalizeLucidSettingsNumbers);
  els.lucidCustomMaxDimensionInput?.addEventListener('change', normalizeLucidSettingsNumbers);

  els.lucidSettingsCancelBtn?.addEventListener('click', closeLucidSettings);

  els.lucidSettingsModal?.addEventListener('click', (e) => {
    if (e.target === els.lucidSettingsModal) closeLucidSettings();
  });

  els.lucidSettingsSaveBtn?.addEventListener('click', () => {
    const { saveLucidSettings } = window.__lucidExport || {};
    if (!saveLucidSettings) return;
    const apiKey = els.lucidApiKeyInput?.value.trim() || '';
    const title = els.lucidDocTitleInput?.value.trim() || '';
    const product = els.lucidProductSelect?.value || 'lucidchart';
    normalizeLucidSettingsNumbers();
    const imageScale = clamp(Number(els.lucidImageScaleInput?.value) || 100, 25, 400);
    const imagePixelScale = clamp(Number(els.lucidImagePixelScaleInput?.value) || 100, 25, 200);
    const labelTextSize = clamp(Number(els.lucidLabelTextSizeInput?.value) || 14, 8, 72);
    const compressImages = els.lucidCompressImagesInput ? els.lucidCompressImagesInput.checked : true;
    const mergeLinkedSpreads = els.lucidMergeSpreadsInput ? els.lucidMergeSpreadsInput.checked : true;
    const includeOutline = els.lucidIncludeOutlineInput ? els.lucidIncludeOutlineInput.checked : true;
    const includePageLabels = els.lucidIncludePageLabelsInput ? els.lucidIncludePageLabelsInput.checked : false;
    const compressionFormat = els.lucidCompressionFormatSelect?.value || 'auto';
    const compressionLevel = els.lucidCompressionLevelSelect?.value || 'balanced';
    const customQuality = clamp(Number(els.lucidCustomQualityInput?.value) || 80, 1, 100);
    const customMaxDimension = clamp(Number(els.lucidCustomMaxDimensionInput?.value) || 1800, 200, 4000);
    if (!apiKey) {
      showToast('API key cannot be empty.');
      els.lucidApiKeyInput?.focus();
      return;
    }
    saveLucidSettings({
      apiKey,
      title,
      product,
      imageScale,
      imagePixelScale,
      labelTextSize,
      compressImages,
      mergeLinkedSpreads,
      includeOutline,
      includePageLabels,
      compressionFormat,
      compressionLevel,
      customQuality,
      customMaxDimension
    });
    closeLucidSettings();
    showToast('Lucid API settings saved.');
  });

  els.previewCloseBtn.addEventListener('click', closePreviewModal);
  els.previewPrevBtn.addEventListener('click', () => stepPreview(-1));
  els.previewNextBtn.addEventListener('click', () => stepPreview(1));
  els.previewZoomOutBtn?.addEventListener('click', () => zoomPreview(-0.1));
  els.previewZoomInBtn?.addEventListener('click', () => zoomPreview(0.1));
  els.previewFitBtn?.addEventListener('click', resetPreviewZoom);
  els.previewResetBtn?.addEventListener('click', resetPreviewZoom);

  els.previewModal.addEventListener('click', event => {
    if (event.target === els.previewModal) {
      closePreviewModal();
    }
  });

  // History button listeners
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  
  els.historyBtn.addEventListener('click', () => {
    openModal(els.historyModal);
    renderHistoryTimeline();
    updateHistoryButtonStates();
  });
  
  els.historyCloseBtn.addEventListener('click', () => {
    closeModal(els.historyModal);
  });
  
  els.historyClearBtn.addEventListener('click', () => {
    if (confirm('Clear all history? This cannot be undone.')) {
      history.undoStack = [];
      history.redoStack = [];
      updateHistoryButtonStates();
      renderHistoryTimeline();
      showToast('History cleared');
    }
  });
  
  els.historyModal.addEventListener('click', event => {
    if (event.target === els.historyModal) {
      closeModal(els.historyModal);
    }
  });

  els.exportLogBtn?.addEventListener('click', () => {
    renderExportLog();
    openModal(els.exportLogModal);
  });

  els.exportLogCloseBtn?.addEventListener('click', () => {
    closeModal(els.exportLogModal);
  });

  els.exportLogClearBtn?.addEventListener('click', () => {
    if (confirm('Clear the export log? This cannot be undone.')) {
      saveExportLog([]);
      renderExportLog();
      showToast('Export log cleared');
    }
  });

  els.exportLogModal?.addEventListener('click', event => {
    if (event.target === els.exportLogModal) {
      closeModal(els.exportLogModal);
    }
  });

  els.helpBtn?.addEventListener('click', () => {
    closeTopMenus();
    openModal(els.helpModal, { focusTarget: els.helpCloseBtn });
  });

  els.helpCloseBtn?.addEventListener('click', () => {
    closeModal(els.helpModal);
  });

  els.helpModal?.addEventListener('click', event => {
    if (event.target === els.helpModal) {
      closeModal(els.helpModal);
    }
  });

  document.addEventListener('keydown', event => {
    if (!state.previewModalOpen) return;
    if (event.key === 'Escape') {
      closePreviewModal();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepPreview(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepPreview(1);
    }
  });

  els.overflowApplyBtn.addEventListener('click', applyOverflowDimensions);

  bindGlobalDrop();
  bindCanvasInteractions();
}

function renderHistoryTimeline() {
  const container = document.getElementById('historyTimeline');
  if (!container) return;
  container.setAttribute('role', 'list');
  
  container.innerHTML = '';
  
  const redoCopy = [...history.redoStack].reverse();
  const allSteps = [...history.undoStack, ...redoCopy];
  if (allSteps.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--muted);font-size:13px;">No history yet — make a change to start tracking.</div>';
    return;
  }
  
  const currentIdx = history.undoStack.length;
  
  allSteps.forEach((snapshot, idx) => {
    const isRedo = idx >= history.undoStack.length;
    const isCurrent = idx === currentIdx - 1 && !isRedo;
    const timeStr = new Date(snapshot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const step = document.createElement('button');
    step.type = 'button';
    step.className = `history-step ${isCurrent ? 'current' : ''} ${isRedo ? 'redo' : 'undo'}`;
    step.title = `${snapshot.label} — ${timeStr}`;
    step.setAttribute('role', 'listitem');
    if (isCurrent) {
      step.setAttribute('aria-current', 'step');
    }
    
    const thumb = document.createElement('div');
    thumb.className = 'history-step-thumb';
    if (snapshot.preview) {
      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.alt = snapshot.label;
      thumb.appendChild(img);
    } else {
      const lbl = document.createElement('div');
      lbl.className = 'history-label';
      lbl.textContent = snapshot.label.substring(0, 4);
      thumb.appendChild(lbl);
    }
    step.appendChild(thumb);
    
    const meta = document.createElement('div');
    meta.className = 'history-step-meta';
    const labelEl = document.createElement('div');
    labelEl.className = 'history-step-label';
    labelEl.textContent = snapshot.label;
    const timeEl = document.createElement('div');
    timeEl.className = 'history-step-time';
    timeEl.textContent = timeStr;
    meta.appendChild(labelEl);
    meta.appendChild(timeEl);
    step.appendChild(meta);
    
    step.addEventListener('click', () => {
      const currentHistoryIndex = history.undoStack.length - 1;
      if (idx > currentHistoryIndex) {
        const stepsToRedo = idx - currentHistoryIndex;
        for (let i = 0; i < stepsToRedo; i += 1) redo();
      } else if (idx < currentHistoryIndex) {
        const stepsToUndo = currentHistoryIndex - idx;
        for (let i = 0; i < stepsToUndo; i += 1) undo();
      }
    });
    
    container.appendChild(step);
  });
}

function renderExportLog() {
  const container = els.exportLogList || document.getElementById('exportLogList');
  if (!container) return;

  const log = loadExportLog();
  if (log.length === 0) {
    container.innerHTML = '<p class="export-log-empty">No exports yet — use Export ▾ → Send to Lucid to create one.</p>';
    return;
  }

  container.innerHTML = log.map(entry => {
    const dateStr = entry.created ? new Date(entry.created).toLocaleString() : '';
    const editLink = entry.editUrl
      ? `<a class="mini-button" href="${escapeHtmlAttr(entry.editUrl)}" target="_blank" rel="noopener">Edit</a>`
      : '';
    const viewLink = entry.viewUrl
      ? `<a class="mini-button" href="${escapeHtmlAttr(entry.viewUrl)}" target="_blank" rel="noopener">View</a>`
      : '';
    return `<div class="export-log-item">
        <div class="export-log-info">
          <span class="export-log-title">${escapeHtmlAttr(entry.title || 'Untitled')}</span>
          <span class="export-log-meta">${escapeHtmlAttr(entry.product || '')}${dateStr ? ' · ' + escapeHtmlAttr(dateStr) : ''}</span>
        </div>
        <div class="export-log-actions">${editLink}${viewLink}</div>
      </div>`;
  }).join('');
}

async function renderAll() {
  normalizeGridReferences();
  normalizeColumnGaps();
  renderHoldingTray();
  state.fit = 'contain';
  syncSettingsInputs();
  renderGapControls();
  renderGrid();
  updateStatChips();
  persistSession();
  syncPreviewModal();
}

function initElements() {
  els.appShell = document.querySelector('.app-shell');
  els.topbar = document.querySelector('.topbar');
  els.folderInput = document.getElementById('folderInput');
  els.filesInput = document.getElementById('filesInput');
  els.importMenuBtn = document.getElementById('importMenuBtn');
  els.importMenu = document.getElementById('importMenu');
  els.importFolderBtn = document.getElementById('importFolderBtn');
  els.importFilesBtn = document.getElementById('importFilesBtn');
  els.workspace = document.querySelector('.workspace');
  els.controlsPanel = document.getElementById('controlsPanel');
  els.toggleControlsBtn = document.getElementById('toggleControlsBtn');
  els.revealControlsBtn = document.getElementById('revealControlsBtn');

  els.rowsInput = document.getElementById('rowsInput');
  els.colsInput = document.getElementById('colsInput');
  els.shrinkModeSelect = document.getElementById('shrinkModeSelect');
  els.gapControlsContainer = document.getElementById('gapControlsContainer');
  els.gapXInput = document.getElementById('gapXInput');
  els.gapYInput = document.getElementById('gapYInput');
  els.fitModeInput = document.getElementById('fitModeInput');
  els.cellWidthInput = document.getElementById('cellWidthInput');
  els.cellHeightInput = document.getElementById('cellHeightInput');

  els.toggleTrayBtn = document.getElementById('toggleTrayBtn');
  els.imageTrayPanel = document.getElementById('imageTrayPanel');

  els.rowsDownBtn = document.getElementById('rowsDownBtn');
  els.rowsUpBtn = document.getElementById('rowsUpBtn');
  els.colsDownBtn = document.getElementById('colsDownBtn');
  els.colsUpBtn = document.getElementById('colsUpBtn');

  els.autoPackBtn = document.getElementById('autoPackBtn');
  els.shuffleBtn = document.getElementById('shuffleBtn');
  els.clearGridBtn = document.getElementById('clearGridBtn');

  els.copyPngBtn = document.getElementById('copyPngBtn');
  els.copyLucidBtn = document.getElementById('copyLucidBtn');
  els.downloadPngBtn = document.getElementById('downloadPngBtn');
  els.exportMenuBtn = document.getElementById('exportMenuBtn');
  els.exportMenu = document.getElementById('exportMenu');
  els.previewModal = document.getElementById('previewModal');
  els.previewModalImage = document.getElementById('previewModalImage');
  els.previewModalTitle = document.getElementById('previewModalTitle');
  els.previewModalCaption = document.getElementById('previewModalCaption');
  els.previewModalCounter = document.getElementById('previewModalCounter');
  els.previewPrevBtn = document.getElementById('previewPrevBtn');
  els.previewCloseBtn = document.getElementById('previewCloseBtn');
  els.previewNextBtn = document.getElementById('previewNextBtn');
  els.previewZoomOutBtn = document.getElementById('previewZoomOutBtn');
  els.previewZoomInBtn = document.getElementById('previewZoomInBtn');
  els.previewFitBtn = document.getElementById('previewFitBtn');
  els.previewResetBtn = document.getElementById('previewResetBtn');
  els.previewZoomLabel = document.getElementById('previewZoomLabel');
  els.previewImageContainer = document.getElementById('previewImageContainer');

  els.dropCurtain = document.getElementById('dropCurtain');
  els.canvasViewport = document.getElementById('canvasViewport');
  els.canvasStage = document.getElementById('canvasStage');
  els.zoomOutBtn = document.getElementById('zoomOutBtn');
  els.zoomInBtn = document.getElementById('zoomInBtn');
  els.resetViewBtn = document.getElementById('resetViewBtn');
  els.fitViewBtn = document.getElementById('fitViewBtn');
  els.zoomLabel = document.getElementById('zoomLabel');
  els.grid = document.getElementById('grid');
  els.previewCanvas = document.getElementById('previewCanvas');

  els.assetCount = document.getElementById('assetCount');
  els.slotCount = document.getElementById('slotCount');
  els.assignedCount = document.getElementById('assignedCount');
  els.toastStatus = document.getElementById('toastStatus');
  els.dragExpandStatus = document.getElementById('dragExpandStatus');

  els.toast = document.getElementById('toast');
  els.overflowModal = document.getElementById('overflowModal');
  els.overflowColsInput = document.getElementById('overflowColsInput');
  els.overflowRowsInput = document.getElementById('overflowRowsInput');
  els.overflowApplyBtn = document.getElementById('overflowApplyBtn');
  els.overflowMessage = document.getElementById('overflowMessage');
  els.overflowRecommendation = document.getElementById('overflowRecommendation');
  els.importModeModal = document.getElementById('importModeModal');
  els.importModeMessage = document.getElementById('importModeMessage');
  els.importExistingNotice = document.getElementById('importExistingNotice');
  els.importReplaceBtn = document.getElementById('importReplaceBtn');
  els.importFillBtn = document.getElementById('importFillBtn');
  els.importAppendStartBtn = document.getElementById('importAppendStartBtn');
  els.importAppendEndBtn = document.getElementById('importAppendEndBtn');
  els.importAppendSelectedBtn = document.getElementById('importAppendSelectedBtn');
  els.importTrayBtn = document.getElementById('importTrayBtn');
  els.replaceOptionsModal = document.getElementById('replaceOptionsModal');
  els.replaceModeMessage = document.getElementById('replaceModeMessage');
  els.replaceOffsetSelect = document.getElementById('replaceOffsetSelect');
  els.replaceSizingSelect = document.getElementById('replaceSizingSelect');
  els.replaceRowsSelect = document.getElementById('replaceRowsSelect');
  els.replaceColsSelect = document.getElementById('replaceColsSelect');
  els.replaceOffsetHint = document.getElementById('replaceOffsetHint');
  els.replaceModeRecommendation = document.getElementById('replaceModeRecommendation');
  els.replaceModeMinimums = document.getElementById('replaceModeMinimums');
  els.replaceCancelBtn = document.getElementById('replaceCancelBtn');
  els.replaceApplyBtn = document.getElementById('replaceApplyBtn');
  els.holdingTray = document.getElementById('holdingTray');
  els.holdingCount = document.getElementById('holdingCount');
  els.holdingCountHandle = document.getElementById('holdingCountHandle');
  els.clearTrayBtn = document.getElementById('clearTrayBtn');
  els.dragTooltip = document.getElementById('dragTooltip');

  // Document import elements
  els.importDocBtn = document.getElementById('importDocBtn');
  els.docImportModal = document.getElementById('docImportModal');
  els.docImportStepUpload = document.getElementById('docImportStepUpload');
  els.docImportStepExplorer = document.getElementById('docImportStepExplorer');
  els.docImportCloseBtn = document.getElementById('docImportCloseBtn');
  els.docImportDropZone = document.getElementById('docImportDropZone');
  els.docFileInput = document.getElementById('docFileInput');
  els.docImportProgress = document.getElementById('docImportProgress');
  els.docProgressBar = document.getElementById('docProgressBar');
  els.docProgressLabel = document.getElementById('docProgressLabel');
  els.docImportCancelBtn = document.getElementById('docImportCancelBtn');
  els.docImportResults = document.getElementById('docImportResults');
  els.docResultsInfo = document.getElementById('docResultsInfo');
  els.docSelectAllBtn = document.getElementById('docSelectAllBtn');
  els.docDeselectAllBtn = document.getElementById('docDeselectAllBtn');
  els.docRangeInput = document.getElementById('docRangeInput');
  els.docRangeApplyBtn = document.getElementById('docRangeApplyBtn');
  els.docThumbGrid = document.getElementById('docThumbGrid');
  els.docPreviewStage = document.getElementById('docPreviewStage');
  els.docPreviewImage = document.getElementById('docPreviewImage');
  els.docPreviewEmpty = document.getElementById('docPreviewEmpty');
  els.docPreviewLabel = document.getElementById('docPreviewLabel');
  els.docPreviewOpenBtn = document.getElementById('docPreviewOpenBtn');
  els.docImportBackBtn = document.getElementById('docImportBackBtn');
  els.docSelectionCount = document.getElementById('docSelectionCount');
  els.docImportConfirmBtn = document.getElementById('docImportConfirmBtn');
  els.docImportSubtitle = document.getElementById('docImportSubtitle');
  els.docLightboxModal = document.getElementById('docLightboxModal');
  els.docLightboxImage = document.getElementById('docLightboxImage');
  els.docLightboxLabel = document.getElementById('docLightboxLabel');
  els.docLightboxCloseBtn = document.getElementById('docLightboxCloseBtn');
  els.docLightboxPrevBtn = document.getElementById('docLightboxPrevBtn');
  els.docLightboxNextBtn = document.getElementById('docLightboxNextBtn');
  els.docLightboxZoomOutBtn = document.getElementById('docLightboxZoomOutBtn');
  els.docLightboxZoomInBtn = document.getElementById('docLightboxZoomInBtn');
  els.docLightboxFitBtn = document.getElementById('docLightboxFitBtn');
  els.docLightboxResetBtn = document.getElementById('docLightboxResetBtn');
  els.docLightboxZoomLabel = document.getElementById('docLightboxZoomLabel');
  els.docLightboxContainer = document.getElementById('docLightboxContainer');

  // History elements
  els.undoBtn = document.getElementById('undoBtn');
  els.redoBtn = document.getElementById('redoBtn');
  els.historyBtn = document.getElementById('historyBtn');
  els.historyModal = document.getElementById('historyModal');
  els.historyCloseBtn = document.getElementById('historyCloseBtn');
  els.historyClearBtn = document.getElementById('historyClearBtn');
  els.historyTimeline = document.getElementById('historyTimeline');
  els.exportLogBtn = document.getElementById('exportLogBtn');
  els.exportLogModal = document.getElementById('exportLogModal');
  els.exportLogList = document.getElementById('exportLogList');
  els.exportLogClearBtn = document.getElementById('exportLogClearBtn');
  els.exportLogCloseBtn = document.getElementById('exportLogCloseBtn');
  els.helpBtn = document.getElementById('helpBtn');
  els.helpModal = document.getElementById('helpModal');
  els.helpCloseBtn = document.getElementById('helpCloseBtn');

  // Lucid direct-send elements
  els.sendToLucidBtn = document.getElementById('sendToLucidBtn');
  els.lucidSettingsBtn = document.getElementById('lucidSettingsBtn');
  els.lucidSettingsModal = document.getElementById('lucidSettingsModal');
  els.uiScaleInput = document.getElementById('uiScaleInput');
  els.uiScaleValue = document.getElementById('uiScaleValue');
  els.lucidApiKeyInput = document.getElementById('lucidApiKeyInput');
  els.lucidDocTitleInput = document.getElementById('lucidDocTitleInput');
  els.lucidProductSelect = document.getElementById('lucidProductSelect');
  els.lucidImageScaleInput = document.getElementById('lucidImageScaleInput');
  els.lucidImageScaleValue = document.getElementById('lucidImageScaleValue');
  els.lucidImagePixelScaleInput = document.getElementById('lucidImagePixelScaleInput');
  els.lucidImagePixelScaleValue = document.getElementById('lucidImagePixelScaleValue');
  els.lucidLabelTextSizeInput = document.getElementById('lucidLabelTextSizeInput');
  els.lucidLabelTextSizeValue = document.getElementById('lucidLabelTextSizeValue');
  els.lucidCompressImagesInput = document.getElementById('lucidCompressImagesInput');
  els.lucidMergeSpreadsInput = document.getElementById('lucidMergeSpreadsInput');
  els.lucidIncludeOutlineInput = document.getElementById('lucidIncludeOutlineInput');
  els.lucidIncludePageLabelsInput = document.getElementById('lucidIncludePageLabelsInput');
  els.lucidCompressionFormatSelect = document.getElementById('lucidCompressionFormatSelect');
  els.lucidCompressionLevelSelect = document.getElementById('lucidCompressionLevelSelect');
  els.lucidCustomCompressionFields = document.getElementById('lucidCustomCompressionFields');
  els.lucidCustomQualityInput = document.getElementById('lucidCustomQualityInput');
  els.lucidCustomQualityValue = document.getElementById('lucidCustomQualityValue');
  els.lucidCustomMaxDimensionInput = document.getElementById('lucidCustomMaxDimensionInput');
  els.lucidSettingsCancelBtn = document.getElementById('lucidSettingsCancelBtn');
  els.lucidSettingsSaveBtn = document.getElementById('lucidSettingsSaveBtn');

  // Lucid send modal elements
  els.lucidSendModal = document.getElementById('lucidSendModal');
  els.lucidSendTitleInput = document.getElementById('lucidSendTitleInput');
  els.lucidDocSearchInput = document.getElementById('lucidDocSearchInput');
  els.lucidDocSearchBtn = document.getElementById('lucidDocSearchBtn');
  els.lucidDocResults = document.getElementById('lucidDocResults');
  els.lucidDocSelection = document.getElementById('lucidDocSelection');
  els.lucidDocSelectionLabel = document.getElementById('lucidDocSelectionLabel');
  els.lucidDocClearBtn = document.getElementById('lucidDocClearBtn');
  els.lucidSendFolderNote = document.getElementById('lucidSendFolderNote');
  els.lucidSendCancelBtn = document.getElementById('lucidSendCancelBtn');
  els.lucidSendConfirmBtn = document.getElementById('lucidSendConfirmBtn');
}

async function init() {
  initElements();
  state.shrinkMode = loadShrinkMode();
  if (els.shrinkModeSelect) els.shrinkModeSelect.value = state.shrinkMode;
  state.uiScalePreference = loadUiScalePreference();
  updateViewportLayout();
  state.controlsOpen = true;
  setControlsOpen(true);
  const restored = await restoreSession();
  ensureGridShape();
  bindEvents();
  bindDocImportEvents();
  setupLightboxCanvasInteractions();
  setupPreviewCanvasInteractions();
  await renderAll();
  updateHistoryButtonStates();
  renderHistoryTimeline();
  // Best-effort cleanup of any full-resolution blobs left behind by a
  // previous session (e.g. tab closed mid-edit) that no longer correspond
  // to any restored asset.
  void pruneOrphanedAssetBlobs();
  requestAnimationFrame(() => {
    fitCanvasView();
    requestAnimationFrame(() => {
      fitCanvasView();
    });
  });
  if (restored) {
    showToast('Restored previous session');
  }
}

init();
