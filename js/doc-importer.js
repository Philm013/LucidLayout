/**
 * doc-importer.js
 * Document-to-thumbnail extraction pipeline for PNG Grid.
 *
 * Supported formats (client-side, lazy-loaded from CDN):
 *   PDF  → pdf.js    — high quality per-page renders
 *   DOCX → mammoth.js — HTML conversion → rendered page slices
 *   PPTX → JSZip     — slide XML + image extraction
 *   XLSX → SheetJS   — sheet table → canvas cell renders
 *   INDD → unsupported (polite message)
 *
 * Entry point: extractDocumentThumbnails(file, { onProgress, signal })
 *   Returns: Array of { dataUrl, label, width, height }
 */

// ─── CDN URLs ────────────────────────────────────────────────────────────────
const CDN = {
  pdfjs:   'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs',
  pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs',
  docxPreview: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.3/dist/docx-preview.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  jszip:   'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  xlsx:    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
};

// ─── Loader utilities ─────────────────────────────────────────────────────────
const _loaded = {};

async function loadScript(key, url) {
  if (_loaded[key]) return _loaded[key];
  _loaded[key] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error(`Failed to load ${key} from CDN. Check internet connection.`));
    document.head.appendChild(s);
  });
  return _loaded[key];
}

async function loadModule(key, url) {
  if (_loaded[key]) return _loaded[key];
  _loaded[key] = import(/* @vite-ignore */ url).catch(err => {
    throw new Error(`Failed to load ${key}: ${err.message}`);
  });
  return _loaded[key];
}

// ─── Format detection ─────────────────────────────────────────────────────────
const MAGIC = {
  '%PDF':      'pdf',
  'PK\x03\x04': 'zip', // DOCX / PPTX / XLSX are all ZIP-based OPC
};

function detectFormat(buffer) {
  const view = new Uint8Array(buffer, 0, 8);
  const head4 = String.fromCharCode(view[0], view[1], view[2], view[3]);

  if (head4 === '%PDF') return 'pdf';
  if (view[0] === 0x50 && view[1] === 0x4B) {
    // ZIP-based Office Open XML — distinguish by content-type
    return 'zip';
  }
  // D0 CF 11 E0 — legacy CFB (old .doc / .ppt / .xls)
  if (view[0] === 0xD0 && view[1] === 0xCF && view[2] === 0x11 && view[3] === 0xE0) {
    return 'cfb';
  }
  return 'unknown';
}

function extensionHint(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  const map = { pdf: 'pdf', docx: 'docx', doc: 'doc', pptx: 'pptx', ppt: 'ppt',
                 xlsx: 'xlsx', xls: 'xls', indd: 'indd' };
  return map[ext] || 'unknown';
}

// ─── Thumbnail canvas helper ──────────────────────────────────────────────────
const THUMB_W = 800;
const THUMB_H = 600;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width  = w;
  c.height = h;
  return c;
}

function placeholderCanvas(icon, line1, line2 = '') {
  const c = makeCanvas(THUMB_W, THUMB_H);
  const ctx = c.getContext('2d');
  // Background
  ctx.fillStyle = '#1e2230';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  // Icon
  ctx.font = '80px serif';
  ctx.textAlign = 'center';
  ctx.fillText(icon, THUMB_W / 2, THUMB_H / 2 - 40);
  // Lines
  ctx.fillStyle = '#9ca3af';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText(line1, THUMB_W / 2, THUMB_H / 2 + 40);
  if (line2) {
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText(line2, THUMB_W / 2, THUMB_H / 2 + 72);
  }
  return c;
}

function canvasToDataUrl(canvas) {
  return canvas.toDataURL('image/png');
}

// ─── PDF extractor ────────────────────────────────────────────────────────────
async function extractPdf(buffer, { onProgress, signal } = {}) {
  const pdfjsMod = await loadModule('pdfjs', CDN.pdfjs);
  const pdfjsLib = pdfjsMod.default || pdfjsMod;
  pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const results = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    if (signal?.aborted) break;
    onProgress?.({ current: i, total: pdf.numPages, label: `Rendering page ${i}` });

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = makeCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    results.push({
      dataUrl: canvasToDataUrl(canvas),
      label: `Page ${i}`,
      width: viewport.width,
      height: viewport.height,
    });
  }

  return results;
}

