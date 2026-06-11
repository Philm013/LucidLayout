const GRID_LIMIT = 20;
const SESSION_STORAGE_KEY = 'png-grid-session-v1';
const WINDOW_NAME_SESSION_PREFIX = 'png-grid-session-v1:';
const SESSION_DB_NAME = 'png-grid-session-db';
const SESSION_DB_STORE = 'kv';
const SESSION_DB_VERSION = 1;

let sessionDbPromise = null;

const state = {
  assets: [],
  grid: [],
  rows: 3,
  cols: 3,
  gapX: 12,
  gapY: 12,
  cellWidth: 160,
  cellHeight: 120,
  textSize: 12,
  fit: 'contain',
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
  dragPayload: null,
  dropDepth: 0,
  lastDragExpandAt: 0,
  overflowModalOpen: false,
  previewModalOpen: false,
  previewSlotIndex: null,
  dragEdgeHint: null,
  flowPreview: null,
  autoExpandSession: null,
  multiSelectedSlots: [],
  holdingAssetIds: [],
  modalFocusReturnEl: null
};

const els = {};

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
      assets: JSON.parse(JSON.stringify(state.assets)),
      grid: state.grid.slice(),
      rows: state.rows,
      cols: state.cols,
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
  state.assets = JSON.parse(JSON.stringify(s.assets));
  state.grid = s.grid.slice();
  state.rows = s.rows;
  state.cols = s.cols;
  state.gapX = Number.isFinite(s.gapX) ? s.gapX : (Number.isFinite(s.gap) ? s.gap : 12);
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

function showToast(message) {
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
  }, 2200);
}

