/**
 * js/lucid-export.js
 *
 * Builds a Lucid Standard Import `.lucid` ZIP from the current PNG Grid state
 * and POSTs it directly to the Lucid REST API from the browser.
 *
 * Lucid's API supports CORS (confirmed via a preflight OPTIONS request —
 * it reflects the request Origin and allows Authorization/Content-Type/
 * Lucid-Api-Version headers), so no server-side proxy is needed. This also
 * sidesteps corporate TLS-inspection issues entirely, since browsers already
 * trust the OS certificate store (unlike Node, which uses its own bundled CA
 * list by default).
 *
 * Depends on JSZip (loaded via CDN in index.html).
 */

const LUCID_API_BASE = 'https://api.lucid.co';
const LUCID_SETTINGS_KEY = 'png-grid-lucid-settings';

function lucidHeaders(apiKey, extra = {}) {
  return {
    'Authorization': `Bearer ${apiKey.trim()}`,
    'Accept': 'application/json',
    'Lucid-Api-Version': '1',
    ...extra
  };
}

// ── Settings persistence ──────────────────────────────────────────────────────

export function loadLucidSettings() {
  try {
    return JSON.parse(localStorage.getItem(LUCID_SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveLucidSettings(settings) {
  localStorage.setItem(LUCID_SETTINGS_KEY, JSON.stringify(settings));
}

// ── Data-URL → Blob conversion ────────────────────────────────────────────────

function dataUrlToUint8Array(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return { bytes: arr, mime };
}

function extensionForMime(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
                'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
  return map[mime] || 'png';
}

// ── Image compression (keeps the exported .lucid ZIP within Lucid's upload
//    size limits when importing dozens/hundreds of full-resolution page
//    renders, e.g. from a large PDF import) ───────────────────────────────────

// Images at/under this size aren't worth recompressing.
const COMPRESS_SKIP_BELOW_BYTES = 150 * 1024;

// Compression presets, from least to most aggressive. Rather than encoding
// every opaque image at one fixed JPEG quality (which looks great on some
// images and visibly blocky/artifacted on others, especially flat-color or
// text-heavy page renders), each image is re-encoded a few times at
// decreasing quality and the first result under `targetBytes` wins — so
// most images stay near the top of the quality range and only genuinely
// large images get pushed toward `minQuality`.
const COMPRESSION_PRESETS = {
  high: { maxDimension: 2200, quality: 0.94, minQuality: 0.82, targetBytes: 450 * 1024 },
  balanced: { maxDimension: 1800, quality: 0.9, minQuality: 0.7, targetBytes: 220 * 1024 },
  small: { maxDimension: 1400, quality: 0.8, minQuality: 0.55, targetBytes: 120 * 1024 }
};
const DEFAULT_COMPRESSION_LEVEL = 'balanced';
const DEFAULT_COMPRESSION_FORMAT = 'auto';
const CUSTOM_QUALITY_DEFAULT = 80;
const CUSTOM_MAX_DIMENSION_DEFAULT = 1800;
const CUSTOM_MAX_DIMENSION_MIN = 200;
const CUSTOM_MAX_DIMENSION_MAX = 4000;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Canvas's own `toDataURL('image/png')` always writes a 32-bit truecolor+
// alpha PNG and completely ignores any "quality" argument (the HTML spec
// only defines it for image/jpeg and image/webp) — so the quality slider/
// presets used to do nothing at all for PNG output. UPNG.js (lazy-loaded
// from a CDN, same pattern as JSZip) can re-encode as an *indexed* PNG with
// a limited color palette (the same lossy-quantization approach tools like
// pngquant/TinyPNG use), which is typically 2-4x smaller than truecolor even
// at a fairly high color count, and shrinks further as the palette shrinks.
const UPNG_CDN_URL = 'https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js';
let upngLoadPromise = null;

function loadUpng() {
  if (typeof window !== 'undefined' && window.UPNG) return Promise.resolve(window.UPNG);
  if (!upngLoadPromise) {
    upngLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = UPNG_CDN_URL;
      script.onload = () => resolve(window.UPNG);
      script.onerror = () => reject(new Error('Failed to load PNG compression library from CDN.'));
      document.head.appendChild(script);
    });
  }
  return upngLoadPromise;
}

// Maps a 0..1 quality value to an indexed-PNG palette size. 1.0 (100%) stays
// fully lossless (no quantization at all — cnum 0 tells UPNG to encode
// truecolor). Below that, the palette shrinks toward a 8-color floor,
// trading color fidelity for file size.
function pngColorsForQuality(quality) {
  if (quality >= 0.99) return 0;
  return Math.max(8, Math.round(quality * 256));
}

/**
 * Quantizes/re-encodes a canvas as a (possibly indexed) PNG via UPNG.js.
 * `colors === 0` requests lossless truecolor encoding (still generally
 * smaller than the browser's own PNG encoder). Falls back to the browser's
 * built-in `canvas.toDataURL('image/png')` if the CDN library can't load
 * (e.g. offline), so compression never hard-fails the export.
 */
async function encodePngQuantized(ctx, width, height, colors) {
  try {
    const UPNG = await loadUpng();
    const { data } = ctx.getImageData(0, 0, width, height);
    const buf = UPNG.encode([data.buffer], width, height, colors);
    return { bytes: new Uint8Array(buf), mime: 'image/png' };
  } catch (err) {
    console.warn('[lucid-export] PNG quantization unavailable, falling back to standard PNG encoding', err);
    return dataUrlToUint8Array(ctx.canvas.toDataURL('image/png'));
  }
}

/**
 * Resolves the effective compression settings (max dimension, quality range,
 * target size, and output format) for a single export run. `level` selects
 * one of the built-in presets, or 'custom' to use `customQuality`/
 * `customMaxDimension` at a single fixed quality (no adaptive step-down,
 * since the user has already picked an exact value). `format` controls the
 * output image type: 'auto' (JPEG for opaque images, PNG for transparent
 * ones — the historical behavior), or a forced 'jpeg'/'png'.
 */
function resolveCompressionSettings({
  level = DEFAULT_COMPRESSION_LEVEL,
  format = DEFAULT_COMPRESSION_FORMAT,
  customQuality,
  customMaxDimension,
  maxTargetBytes
} = {}) {
  if (level === 'custom') {
    const quality = clampNumber(customQuality, 1, 100, CUSTOM_QUALITY_DEFAULT) / 100;
    const maxDimension = clampNumber(customMaxDimension, CUSTOM_MAX_DIMENSION_MIN, CUSTOM_MAX_DIMENSION_MAX, CUSTOM_MAX_DIMENSION_DEFAULT);
    // Normally a single fixed quality, not an adaptive range — the user asked
    // for exact control, so don't silently step it down. But when many images
    // share Lucid's 50MB budget (maxTargetBytes is set), still allow stepping
    // down toward a floor quality to hit that per-image share — otherwise a
    // large grid at "custom" quality would always overshoot the budget on
    // this pass and require a full, slower second pass at the "small" preset.
    const hasBudget = Number.isFinite(maxTargetBytes);
    const minQuality = hasBudget ? Math.max(0.35, quality - 0.35) : quality;
    return { maxDimension, quality, minQuality, targetBytes: hasBudget ? maxTargetBytes : Infinity, format, pngColors: pngColorsForQuality(quality) };
  }
  const preset = COMPRESSION_PRESETS[level] || COMPRESSION_PRESETS[DEFAULT_COMPRESSION_LEVEL];
  // When exporting many images, tighten the per-image target size up front
  // (based on an even share of Lucid's overall budget) so large grids fit
  // within the limit on the first compression pass instead of always having
  // to redo every image a second time at the most aggressive preset.
  const targetBytes = Number.isFinite(maxTargetBytes) ? Math.min(preset.targetBytes, maxTargetBytes) : preset.targetBytes;
  return { ...preset, targetBytes, format, pngColors: pngColorsForQuality(preset.quality) };
}

// Lucid rejects Standard Import files whose /images folder exceeds 50MB
// (see https://developer.lucid.co/docs/overview-si). Leave some headroom
// below the hard limit for zip/container overhead.
const LUCID_IMAGES_BUDGET_BYTES = 48 * 1024 * 1024;
const LUCID_MOST_AGGRESSIVE_LEVEL = 'small';

function loadImageFromDataUrl(dataUrl) {
  // createImageBitmap decodes off the main thread in supporting browsers
  // (faster and non-blocking vs. an <img> element's onload), which matters
  // when many images are being compressed concurrently. Falls back to the
  // <img> approach if unavailable or if it fails for any reason.
  if (typeof createImageBitmap === 'function') {
    return fetch(dataUrl)
      .then(res => res.blob())
      .then(blob => createImageBitmap(blob))
      .catch(() => loadImageViaImgElement(dataUrl));
  }
  return loadImageViaImgElement(dataUrl);
}

function loadImageViaImgElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image for compression'));
    img.src = dataUrl;
  });
}