// ─── DOCX extractor ───────────────────────────────────────────────────────────
async function extractDocx(buffer, { onProgress, signal } = {}) {
  onProgress?.({ current: 0, total: 1, label: 'Preparing DOCX renderer…' });

  // Primary path: docx-preview provides layout-fidelity rendering.
  try {
    const thumbs = await renderDocxWithDocxPreview(buffer, { onProgress, signal });
    if (thumbs.length > 0) return thumbs;
  } catch (err) {
    console.warn('[doc-importer] docx-preview path failed, falling back to mammoth:', err);
  }

  // Fallback path: Mammoth semantic HTML conversion.
  await loadScript('mammoth', CDN.mammoth);
  const mammoth = window.mammoth;
  if (!mammoth) throw new Error('mammoth.js failed to initialize');

  onProgress?.({ current: 0, total: 1, label: 'Converting document…' });

  let html;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    html = result.value;
  } catch (err) {
    throw new Error(`DOCX conversion failed: ${err.message}`);
  }

  if (signal?.aborted) return [];
  onProgress?.({ current: 1, total: 1, label: 'Rendering pages…' });
  return renderHtmlToPageThumbnails(html, { onProgress, signal });
}

async function renderDocxWithDocxPreview(buffer, { onProgress, signal } = {}) {
  const RENDER_W = 794; // ~A4 96dpi width
  const PAGE_H = 1123;  // ~A4 96dpi height

  await loadScript('jszip', CDN.jszip);
  await loadScript('docxPreview', CDN.docxPreview);
  await loadScript('html2canvas', CDN.html2canvas);

  const docxPreview = window.docx;
  const html2canvas = window.html2canvas;
  if (!docxPreview?.renderAsync) {
    throw new Error('docx-preview failed to initialize');
  }
  if (!html2canvas) {
    throw new Error('html2canvas failed to initialize');
  }

  const host = document.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${RENDER_W}px`,
    'padding:0',
    'margin:0',
    'background:#fff',
    'color:#111',
    'z-index:-1'
  ].join(';');

  const viewport = document.createElement('div');
  viewport.style.cssText = [
    `width:${RENDER_W}px`,
    'min-height:1px',
    'background:#fff',
    'padding:0',
    'margin:0',
  ].join(';');
  host.appendChild(viewport);
  document.body.appendChild(host);

  try {
    onProgress?.({ current: 0, total: 1, label: 'Rendering DOCX layout…' });
    await docxPreview.renderAsync(buffer, viewport, null, {
      inWrapper: false,
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
    });

    // Allow layout and image decoding to settle.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const imgs = Array.from(viewport.querySelectorAll('img'));
    await Promise.all(imgs.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }));

    const fullHeight = Math.max(viewport.scrollHeight, PAGE_H);
    const pages = Math.max(1, Math.ceil(fullHeight / PAGE_H));
    const fullCanvas = await html2canvas(viewport, {
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      width: RENDER_W,
      height: fullHeight,
      windowWidth: RENDER_W,
      windowHeight: fullHeight,
      logging: false,
    });

    const results = [];
    for (let p = 0; p < pages; p++) {
      if (signal?.aborted) break;
      onProgress?.({ current: p + 1, total: pages, label: `Page ${p + 1} of ${pages}` });

      const pageCanvas = makeCanvas(RENDER_W, PAGE_H);
      const pageCtx = pageCanvas.getContext('2d');
      pageCtx.fillStyle = '#ffffff';
      pageCtx.fillRect(0, 0, RENDER_W, PAGE_H);
      pageCtx.drawImage(fullCanvas, 0, p * PAGE_H, RENDER_W, PAGE_H, 0, 0, RENDER_W, PAGE_H);

      results.push({
        dataUrl: canvasToDataUrl(pageCanvas),
        label: `Page ${p + 1}`,
        width: RENDER_W,
        height: PAGE_H,
      });
    }

    return results;
  } finally {
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}

async function renderHtmlToPageThumbnails(html, { onProgress, signal } = {}) {
  const RENDER_W = 794; // ~A4 96dpi width
  const PAGE_H   = 1123; // ~A4 96dpi height
  await loadScript('html2canvas', CDN.html2canvas);
  const html2canvas = window.html2canvas;
  if (!html2canvas) throw new Error('html2canvas failed to initialize');

  const host = document.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${RENDER_W}px`,
    'padding:0',
    'margin:0',
    'background:#fff',
    'color:#111',
    'z-index:-1',
    'visibility:hidden'
  ].join(';');

  host.innerHTML = `
    <style>
      .docx-preview-root, .docx-preview-root * { box-sizing: border-box; }
      .docx-preview-root {
        width: ${RENDER_W}px;
        min-height: ${PAGE_H}px;
        padding: 28px 36px;
        margin: 0;
        background: #fff;
        color: #111;
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.55;
      }
      .docx-preview-root p { margin: 0 0 0.7em; }
      .docx-preview-root h1, .docx-preview-root h2, .docx-preview-root h3,
      .docx-preview-root h4, .docx-preview-root h5, .docx-preview-root h6 {
        margin: 0.3em 0 0.45em;
        line-height: 1.25;
      }
      .docx-preview-root table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
      .docx-preview-root td, .docx-preview-root th { border: 1px solid #c7c7c7; padding: 4px 6px; }
      .docx-preview-root img { max-width: 100%; height: auto; }
      .docx-preview-root ul, .docx-preview-root ol { padding-left: 1.5em; margin: 0.4em 0; }
      .docx-preview-root blockquote {
        margin: 0.5em 0;
        padding: 0.4em 0.8em;
        border-left: 3px solid #d0d0d0;
        color: #333;
      }
    </style>
    <div class="docx-preview-root">${html}</div>
  `;

  document.body.appendChild(host);

  try {
    // Allow layout and image decode to settle before snapshotting.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    await new Promise(resolve => requestAnimationFrame(() => resolve()));

    const root = host.querySelector('.docx-preview-root');
    const fullHeight = Math.max(root?.scrollHeight || 0, PAGE_H);
    const pages = Math.max(1, Math.ceil(fullHeight / PAGE_H));

    onProgress?.({ current: 0, total: pages, label: 'Rasterizing document…' });

    const fullCanvas = await html2canvas(host, {
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      width: RENDER_W,
      height: fullHeight,
      windowWidth: RENDER_W,
      windowHeight: fullHeight,
      logging: false,
    });

    const results = [];
    for (let p = 0; p < pages; p++) {
      if (signal?.aborted) break;
      onProgress?.({ current: p + 1, total: pages, label: `Page ${p + 1} of ${pages}` });

      const pageCanvas = makeCanvas(RENDER_W, PAGE_H);
      const pageCtx = pageCanvas.getContext('2d');
      pageCtx.fillStyle = '#ffffff';
      pageCtx.fillRect(0, 0, RENDER_W, PAGE_H);
      pageCtx.drawImage(
        fullCanvas,
        0,
        p * PAGE_H,
        RENDER_W,
        PAGE_H,
        0,
        0,
        RENDER_W,
        PAGE_H
      );

      results.push({
        dataUrl: canvasToDataUrl(pageCanvas),
        label: `Page ${p + 1}`,
        width: RENDER_W,
        height: PAGE_H,
      });
    }

    return results;
  } finally {
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}