function showDragTooltip(clientX, clientY, mode, text) {
  if (!els.dragTooltip) return;
  els.dragTooltip.textContent = text;
  els.dragTooltip.className = `drag-tooltip mode-${mode}`;
  els.dragTooltip.style.left = `${clientX + 16}px`;
  els.dragTooltip.style.top = `${clientY - 36}px`;
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

function getLayoutMetrics() {
  const cellWidth = state.cellWidth || 160;
  const cellHeight = state.cellHeight || 120;
  const innerWidth = cellWidth * state.cols + state.gapX * Math.max(0, state.cols - 1);
  const innerHeight = cellHeight * state.rows + state.gapY * Math.max(0, state.rows - 1);
  const width = innerWidth;
  const height = innerHeight;
  return {
    width,
    height,
    cellWidth,
    cellHeight,
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
  const nextCols = clamp(state.cols + addCols, 1, GRID_LIMIT);
  const nextRows = clamp(state.rows + addRows, 1, GRID_LIMIT);
  const actualColsAdded = nextCols - state.cols;
  const actualRowsAdded = nextRows - state.rows;
  if (actualColsAdded === 0 && actualRowsAdded === 0) {
    return { changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const appliedLeft = Math.min(left, actualColsAdded);
  const appliedRight = Math.max(0, actualColsAdded - appliedLeft);
  const appliedTop = Math.min(top, actualRowsAdded);
  const appliedBottom = Math.max(0, actualRowsAdded - appliedTop);

  const colStride = metrics.cellWidth + state.gapX;
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

  state.rows = nextRows;
  state.cols = nextCols;
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

  const colStride = metrics.cellWidth + state.gapX;
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

  state.rows = nextRows;
  state.cols = nextCols;
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
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });

  return sessionDbPromise;
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
    state.rows = clamp(Number(saved.rows || 3), 1, GRID_LIMIT);
    state.cols = clamp(Number(saved.cols || 3), 1, GRID_LIMIT);
    const legacyGap = clamp(Number(saved.gap || 12), 0, 120);
    state.gapX = clamp(Number(saved.gapX ?? legacyGap), 0, 120);
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
  els.gapXInput.value = String(state.gapX);
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

function updateViewportLayout() {
  const targetWidth = 1660;
  const targetHeight = 940;
  const widthScale = window.innerWidth / targetWidth;
  const heightScale = window.innerHeight / targetHeight;
  const uiScale = clamp(Math.min(widthScale, heightScale), 0.68, 1);
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
  renderGrid();
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
  const minCols = Math.min(GRID_LIMIT, Math.max(1, Number(firstRowOffset) + 1));

  for (let cols = minCols; cols <= GRID_LIMIT; cols += 1) {
    const rows = minRowsForCols(cols, count, firstRowOffset);
    if (rows < 1 || rows > GRID_LIMIT) continue;
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
    return { rows: GRID_LIMIT, cols: GRID_LIMIT };
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
  if (required === 0) return 1;
  const minCols = Math.min(GRID_LIMIT, Math.max(1, Number(firstRowOffset) + 1));

  for (let cols = minCols; cols <= GRID_LIMIT; cols += 1) {
    if (capacityForDims(safeRows, cols, firstRowOffset) >= required) {
      return cols;
    }
  }

  return GRID_LIMIT;
}

function allAssignedIds(gridValues) {
  const ids = [];
  for (const value of gridValues) {
    if (value) ids.push(value);
  }
  return ids;
}

function resizeGridPreserve(newRows, newCols) {
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
  for (const id of survivors) {
    let alreadyPlaced = false;
    for (const v of newGrid) {
      if (v === id) {
        alreadyPlaced = true;
        break;
      }
    }
    if (alreadyPlaced) continue;
    const empty = newGrid.findIndex(v => v === null);
    if (empty >= 0) newGrid[empty] = id;
  }

  state.rows = newRows;
  state.cols = newCols;
  state.grid = newGrid;
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
  renderAll();
  showToast('Tray cleared');
}

function renderHoldingTray() {
  if (!els.holdingTray) return;
  const validIds = new Set(state.assets.map(asset => asset.id));
  state.holdingAssetIds = state.holdingAssetIds.filter(id => validIds.has(id));

  els.holdingTray.innerHTML = '';
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
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'holding-tile';
    tile.draggable = true;
    tile.title = `Drag ${asset.name} to place`;
    tile.setAttribute('aria-label', `Drag ${asset.name} to place`);

    const img = document.createElement('img');
    img.src = asset.dataUrl;
    img.alt = '';
    img.draggable = false;
    tile.appendChild(img);

    const label = document.createElement('span');
    label.textContent = asset.name;
    tile.appendChild(label);

    tile.addEventListener('dragstart', () => {
      clearFlowPreview();
      state.dragPayload = { type: 'asset', assetId, source: 'holding' };
      announceDragExpansion(`Dragging staged image ${asset.name}`);
      beginAutoExpandSession();
      state.lastDragExpandAt = 0;
    });

    tile.addEventListener('dragend', () => {
      clearFlowPreview();
      const collapsed = finalizeAutoExpandSession();
      state.dragPayload = null;
      state.lastDragExpandAt = 0;
      clearDragEdgeIndicators();
      if (collapsed) {
        renderAll();
      }
    });

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
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const image = await loadImage(dataUrl);

  return {
    id: uid(),
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    importKey,
    dataUrl,
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
    state.canvasWidth = Math.max(1, state.canvasWidth + addCols * (state.cellWidth + state.gapX));
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
    } else if (state.gapX <= 0) {
      lineX = insertCol * metrics.cellWidth - 2;
    } else {
      const rightOfPrev = (insertCol - 1) * (metrics.cellWidth + state.gapX) + metrics.cellWidth;
      const leftOfNext = insertCol * (metrics.cellWidth + state.gapX);
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
  const nearBetween = ratio <= edgeRatio || ratio >= (1 - edgeRatio);

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
  const gapX = state.gapX * scaleX;
  const gapY = state.gapY * scaleY;
  const strideX = cellWidth + gapX;
  const strideY = cellHeight + gapY;
  if (cellWidth <= 0 || cellHeight <= 0 || strideX <= 0 || strideY <= 0) return null;

  const relX = event.clientX - gridRect.left;
  const relY = event.clientY - gridRect.top;
  if (relX < 0 || relX > gridRect.width || relY < 0 || relY > gridRect.height) return null;

  const row = Math.floor(relY / strideY);
  if (row < 0 || row >= state.rows) return null;

  const localY = relY - row * strideY;
  if (localY < 0 || localY > cellHeight) {
    return null;
  }

  const col = Math.floor(relX / strideX);
  if (col < 0 || col >= Math.max(1, state.cols - 1)) return null;

  const localX = relX - col * strideX;
  if (localX < cellWidth || localX > strideX) {
    return null;
  }

  const targetIndex = row * state.cols + col;
  const placement = 'after';
  const insertionIndex = Math.min(targetIndex + 1, state.grid.length);
  return { targetIndex, insertionIndex, placement, nearBetween: true };
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
    state.canvasWidth = Math.max(1, state.canvasWidth + addCols * (state.cellWidth + state.gapX));
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

  state.cols = nextCols;
  state.grid = nextGrid;
  state.canvasWidth = Math.max(1, state.canvasWidth - (metrics.cellWidth + state.gapX));
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

function beginAutoExpandSession() {
  if (!state.dragPayload) return;
  if (!['slot', 'group', 'asset'].includes(state.dragPayload.type)) return;

  const rect = els.grid ? els.grid.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
  const metrics = getLayoutMetrics();
  const strideX = Math.max(1, (metrics.cellWidth + state.gapX) * state.zoom);
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

function getPreviewSlotIndices() {
  const indices = [];
  for (let i = 0; i < state.grid.length; i += 1) {
    if (state.grid[i]) indices.push(i);
  }
  return indices;
}

function closePreviewModal() {
  state.previewModalOpen = false;
  state.previewSlotIndex = null;
  els.previewModal.classList.remove('show');
  els.previewModal.setAttribute('aria-hidden', 'true');
}

function syncPreviewModal() {
  if (!state.previewModalOpen) return;
  const sequence = getPreviewSlotIndices();
  if (sequence.length === 0) {
    closePreviewModal();
    showToast('No images available to preview');
    return;
  }

  let sequenceIndex = sequence.indexOf(state.previewSlotIndex ?? sequence[0]);
  if (sequenceIndex < 0) sequenceIndex = 0;
  state.previewSlotIndex = sequence[sequenceIndex];

  const slotIndex = state.previewSlotIndex;
  const assetId = state.grid[slotIndex];
  const asset = assetId ? findAssetById(assetId) : null;
  if (!asset) {
    closePreviewModal();
    return;
  }

  els.previewModalImage.src = asset.dataUrl;
  els.previewModalImage.alt = asset.name;
  els.previewModalTitle.textContent = asset.name;
  const slotRow = Math.floor(slotIndex / state.cols) + 1;
  const slotCol = (slotIndex % state.cols) + 1;
  els.previewModalCaption.textContent = `Slot ${slotIndex + 1} of ${state.grid.length} (Row ${slotRow}, Column ${slotCol})`;
  els.previewModalCounter.textContent = `${sequenceIndex + 1} / ${sequence.length}`;
  els.previewPrevBtn.disabled = sequence.length <= 1;
  els.previewNextBtn.disabled = sequence.length <= 1;
  els.previewModal.classList.add('show');
  els.previewModal.setAttribute('aria-hidden', 'false');
}

function openPreviewModal(slotIndex) {
  const assetId = state.grid[slotIndex];
  if (!assetId) return;
  state.previewModalOpen = true;
  state.previewSlotIndex = slotIndex;
  syncPreviewModal();
}

function stepPreview(direction) {
  if (!state.previewModalOpen) return;
  const sequence = getPreviewSlotIndices();
  if (sequence.length === 0) return closePreviewModal();
  const currentIndex = sequence.indexOf(state.previewSlotIndex ?? sequence[0]);
  const nextIndex = (currentIndex < 0 ? 0 : currentIndex + direction + sequence.length) % sequence.length;
  state.previewSlotIndex = sequence[nextIndex];
  syncPreviewModal();
}

function createGridEdgeButtons(metrics) {
  if (state.cols > 1) {
    for (let col = 0; col < state.cols; col += 1) {
      const x = metrics.offsetX + col * (metrics.cellWidth + state.gapX) + metrics.cellWidth / 2;
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

function createGridCell(assetId, index, frame) {
  const cell = document.createElement('div');
  cell.className = 'grid-cell';
  cell.dataset.index = String(index);
  cell.draggable = Boolean(assetId);
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-label', `Slot ${index + 1}${assetId ? ', filled' : ', empty'}`);
  if (state.selectedSlotIndex === index) {
    cell.classList.add('selected');
  }
  if (state.multiSelectedSlots.includes(index)) {
    cell.classList.add('multi-selected');
  }
  cell.style.left = `${frame.left}%`;
  cell.style.top = `${frame.top}%`;
  cell.style.width = `${frame.width}%`;
  cell.style.height = `${frame.height}%`;

  const indexLabel = document.createElement('div');
  indexLabel.className = 'grid-cell-index';
  indexLabel.textContent = String(index + 1);
  cell.appendChild(indexLabel);

  const empty = document.createElement('div');
  empty.className = 'grid-cell-empty';

  const actions = document.createElement('div');
  actions.className = 'cell-actions';
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.textContent = assetId ? '↺' : '+';
  replaceBtn.title = assetId ? 'Replace image' : 'Add image';
  replaceBtn.setAttribute('aria-label', assetId ? 'Replace image' : 'Add image');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.title = 'Clear cell';
  removeBtn.setAttribute('aria-label', 'Clear cell');
  removeBtn.disabled = !assetId;
  actions.appendChild(replaceBtn);
  actions.appendChild(removeBtn);

  if (assetId) {
    const asset = findAssetById(assetId);
    if (asset) {
      const img = document.createElement('img');
      img.className = 'grid-cell-image';
      img.src = asset.dataUrl;
      img.alt = asset.name;
      img.draggable = false;
      img.style.objectFit = state.fit;
      img.style.objectPosition = 'center';
      cell.appendChild(img);

      const caption = document.createElement('div');
      caption.className = 'grid-cell-caption';
      caption.textContent = getDisplayName(asset.name);
      caption.title = asset.name;
      cell.appendChild(caption);
    }
  }

  if (!assetId) {
    cell.appendChild(empty);
  }

  cell.appendChild(actions);

  replaceBtn.addEventListener('click', () => {
    replaceGridSlot(index);
  });

  removeBtn.addEventListener('click', () => {
    clearGridSlot(index);
  });

  cell.addEventListener('dragstart', () => {
    if (!assetId) return;
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

  cell.addEventListener('dragend', () => {
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
    event.preventDefault();
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
  };

  cell.addEventListener('click', activateCell);

  cell.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    await activateCell(event);
  });

  cell.addEventListener('dblclick', event => {
    event.preventDefault();
    if (assetId) {
      openPreviewModal(index);
    }
  });

  return cell;
}

function renderGrid() {
  els.grid.innerHTML = '';
  normalizeMultiSelection();
  const metrics = getLayoutMetrics();

  els.grid.style.width = `${metrics.width * state.zoom}px`;
  els.grid.style.height = `${metrics.height * state.zoom}px`;

  for (let index = 0; index < state.grid.length; index += 1) {
    const row = Math.floor(index / state.cols);
    const col = index % state.cols;
    const x = metrics.offsetX + col * (metrics.cellWidth + state.gapX);
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

async function drawLayoutToCanvas(canvas) {
  const metrics = getLayoutMetrics();
  canvas.width = metrics.width;
  canvas.height = metrics.height;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < state.grid.length; i += 1) {
    const row = Math.floor(i / state.cols);
    const col = i % state.cols;
    const x = metrics.offsetX + col * (metrics.cellWidth + state.gapX);
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

    const image = await loadImage(asset.dataUrl);
    const rect = objectFitRect({ x, y, width: metrics.cellWidth, height: metrics.cellHeight }, image, state.fit);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, metrics.cellWidth, metrics.cellHeight);
    ctx.clip();
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }
}

async function renderPreview() {
  await drawLayoutToCanvas(els.previewCanvas);
}

function buildSvgMarkup() {
  const metrics = getLayoutMetrics();

  const defs = [];
  const imageNodes = [];

  for (let i = 0; i < state.grid.length; i += 1) {
    const row = Math.floor(i / state.cols);
    const col = i % state.cols;
    const x = metrics.offsetX + col * (metrics.cellWidth + state.gapX);
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
    imageNodes.push(`<rect x="${x}" y="${y}" width="${metrics.cellWidth}" height="${metrics.cellHeight}" fill="#f3f7fc"/>`);
    imageNodes.push(`<image href="${asset.dataUrl}" x="${fitRect.x}" y="${fitRect.y}" width="${fitRect.width}" height="${fitRect.height}" clip-path="url(#${clipId})" preserveAspectRatio="none"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${metrics.width}" height="${metrics.height}" viewBox="0 0 ${metrics.width} ${metrics.height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<defs>${defs.join('')}</defs>`,
    imageNodes.join(''),
    '</svg>'
  ].join('');
}

function buildLucidContentPayload() {
  const metrics = getLayoutMetrics();

  const scale = 10;
  const base = { x: 10000, y: 1000 };
  const objects = [];
  const copiedItemIds = [];
  let zOrder = 20;

  for (let i = 0; i < state.grid.length; i += 1) {
    const assetId = state.grid[i];
    if (!assetId) continue;

    const asset = findAssetById(assetId);
    if (!asset) continue;

    const row = Math.floor(i / state.cols);
    const col = i % state.cols;
    const x = metrics.offsetX + col * (metrics.cellWidth + state.gapX);
    const y = metrics.offsetY + row * (metrics.cellHeight + state.gapY);
    const fitRect = objectFitRect({ x, y, width: metrics.cellWidth, height: metrics.cellHeight }, { width: asset.width, height: asset.height }, 'contain');

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
          AspectRatio: asset.width / Math.max(1, asset.height),
          BoundingBox: {
            x: base.x + fitRect.x * scale,
            y: base.y + fitRect.y * scale,
            w: fitRect.width * scale,
            h: fitRect.height * scale
          },
          DataSyncStateIconPosition: null,
          DynamicFontSize: false,
          FillColor: {
            pos: 'fill',
            url: asset.dataUrl,
            polys: null
          },
          FlipX: false,
          FlipY: false,
          GutterPadding: 5,
          IgnoreTheme: {},
          ImageFillProps: {
            polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]],
            size: { width: asset.width, height: asset.height },
            url: asset.dataUrl
          },
          InsetMargin: 0,
          LineColor: '#000000ff',
          LineWidth: 0,
          NoteHint: '',
          Rotation: 0,
          Rounding: 0,
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
  }

  const size = {
    w: metrics.width * scale,
    h: metrics.height * scale
  };

  return {
    Objects: objects,
    Base: { ...base },
    Page: '0_0',
    Elements: {
      ss_presetShapeStyle1: {
        id: 'ss_presetShapeStyle1',
        Type: 'ShapeStylePreset',
        Properties: {
          Order: 1,
          Name: '',
          BlockFillColor: '#ffffffff',
          BlockLineColor: '#3a414aff',
          BlockLineWidth: 2,
          BlockStrokeStyle: 'solid'
        }
      }
    },
    Pages: {},
    Size: size,
    Plugins: ['/js/plugins/v2/userimage.js'],
    Document: lucidId(),
    Panel: '',
    PanelOffset: { x: 0, y: 0 },
    BCUVersion: 151,
    CopiedItemIds: copiedItemIds
  };
}

async function buildLucidHtmlPayload() {
  const payload = buildLucidContentPayload();
  const payloadJson = JSON.stringify(payload);
  const escapedPayload = escapeHtmlAttr(payloadJson);
  await renderPreview();
  const previewUrl = els.previewCanvas.toDataURL('image/png');

  const html = [
    '<html>',
    '<body>',
    '<!--StartFragment-->',
    `<span data-lucid-type="application/vnd.lucid.chart.objects" data-lucid-content="${escapedPayload}"> </span>`,
    previewUrl ? `<img src="${previewUrl}">` : '',
    '<!--EndFragment-->',
    '</body>',
    '</html>'
  ].join('');

  return html;
}

async function canvasToPngBlob() {
  await renderPreview();
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
    const lucidHtml = await buildLucidHtmlPayload();
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([lucidHtml], { type: 'text/html' })
      })
    ]);
    showToast('Copied Lucid payload (HTML). Paste with Ctrl+V.');
    return;
  } catch {
    try {
      const svgMarkup = buildSvgMarkup();
      const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/svg+xml': svgBlob
        })
      ]);
      showToast('Lucid HTML blocked; copied SVG fallback.');
    } catch {
      const pngBlob = await canvasToPngBlob();
      if (!pngBlob) {
        showToast('Lucid copy failed');
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })]);
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
  state.gapX = 12;
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
  renderAll();
  fitCanvasView();
  showToast('Cleared and reset grid');
}