// Cheap coarse-grid sample instead of scanning every pixel, since we only
// need to decide PNG (preserve alpha) vs. JPEG (opaque, smaller) here. Reads
// from a small downscaled copy rather than the full-resolution canvas, since
// getImageData on a large canvas allocates/copies its entire width×height×4
// pixel buffer — wasteful when only a coarse check is needed.
function hasVisibleTransparency(ctx, width, height) {
  const sw = Math.min(64, width);
  const sh = Math.min(64, height);
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
  const { data } = sctx.getImageData(0, 0, sw, sh);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/**
 * Re-encodes a canvas at decreasing quality steps (from `settings.quality`
 * down to `settings.minQuality`), stopping as soon as the result fits within
 * `settings.targetBytes`. This keeps most images near the top of the quality
 * range and only compresses harder when an image is actually large, instead
 * of applying one blanket quality to everything. When `targetBytes` is
 * `Infinity` (custom quality mode) this just encodes once at `quality`.
 */
function encodeAdaptive(canvas, settings, mimeType) {
  const { quality, minQuality, targetBytes } = settings;
  const steps = Number.isFinite(targetBytes) ? 4 : 1;
  let best = null;
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const q = quality - (quality - minQuality) * t;
    const candidate = dataUrlToUint8Array(canvas.toDataURL(mimeType, q));
    if (!best || candidate.bytes.byteLength < best.bytes.byteLength) {
      best = candidate;
    }
    if (candidate.bytes.byteLength <= targetBytes) {
      return candidate;
    }
  }
  return best;
}