// ─── PPTX extractor ───────────────────────────────────────────────────────────
async function extractPptx(buffer, { onProgress, signal } = {}) {
  await loadScript('jszip', CDN.jszip);

  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip failed to initialize');

  const zip = await JSZip.loadAsync(buffer);

  // Get slide order from presentation.xml
  const presXmlStr = await zip.file('ppt/presentation.xml')?.async('text');
  if (!presXmlStr) throw new Error('Not a valid PPTX file (missing presentation.xml)');

  const parser = new DOMParser();
  const presXml = parser.parseFromString(presXmlStr, 'text/xml');

  // Get sldIdLst to determine slide count
  const slideIds = presXml.querySelectorAll('sldIdLst sldId');
  const slideCount = slideIds.length || 1;

  const results = [];

  for (let i = 1; i <= slideCount; i++) {
    if (signal?.aborted) break;
    onProgress?.({ current: i, total: slideCount, label: `Processing slide ${i}` });

    const slideKey = `ppt/slides/slide${i}.xml`;
    const slideFile = zip.file(slideKey);

    if (!slideFile) {
      results.push(renderPlaceholderSlide(i, slideCount, '(empty)'));
      continue;
    }

    const slideXml = parser.parseFromString(await slideFile.async('text'), 'text/xml');
    results.push(await renderSlideCanvas(slideXml, zip, i, slideCount));
  }

  return results;
}