function applyNumberSettings() {
  const prevRows = state.rows;
  const prevCols = state.cols;
  const prevGapX = state.gapX;
  const prevGapY = state.gapY;
  const prevCellWidth = state.cellWidth;
  const prevCellHeight = state.cellHeight;

  state.gapX = clamp(Number(els.gapXInput.value || 0), 0, 120);
  state.gapY = clamp(Number(els.gapYInput.value || 0), 0, 120);
  state.cellWidth = clamp(Number(els.cellWidthInput.value || 160), 40, 500);
  state.cellHeight = clamp(Number(els.cellHeightInput.value || 120), 40, 500);
  state.fit = 'contain';

  let nextRows = clamp(Number(els.rowsInput.value || 1), 1, GRID_LIMIT);
  let nextCols = clamp(Number(els.colsInput.value || 1), 1, GRID_LIMIT);
  const required = state.assets.length;
  
  // Detect which dimension the user changed
  const colsChanged = nextCols !== prevCols;
  const rowsChanged = nextRows !== prevRows;
  
  if (required > 0) {
    if (rowsChanged && !colsChanged) {
      // User changed rows, recalculate minimum columns needed for those rows
      nextCols = minColsForRows(nextRows, required);
      if (nextCols > GRID_LIMIT) {
        nextCols = GRID_LIMIT;
        nextRows = minRowsForCols(nextCols, required);
      }
      showToast('Columns adjusted to fit all images');
    } else if (colsChanged && !rowsChanged) {
      // User changed columns, recalculate minimum rows needed for those columns
      nextRows = minRowsForCols(nextCols, required);
      if (nextRows > GRID_LIMIT) {
        nextRows = GRID_LIMIT;
        nextCols = minColsForRows(nextRows, required);
      }
      showToast('Rows adjusted to fit all images');
    }
  }

  const changed =
    prevRows !== nextRows ||
    prevCols !== nextCols ||
    prevGapX !== state.gapX ||
    prevGapY !== state.gapY ||
    prevCellWidth !== state.cellWidth ||
    prevCellHeight !== state.cellHeight;

  if (changed) {
    pushHistory('Manual layout settings change');
  }

  resizeGridPreserve(nextRows, nextCols);
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
}