/**
 * Downscales and/or re-encodes a single asset's data URL for export, to keep
 * the overall ZIP small. Vector/animated formats (SVG, GIF) are always left
 * untouched, since Lucid supports both natively and converting them would
 * lose vector scaling or animation.
 *
 * `settings.format` controls the output image type:
 *  - 'auto' (default): JPEG for opaque images, PNG for images with real
 *    transparency — the historical behavior, and small (<150KB) images are
 *    left as-is rather than being recompressed.
 *  - 'jpeg': always convert to JPEG (smallest files; transparency is lost —
 *    a white backdrop is composited behind any transparent pixels).
 *  - 'png': always convert to PNG (lossless, keeps transparency, but
 *    doesn't compress nearly as well as JPEG for photo/page-like content).
 * Forced formats also apply to small images, since the user explicitly
 * asked for a specific file type rather than just "make it smaller".
 *
 * @param {string} dataUrl
 * @param {{maxDimension:number, quality:number, minQuality:number, targetBytes:number, format:string}} settings
 *   — resolved via `resolveCompressionSettings()`.
 */
async function compressAssetForExport(dataUrl, settings) {
  const { maxDimension, format = DEFAULT_COMPRESSION_FORMAT } = settings;
  const original = dataUrlToUint8Array(dataUrl);

  if (original.mime === 'image/svg+xml' || original.mime === 'image/gif') {
    return original;
  }

  if (format === DEFAULT_COMPRESSION_FORMAT && original.bytes.byteLength <= COMPRESS_SKIP_BELOW_BYTES) {
    return original;
  }

  try {
    const img = await loadImageFromDataUrl(dataUrl);
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    // Release the decoded bitmap promptly — with several images compressing
    // concurrently, letting these pile up until GC would spike memory use.
    if (typeof img.close === 'function') img.close();

    const transparent = hasVisibleTransparency(ctx, width, height);
    const effectiveFormat = format === DEFAULT_COMPRESSION_FORMAT ? (transparent ? 'png' : 'jpeg') : format;

    if (effectiveFormat === 'png') {
      return await encodePngQuantized(ctx, width, height, settings.pngColors ?? 0);
    }

    // JPEG: composite a white backdrop behind any transparent/semi-transparent
    // pixels (including stray edges our coarse sampling may have missed),
    // since JPEG has no alpha channel, then re-encode for a much smaller file.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    return encodeAdaptive(canvas, settings, 'image/jpeg');
  } catch (err) {
    console.warn('[lucid-export] compression failed for one image, using original', err);
    return original;
  }
}

