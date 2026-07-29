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
                'image/webp': 'png', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
  return map[mime] || 'png';
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

function buildDocumentJson(gridState, imageFilenames) {
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
        x: Math.round(fit.x),
        y: Math.round(fit.y),
        w: Math.round(fit.width),
        h: Math.round(fit.height)
      },
      image: {
        type: 'ref',
        ref: filename
      },
      stroke: { width: 0 }
    });

  }

  // Page size (px). Lucid caps custom pages at 20,000 × 20,000.
  const pageW = Math.min(20000, Math.max(1, Math.round(cols * cellWidth + Math.max(0, cols - 1) * gapX)));
  const pageH = Math.min(20000, Math.max(1, Math.round(rows * cellHeight + Math.max(0, rows - 1) * gapY)));

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
 * @param {object} options    — { apiKey, title, product, parentFolderId }
 * @param {function} onProgress — (message: string) => void
 * @returns {Promise<{editUrl, viewUrl, documentId, title}>}
 */
export async function sendGridToLucid(gridState, options, onProgress = () => {}) {
  const { apiKey, title = 'PNG Grid Export', product = 'lucidchart', parentFolderId } = options;

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
  const usedFilenames = new Set();

  for (const assetId of usedAssetIds) {
    const asset = gridState.assets.find(a => a.id === assetId);
    if (!asset || !asset.dataUrl) continue;

    const { bytes, mime } = dataUrlToUint8Array(asset.dataUrl);
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

  const docJson = buildDocumentJson(gridState, imageFilenames);
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

  // Approach B (reference docs): POST /v1/documents/create, type as a separate field.
  const buildFormB = () => {
    const f = new FormData();
    f.append('type', 'x-application/vnd.lucid.standardImport');
    f.append('product', product);
    f.append('title', title);
    if (parentFolderId != null) f.append('parent', String(parentFolderId));
    f.append('file', new Blob([zipBlob], { type: 'application/zip' }), 'export.lucid');
    return f;
  };

  async function tryLucidUpload(endpoint, form) {
    return fetch(`${LUCID_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: lucidHeaders(apiKey),
      body: form
    });
  }

  let res = await tryLucidUpload('/v1/documents', buildFormA());
  if (res.status === 400 || res.status === 415) {
    res = await tryLucidUpload('/v1/documents/create', buildFormB());
  }

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.message || json?.error
      || (Array.isArray(json?.errors) ? json.errors.join('; ') : null)
      || `Lucid API error ${res.status}`;
    throw new Error(msg);
  }

  return {
    documentId: json.documentId,
    editUrl: json.editUrl,
    viewUrl: json.viewUrl,
    title: json.title
  };
}