async function renderSlideCanvas(slideXml, zip, slideNum, total) {
  const SLIDE_W = 960;
  const SLIDE_H = 540;
  const EMU_PER_IN = 914400;
  // Default 16:9 slide size in English Metric Units (if not present in package).
  const DEFAULT_CX = 12192000;
  const DEFAULT_CY = 6858000;

  const canvas = makeCanvas(SLIDE_W, SLIDE_H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);

  const parser = new DOMParser();

  const getChildrenByLocalName = (node, localName) => {
    if (!node) return [];
    return Array.from(node.getElementsByTagName('*')).filter(el => el.localName === localName);
  };

  const firstChildByLocalName = (node, localName) => {
    const list = getChildrenByLocalName(node, localName);
    return list.length ? list[0] : null;
  };

  const parseNum = (val, fallback = 0) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };

  // Determine declared slide size from presentation.xml when available.
  let slideCx = DEFAULT_CX;
  let slideCy = DEFAULT_CY;
  try {
    const presXmlStr = await zip.file('ppt/presentation.xml')?.async('text');
    if (presXmlStr) {
      const presXml = parser.parseFromString(presXmlStr, 'text/xml');
      const sldSz = firstChildByLocalName(presXml, 'sldSz');
      if (sldSz) {
        slideCx = parseNum(sldSz.getAttribute('cx'), DEFAULT_CX);
        slideCy = parseNum(sldSz.getAttribute('cy'), DEFAULT_CY);
      }
    }
  } catch {
    // Keep defaults.
  }

  const toPxX = emu => (parseNum(emu) / slideCx) * SLIDE_W;
  const toPxY = emu => (parseNum(emu) / slideCy) * SLIDE_H;

  // Try to render embedded images
  try {
    const relsKey = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
    const relsFile = zip.file(relsKey);
    const relsXmlStr = relsFile ? await relsFile.async('text') : '';
    const relsXml = parser.parseFromString(relsXmlStr, 'text/xml');

    // Build relationship map: rId → target path
    const relMap = {};
    getChildrenByLocalName(relsXml, 'Relationship').forEach(rel => {
      relMap[rel.getAttribute('Id')] = rel.getAttribute('Target');
    });

    // Draw images at shape coordinates.
    const picNodes = getChildrenByLocalName(slideXml, 'pic');
    let imgIndex = 0;
    for (const pic of picNodes) {
      const blip = firstChildByLocalName(pic, 'blip');
      if (!blip) continue;

      const rId = blip.getAttribute('r:embed') || blip.getAttribute('embed') ||
        blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      if (!rId) continue;

      const relTarget = relMap[rId];
      if (!relTarget) continue;

      // Resolve path relative to ppt/slides/
      const imgPath = relTarget.startsWith('../')
        ? 'ppt/' + relTarget.slice(3)
        : 'ppt/slides/' + relTarget;

      const imgFile = zip.file(imgPath);
      if (!imgFile) continue;

      const xfrm = firstChildByLocalName(pic, 'xfrm');
      const off = firstChildByLocalName(xfrm, 'off');
      const extNode = firstChildByLocalName(xfrm, 'ext');
      const shapeX = off ? toPxX(off.getAttribute('x')) : 0;
      const shapeY = off ? toPxY(off.getAttribute('y')) : 0;
      const shapeW = Math.max(8, extNode ? toPxX(extNode.getAttribute('cx')) : SLIDE_W / 2);
      const shapeH = Math.max(8, extNode ? toPxY(extNode.getAttribute('cy')) : SLIDE_H / 2);

      const imgBytes = await imgFile.async('uint8array');
      const ext = imgPath.split('.').pop().toLowerCase();
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                        gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp' };
      const mime = mimeMap[ext] || 'image/png';
      const blob = new Blob([imgBytes], { type: mime });
      const url = URL.createObjectURL(blob);

      await new Promise(res => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(shapeW / img.width, shapeH / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          const dx = shapeX + (shapeW - dw) / 2;
          const dy = shapeY + (shapeH - dh) / 2;
          ctx.drawImage(img, dx, dy, dw, dh);
          URL.revokeObjectURL(url);
          imgIndex++;
          res();
        };
        img.onerror = () => { URL.revokeObjectURL(url); res(); };
        img.src = url;
      });
    }
  } catch {
    // Image extraction failed — text fallback below
  }

  // Draw text content in each shape region.
  const shapeNodes = getChildrenByLocalName(slideXml, 'sp');
  for (const shape of shapeNodes) {
    const txBody = firstChildByLocalName(shape, 'txBody');
    if (!txBody) continue;

    const textRuns = getChildrenByLocalName(txBody, 't')
      .map(n => (n.textContent || '').trim())
      .filter(Boolean);
    if (!textRuns.length) continue;

    const xfrm = firstChildByLocalName(shape, 'xfrm');
    const off = firstChildByLocalName(xfrm, 'off');
    const ext = firstChildByLocalName(xfrm, 'ext');

    const x = off ? toPxX(off.getAttribute('x')) : 24;
    const y = off ? toPxY(off.getAttribute('y')) : 24;
    const w = Math.max(40, ext ? toPxX(ext.getAttribute('cx')) : SLIDE_W - 48);
    const h = Math.max(20, ext ? toPxY(ext.getAttribute('cy')) : 80);

    // Optional subtle text region background for readability.
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = '#1a1a1a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const isLikelyTitle = y < SLIDE_H * 0.28;
    const fontSize = isLikelyTitle ? 22 : 14;
    const lineHeight = isLikelyTitle ? 28 : 18;
    ctx.font = `${isLikelyTitle ? '600' : '400'} ${fontSize}px system-ui, sans-serif`;

    let drawY = y + 6;
    const maxY = y + h - lineHeight;
    const maxW = w - 12;
    const words = textRuns.join(' ').split(/\s+/);
    let line = '';

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxW) {
        line = test;
        continue;
      }
      if (line) {
        ctx.fillText(line, x + 6, drawY);
        drawY += lineHeight;
      }
      line = word;
      if (drawY > maxY) break;
    }
    if (line && drawY <= maxY) {
      ctx.fillText(line, x + 6, drawY);
    }
  }

  // Slide number badge
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(SLIDE_W - 70, 12, 54, 26, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${slideNum} / ${total}`, SLIDE_W - 43, 30);

  return {
    dataUrl: canvasToDataUrl(canvas),
    label: `Slide ${slideNum}`,
    width: SLIDE_W,
    height: SLIDE_H,
  };
}

function renderPlaceholderSlide(slideNum, total) {
  const c = placeholderCanvas('🖼️', `Slide ${slideNum}`, 'Could not parse slide content');
  return { dataUrl: canvasToDataUrl(c), label: `Slide ${slideNum}`, width: THUMB_W, height: THUMB_H };
}

// ─── XLSX extractor ───────────────────────────────────────────────────────────
async function extractXlsx(buffer, { onProgress, signal } = {}) {
  await loadScript('xlsx', CDN.xlsx);

  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS failed to initialize');

  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const sheetNames = workbook.SheetNames;
  const results = [];

  for (let i = 0; i < sheetNames.length; i++) {
    if (signal?.aborted) break;
    const name = sheetNames[i];
    onProgress?.({ current: i + 1, total: sheetNames.length, label: `Rendering sheet: ${name}` });

    const sheet = workbook.Sheets[name];
    results.push(renderSheetCanvas(sheet, name, i + 1));
  }

  return results;
}

function renderSheetCanvas(sheet, sheetName, sheetNum) {
  const SHEET_W = 960;
  const SHEET_H = 640;
  const XLSX = window.XLSX;

  const canvas = makeCanvas(SHEET_W, SHEET_H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);

  // Header bar
  ctx.fillStyle = '#1d6f42';
  ctx.fillRect(0, 0, SHEET_W, 40);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`📊  ${sheetName}`, 16, 26);

  // Grid lines base
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const maxRow = Math.min(range.e.r, 30);
  const maxCol = Math.min(range.e.c, 14);

  const COL_W = Math.min(Math.floor((SHEET_W - 60) / (maxCol + 1)), 100);
  const ROW_H = 22;
  const HEADER_H = 40;
  const ROW_LABEL_W = 40;

  // Column headers (A, B, C…)
  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(ROW_LABEL_W, HEADER_H, SHEET_W - ROW_LABEL_W, ROW_H);
  ctx.fillStyle = '#495057';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let c = 0; c <= maxCol; c++) {
    const colLetter = XLSX.utils.encode_col(range.s.c + c);
    const x = ROW_LABEL_W + c * COL_W + COL_W / 2;
    ctx.fillText(colLetter, x, HEADER_H + ROW_H - 6);
  }

  // Row data
  for (let r = range.s.r; r <= maxRow; r++) {
    const rowIdx = r - range.s.r;
    const y = HEADER_H + ROW_H + rowIdx * ROW_H;
    if (y + ROW_H > SHEET_H - 20) break;

    // Alternating row stripe
    ctx.fillStyle = rowIdx % 2 === 0 ? '#ffffff' : '#f8f9fa';
    ctx.fillRect(ROW_LABEL_W, y, SHEET_W - ROW_LABEL_W, ROW_H);

    // Row label
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(0, y, ROW_LABEL_W, ROW_H);
    ctx.fillStyle = '#6c757d';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(r + 1), ROW_LABEL_W / 2, y + ROW_H - 6);

    // Cells
    for (let c = range.s.c; c <= maxCol + range.s.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      if (!cell) continue;

      let val = cell.w ?? String(cell.v ?? '');
      if (val.length > 18) val = val.slice(0, 17) + '…';

      const colIdx = c - range.s.c;
      const x = ROW_LABEL_W + colIdx * COL_W + 4;

      // Type-based colour hint
      if (cell.t === 'n') ctx.fillStyle = '#1864ab';
      else if (cell.t === 'b') ctx.fillStyle = '#2f9e44';
      else ctx.fillStyle = '#212529';

      ctx.font = '10px system-ui, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(val, x, y + ROW_H - 6);
    }
  }

  // Grid lines
  ctx.strokeStyle = '#dee2e6';
  ctx.lineWidth = 0.5;
  for (let r = 0; r <= maxRow - range.s.r + 1; r++) {
    const y = HEADER_H + ROW_H + r * ROW_H;
    if (y > SHEET_H - 20) break;
    ctx.beginPath();
    ctx.moveTo(ROW_LABEL_W, y);
    ctx.lineTo(SHEET_W, y);
    ctx.stroke();
  }
  for (let c = 0; c <= maxCol - range.s.c + 1; c++) {
    const x = ROW_LABEL_W + c * COL_W;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_H);
    ctx.lineTo(x, SHEET_H - 20);
    ctx.stroke();
  }

  // Truncation notice
  if (maxRow < range.e.r || maxCol < range.e.c) {
    ctx.fillStyle = '#868e96';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Preview shows first ${maxRow + 1} rows × ${maxCol + 1} cols`, 16, SHEET_H - 6);
  }

  return {
    dataUrl: canvasToDataUrl(canvas),
    label: `Sheet: ${sheetName}`,
    width: SHEET_W,
    height: SHEET_H,
  };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────