// ── object-fit: contain rect (mirrors app.js objectFitRect) ──────────────────

function containRect(container, src) {
  const scaleX = container.width / src.width;
  const scaleY = container.height / src.height;
  const scale = Math.min(scaleX, scaleY);
  const w = src.width * scale;
  const h = src.height * scale;
  return {
    x: container.x + (container.width - w) / 2,
    y: container.y + (container.height - h) / 2,
    width: w,
    height: h
  };
}

// ── Standard Import document.json builder ────────────────────────────────────

function buildDocumentJson(gridState, imageFilenames, imageScale = 1) {
  const { grid, rows, cols, cellWidth, cellHeight, gapX, gapY, assets } = gridState;

  const findAsset = (id) => assets.find(a => a.id === id);

  const shapes = [];

  for (let i = 0; i < grid.length; i++) {
    const assetId = grid[i];
    if (!assetId) continue;

    const asset = findAsset(assetId);
    if (!asset) continue;

    const filename = imageFilenames[assetId];
    if (!filename) continue;

    const row = Math.floor(i / cols);
    const col = i % cols;

    const cellX = col * (cellWidth + gapX);
    const cellY = row * (cellHeight + gapY);

    const fit = containRect(
      { x: cellX, y: cellY, width: cellWidth, height: cellHeight },
      { width: asset.width || cellWidth, height: asset.height || cellHeight }
    );

    // Per https://developer.lucid.co/docs/standard-library-si the "Image Block"
    // shape (type: "image") is the correct choice for pure images — it has NO
    // default text/rounded-corner styling (unlike type:"rectangle", which is
    // actually the "Default Block" — a rounded box with placeholder text).
    // Image Block requires top-level "image" and "stroke" (not nested in "style").
    shapes.push({
      id: `img-${i}`,
      type: 'image',
      boundingBox: {
        x: Math.round(fit.x * imageScale),
        y: Math.round(fit.y * imageScale),
        w: Math.round(fit.width * imageScale),
        h: Math.round(fit.height * imageScale)
      },
      image: {
        type: 'ref',
        ref: filename
      },
      stroke: { width: 0 }
    });

  }

  // Page size (px). Lucid caps custom pages at 20,000 × 20,000.
  const pageW = Math.min(20000, Math.max(1, Math.round((cols * cellWidth + Math.max(0, cols - 1) * gapX) * imageScale)));
  const pageH = Math.min(20000, Math.max(1, Math.round((rows * cellHeight + Math.max(0, rows - 1) * gapY) * imageScale)));

  return {
    version: 1,
    pages: [
      {
        id: 'page1',
        title: 'Grid',
        settings: {
          size: {
            type: 'custom',
            w: pageW,
            h: pageH
          }
        },
        shapes
      }
    ]
  };
}

// ── Lucid document search ────────────────────────────────────────────────────

/**
 * Search the user's Lucid documents (calls Lucid's API directly).
 * @param {string} apiKey
 * @param {string} keywords
 * @param {string} product  — 'lucidchart' | 'lucidspark'
 * @returns {Promise<Array<{documentId, title, parent, lastModified, editUrl}>>}
 */