function getOpenModalElement() {
  const ordered = [els.docLightboxModal, els.docImportModal, els.historyModal, els.replaceOptionsModal, els.importModeModal, els.overflowModal];
  for (const modal of ordered) {
    if (modal?.classList.contains('show')) return modal;
  }
  return null;
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

function openModal(modalEl) {
  if (!modalEl) return;
  if (!modalEl.classList.contains('show')) {
    state.modalFocusReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  modalEl.classList.add('show');
  modalEl.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => focusFirstInModal(modalEl));
}

function closeModal(modalEl, { restoreFocus = true } = {}) {
  if (!modalEl) return;
  modalEl.classList.remove('show');
  modalEl.setAttribute('aria-hidden', 'true');
  if (restoreFocus && state.modalFocusReturnEl instanceof HTMLElement) {
    state.modalFocusReturnEl.focus();
  }
  state.modalFocusReturnEl = null;
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
    } else if (openModalEl === els.docLightboxModal) {
      closeDocLightbox();
    } else if (openModalEl === els.docImportModal) {
      closeDocImportModal();
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
  }

  rows = clamp(rows, 1, GRID_LIMIT);
  cols = clamp(cols, Math.max(1, firstRowOffset + 1), GRID_LIMIT);

  if (mode !== 'keep-current') {
    if (capacityForDims(rows, cols, firstRowOffset) < assetCount) {
      rows = minRowsForCols(cols, assetCount, firstRowOffset);
      if (rows > GRID_LIMIT) {
        rows = GRID_LIMIT;
        cols = minColsForRows(rows, assetCount, firstRowOffset);
      }
    }
  }

  rows = clamp(rows, 1, GRID_LIMIT);
  cols = clamp(cols, Math.max(1, firstRowOffset + 1), GRID_LIMIT);
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
  const customCols = clamp(Number(els.replaceColsSelect?.value || state.cols), 1, GRID_LIMIT);
  const customRows = clamp(Number(els.replaceRowsSelect?.value || state.rows), 1, GRID_LIMIT);
  const baseDims = count > 0
    ? resolveReplaceGridDimensions(count, 0, sizingMode, customRows, customCols)
    : { cols: sizingMode === 'custom' ? customCols : state.cols };
  const maxStartCol = clamp(baseDims.cols, 1, GRID_LIMIT);
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

  const currentRows = clamp(Number(els.replaceRowsSelect.value || state.rows), 1, GRID_LIMIT);
  const currentCols = clamp(Number(els.replaceColsSelect.value || state.cols), 1, GRID_LIMIT);

  els.replaceRowsSelect.innerHTML = '';
  els.replaceColsSelect.innerHTML = '';

  for (let i = 1; i <= GRID_LIMIT; i += 1) {
    const rowOption = document.createElement('option');
    rowOption.value = String(i);
    rowOption.textContent = String(i);
    els.replaceRowsSelect.appendChild(rowOption);

    const colOption = document.createElement('option');
    colOption.value = String(i);
    colOption.textContent = String(i);
    els.replaceColsSelect.appendChild(colOption);
  }

  els.replaceRowsSelect.value = String(currentRows);
  els.replaceColsSelect.value = String(currentCols);
}