/**
 * @param {File} file
 * @param {{ onProgress?: Function, signal?: AbortSignal }} opts
 * @returns {Promise<Array<{dataUrl:string, label:string, width:number, height:number}>>}
 */
export async function extractDocumentThumbnails(file, opts = {}) {
  const { onProgress, signal } = opts;
  const arrayBuffer = await file.arrayBuffer();
  const magic = detectFormat(arrayBuffer);
  const ext = extensionHint(file.name);

  // INDD — no client-side parser exists
  if (ext === 'indd') {
    throw Object.assign(new Error('INDD_UNSUPPORTED'), { code: 'INDD_UNSUPPORTED' });
  }

  // PDF
  if (magic === 'pdf') {
    return extractPdf(arrayBuffer, { onProgress, signal });
  }

  // ZIP-based (DOCX / PPTX / XLSX)
  if (magic === 'zip') {
    if (ext === 'xlsx' || ext === 'xls') {
      return extractXlsx(arrayBuffer, { onProgress, signal });
    }
    if (ext === 'pptx' || ext === 'ppt') {
      return extractPptx(arrayBuffer, { onProgress, signal });
    }
    if (ext === 'docx' || ext === 'doc') {
      return extractDocx(arrayBuffer, { onProgress, signal });
    }
    // Try ZIP sniff by content-types
    await loadScript('jszip', CDN.jszip);
    const JSZip = window.JSZip;
    const zip = await JSZip.loadAsync(arrayBuffer);
    const ct = zip.file('[Content_Types].xml');
    if (ct) {
      const ctStr = await ct.async('text');
      if (ctStr.includes('spreadsheetml')) return extractXlsx(arrayBuffer, { onProgress, signal });
      if (ctStr.includes('presentationml')) return extractPptx(arrayBuffer, { onProgress, signal });
      if (ctStr.includes('wordprocessingml')) return extractDocx(arrayBuffer, { onProgress, signal });
    }
    throw new Error(`Could not determine Office format for: ${file.name}`);
  }

  // Legacy CFB (.doc / .ppt / .xls) — no reliable JS parser
  if (magic === 'cfb') {
    throw Object.assign(
      new Error(`Legacy binary format (.${ext}) is not supported for preview. Please save as .docx, .pptx, or .xlsx and re-import.`),
      { code: 'CFB_UNSUPPORTED' }
    );
  }

  throw new Error(`Unsupported document format: ${file.name}`);
}

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.xlsx'];
export const UNSUPPORTED_EXTENSIONS = ['.indd', '.doc', '.ppt', '.xls'];
export const ALL_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.doc,.ppt,.xls,.indd';