export async function searchLucidDocs(apiKey, keywords = '', product = 'lucidchart') {
  if (!apiKey || !apiKey.trim()) throw new Error('Lucid API key is required.');

  const searchBody = {
    product: [product],
    excludeTrashed: true,
    ...(keywords.trim() ? { keywords: keywords.trim().slice(0, 400) } : {})
  };

  const res = await fetch(`${LUCID_API_BASE}/v1/documents/search`, {
    method: 'POST',
    headers: lucidHeaders(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(searchBody)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || json?.error || `Search failed (${res.status})`);

  const docs = Array.isArray(json) ? json : (json.documents || []);
  return docs.map(d => ({
    documentId: d.documentId,
    title: d.title,
    product: d.product,
    parent: d.parent ?? null,
    lastModified: d.lastModified,
    editUrl: d.editUrl
  }));
}

/**
 * Fetch a single document's metadata (including parent folder).
 * @param {string} apiKey
 * @param {string} documentId
 * @returns {Promise<{documentId, title, parent, editUrl}>}
 */
export async function getLucidDoc(apiKey, documentId) {
  if (!apiKey || !apiKey.trim()) throw new Error('Lucid API key is required.');
  if (!documentId) throw new Error('Missing document id.');

  const res = await fetch(`${LUCID_API_BASE}/v1/documents/search`, {
    method: 'POST',
    headers: lucidHeaders(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ documentIds: [documentId], excludeTrashed: true })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `Doc lookup failed (${res.status})`);

  const docs = Array.isArray(json) ? json : (json.documents || []);
  const doc = docs[0];
  if (!doc) throw new Error('Document not found or not accessible.');

  return {
    documentId: doc.documentId,
    title: doc.title,
    parent: doc.parent ?? null,
    editUrl: doc.editUrl
  };
}

// ── Main export function ──────────────────────────────────────────────────────

/**
 * Builds a .lucid ZIP in the browser and sends it to the proxy server.
 *
 * @param {object} gridState  — { grid, rows, cols, cellWidth, cellHeight, gapX, gapY, assets }
 * @param {object} options    — { apiKey, title, product, parentFolderId, imageScale, compressImages, compressionLevel, compressionFormat, customQuality, customMaxDimension }
 * @param {function} onProgress — (message: string) => void
 * @returns {Promise<{editUrl, viewUrl, documentId, title}>}
 */
export async function sendGridToLucid(gridState, options, onProgress = () => {}) {
  const {
    apiKey,
    title = 'PNG Grid Export',
    product = 'lucidchart',
    parentFolderId,
    imageScale = 1,
    compressImages = true,
    compressionLevel = DEFAULT_COMPRESSION_LEVEL,
    compressionFormat = DEFAULT_COMPRESSION_FORMAT,
    customQuality,
    customMaxDimension
  } = options;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('Lucid API key is required.');
  }

  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip is not loaded. Add the JSZip CDN script to index.html.');
  }

  onProgress('Building ZIP…');

  const zip = new JSZip();
  const imageFilenames = {};

  // Add each unique asset used in the grid
  const usedAssetIds = [...new Set(gridState.grid.filter(Boolean))];

  // Compress every asset first (without writing to the zip yet) so we can
  // check the total size against Lucid's 50MB /images budget. The per-image
  // target size is capped up front to an even share of that budget, so large
  // grids (many images) usually fit on this single pass instead of always
  // needing a full second pass over every image at the most aggressive preset.
  const perImageBudgetBytes = compressImages && usedAssetIds.length > 0
    ? LUCID_IMAGES_BUDGET_BYTES / usedAssetIds.length
    : Infinity;

  async function compressAllAssets(level, maxTargetBytes) {
    const settings = resolveCompressionSettings({ level, format: compressionFormat, customQuality, customMaxDimension, maxTargetBytes });
    const prepared = [];
    let totalBytes = 0;
    let completed = 0;
    const total = usedAssetIds.length;

    async function processOne(assetId) {
      const asset = gridState.assets.find(a => a.id === assetId);
      if (!asset || !asset.dataUrl) return;

      const { bytes, mime } = compressImages
        ? await compressAssetForExport(asset.dataUrl, settings)
        : dataUrlToUint8Array(asset.dataUrl);

      completed += 1;
      onProgress(`Preparing image ${completed} of ${total}…`);
      totalBytes += bytes.byteLength;
      prepared.push({ assetId, asset, bytes, mime });
    }

    // Process several images at once instead of fully awaiting each one in
    // turn — image decoding and canvas encoding largely overlap across
    // concurrent images (the browser can decode the next image while
    // encoding the previous one), so this meaningfully speeds up exports
    // with dozens/hundreds of images without changing the output.
    const concurrency = Math.min(6, Math.max(2, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < usedAssetIds.length) {
        const assetId = usedAssetIds[nextIndex++];
        await processOne(assetId);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

    return { prepared, totalBytes };
  }

  let { prepared, totalBytes } = await compressAllAssets(compressionLevel, perImageBudgetBytes);

  if (compressImages && totalBytes > LUCID_IMAGES_BUDGET_BYTES && compressionLevel !== LUCID_MOST_AGGRESSIVE_LEVEL) {
    onProgress('Images too large for Lucid\'s 50MB limit — recompressing at maximum compression…');
    ({ prepared, totalBytes } = await compressAllAssets(LUCID_MOST_AGGRESSIVE_LEVEL, perImageBudgetBytes));
  }

  if (totalBytes > LUCID_IMAGES_BUDGET_BYTES) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Combined image size (~${mb}MB across ${prepared.length} images) exceeds Lucid's 50MB images limit for a Standard Import, even at maximum compression. Try removing some images, splitting this export into multiple smaller grids/documents, or lowering the compression quality/max dimension in Settings.`
    );
  }

  const usedFilenames = new Set();
  for (const { assetId, asset, bytes, mime } of prepared) {
    const ext = extensionForMime(mime);
    // Strip any existing extension from the asset name before appending the correct one
    const rawName = (asset.name || assetId).replace(/\.[^.]+$/, '');
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || `img-${assetId}`;
    const filename = `${safeName}.${ext}`;

    // Deduplicate: if the filename already exists, append the asset index
    let finalFilename = filename;
    let dedupeIndex = 1;
    while (usedFilenames.has(finalFilename)) {
      finalFilename = `${safeName}-${dedupeIndex}.${ext}`;
      dedupeIndex++;
    }
    usedFilenames.add(finalFilename);

    // No explicit folder() call, and createFolders:false avoids an empty
    // "images/" directory entry in the ZIP (some parsers reject those).
    zip.file(`images/${finalFilename}`, bytes, { binary: true, createFolders: false });
    imageFilenames[assetId] = finalFilename;
  }

  onProgress('Building document layout…');

  const docJson = buildDocumentJson(gridState, imageFilenames, imageScale);
  console.log('[lucid-export] document.json:', JSON.stringify(docJson, null, 2));
  zip.file('document.json', JSON.stringify(docJson, null, 2));

  onProgress('Generating ZIP…');

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  onProgress('Sending to Lucid…');

  // Approach A (overview docs): POST /v1/documents, type communicated via the
  // file part's MIME type. Fall back to Approach B if Lucid rejects it.
  const buildFormA = () => {
    const f = new FormData();
    f.append('product', product);
    f.append('title', title);
    if (parentFolderId != null) f.append('parent', String(parentFolderId));
    f.append('file', new Blob([zipBlob], { type: 'x-application/vnd.lucid.standardImport' }), 'export.lucid');
    return f;
  };

  // Approach B (reference docs): POST /v1/documents/create. Per the official
  // endpoint reference, this requires a *separate* "type" form field set to
  // "x-application/vnd.lucid.standardImport" (in addition to the file part
  // itself) — omitting that field, or only setting the file's content-type,
  // was the bug that caused 415s here.
  const buildFormB = () => {
    const f = new FormData();
    f.append('type', 'x-application/vnd.lucid.standardImport');
    f.append('product', product);
    f.append('title', title);
    if (parentFolderId != null) f.append('parent', String(parentFolderId));
    f.append('file', new Blob([zipBlob], { type: 'x-application/vnd.lucid.standardImport' }), 'export.lucid');
    return f;
  };

  async function tryLucidUpload(endpoint, form) {
    return fetch(`${LUCID_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: lucidHeaders(apiKey),
      body: form
    });
  }

  const extractMsg = (json, status) => json?.message || json?.error
    || (Array.isArray(json?.errors) ? json.errors.join('; ') : null)
    || `Lucid API error ${status}`;

  let res = await tryLucidUpload('/v1/documents', buildFormA());
  let json = await res.clone().json().catch(() => ({}));

  if (!res.ok && (res.status === 400 || res.status === 415)) {
    const firstMsg = extractMsg(json, res.status);
    // Full body logged (not just the message) so it stays inspectable/copyable
    // in the DevTools console even after the toast disappears.
    console.error('[lucid-export] Approach A (/v1/documents) failed:', res.status, json);
    res = await tryLucidUpload('/v1/documents/create', buildFormB());
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[lucid-export] Approach B (/v1/documents/create) also failed:', res.status, json);
      // Surface the original (Approach A) error too — it's usually more
      // specific about *why* the import was rejected than the fallback's.
      throw new Error(`${extractMsg(json, res.status)} (first attempt: ${firstMsg})`);
    }
  } else if (!res.ok) {
    console.error('[lucid-export] Approach A (/v1/documents) failed:', res.status, json);
    throw new Error(extractMsg(json, res.status));
  }

  return {
    documentId: json.documentId,
    editUrl: json.editUrl,
    viewUrl: json.viewUrl,
    title: json.title
  };
}