function updateReplaceOptionsSummary() {
  const files = state.pendingReplaceFiles || [];
  const count = files.length;
  if (!count || !els.replaceOffsetSelect) return;

  const startCol = clamp(Number(els.replaceOffsetSelect.value || 1), 1, GRID_LIMIT);
  const sizingMode = els.replaceSizingSelect?.value || 'recommended';
  const firstRowOffset = startCol - 1;
  const customRows = clamp(Number(els.replaceRowsSelect?.value || state.rows), 1, GRID_LIMIT);
  const customCols = clamp(Number(els.replaceColsSelect?.value || state.cols), 1, GRID_LIMIT);
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
  els.overflowMessage.textContent = `${assetCount} images were imported, but the current grid has ${state.grid.length} spaces.`;
  els.overflowRecommendation.textContent = `Recommended size (offset starts at column ${startCol}): ${rec.cols} x ${rec.rows}.`;
  els.overflowColsInput.value = String(Math.max(state.cols, rec.cols));
  els.overflowRowsInput.value = String(Math.max(state.rows, rec.rows));
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
    const customRows = clamp(Number(options.customRows || state.rows), 1, GRID_LIMIT);
    const customCols = clamp(Number(options.customCols || state.cols), 1, GRID_LIMIT);
    state.assets = nextAssets;
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
  let cols = clamp(Number(els.overflowColsInput.value || 1), 1, GRID_LIMIT);
  let rows = clamp(Number(els.overflowRowsInput.value || 1), 1, GRID_LIMIT);
  const rawOffset = Math.max(0, Number(state.pendingGridPlacementOffset) || 0);
  cols = Math.max(cols, Math.min(GRID_LIMIT, rawOffset + 1));
  const firstRowOffset = normalizeFirstRowOffset(rawOffset, cols);

  if (capacityForDims(rows, cols, firstRowOffset) < required) {
    rows = minRowsForCols(cols, required, firstRowOffset);
    if (rows > GRID_LIMIT) {
      rows = GRID_LIMIT;
      cols = minColsForRows(rows, required, firstRowOffset);
    }
  }

  resizeGridPreserve(rows, cols);
  if (state.pendingGridSequence && state.pendingGridSequence.length > 0) {
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
  closeOverflowModal();
  renderAll();
  showToast(`Grid resized to ${cols} x ${rows}`);
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

  els.canvasViewport.addEventListener('wheel', event => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    zoomAt(event.clientX, event.clientY, factor);
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
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
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
        item.setAttribute('aria-label', `${thumb.label}, not selected`);
      } else {
        docImportState.selected.add(idx);
        item.classList.add('selected');
        check.innerHTML = '✓';
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
    if (target.closest('.menu-wrap')) return;
    closeTopMenus();
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
    const startCol = clamp(Number(els.replaceOffsetSelect?.value || 1), 1, GRID_LIMIT);
    const firstRowOffset = startCol - 1;
    const replaceSizing = els.replaceSizingSelect?.value || 'recommended';
    const customRows = clamp(Number(els.replaceRowsSelect?.value || state.rows), 1, GRID_LIMIT);
    const customCols = clamp(Number(els.replaceColsSelect?.value || state.cols), 1, GRID_LIMIT);
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
    resizeGridPreserve(clamp(state.rows + 1, 1, GRID_LIMIT), state.cols);
    renderAll();
  });

  els.rowsDownBtn.addEventListener('click', () => {
    if (state.rows <= 1) return;
    removeRowAt(state.rows - 1);
  });

  els.colsUpBtn.addEventListener('click', () => {
    pushHistory(`Increase columns to ${state.cols + 1}`);
    resizeGridPreserve(state.rows, clamp(state.cols + 1, 1, GRID_LIMIT));
    renderAll();
  });

  els.colsDownBtn.addEventListener('click', () => {
    if (state.cols <= 1) return;
    removeColumnAt(state.cols - 1);
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
        state[stateKey] = Number(el.value);
        renderAll();
        // Debounce history push to avoid too many entries while dragging slider
        clearTimeout(changeTimeout);
        changeTimeout = setTimeout(() => {
          pushHistory(`Change ${stateKey} to ${el.value}`);
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
    
    const step = document.createElement('div');
    step.className = `history-step ${isCurrent ? 'current' : ''} ${isRedo ? 'redo' : 'undo'}`;
    step.title = `${snapshot.label} — ${timeStr}`;
    
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

async function renderAll() {
  normalizeGridReferences();
  renderHoldingTray();
  state.fit = 'contain';
  syncSettingsInputs();
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
}

async function init() {
  initElements();
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
