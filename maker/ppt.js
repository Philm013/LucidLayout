export const pptState = {
  slides: []
};

export function renderPreview() {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('pptPreviewContainer');
  if (!container) return;
}

// slide structure: { objects: [] }
// object structure: { type: 'text'|'shape'|'image'|'chart'|'media', ...options }

export function addSlide(options = {}) {
  const slide = { objects: [] };
  pptState.slides.push(slide);
  renderPreview();
  return pptState.slides.length - 1; // return slideId/index
}

export function addText(slideIndex, text, options = {}) {
  if (slideIndex < 0 || slideIndex >= pptState.slides.length) throw new Error("Invalid slide index");
  pptState.slides[slideIndex].objects.push({ type: 'text', text, options });
  renderPreview();
  return true;
}

export function addShape(slideIndex, shapeName, options = {}) {
  if (slideIndex < 0 || slideIndex >= pptState.slides.length) throw new Error("Invalid slide index");
  pptState.slides[slideIndex].objects.push({ type: 'shape', shapeName, options });
  renderPreview();
  return true;
}

export function addImage(slideIndex, options = {}) {
  if (slideIndex < 0 || slideIndex >= pptState.slides.length) throw new Error("Invalid slide index");
  pptState.slides[slideIndex].objects.push({ type: 'image', options });
  renderPreview();
  return true;
}

export function addChart(slideIndex, chartType, data, options = {}) {
  if (slideIndex < 0 || slideIndex >= pptState.slides.length) throw new Error("Invalid slide index");
  pptState.slides[slideIndex].objects.push({ type: 'chart', chartType, data, options });
  renderPreview();
  return true;
}

export function addMedia(slideIndex, options = {}) {
  if (slideIndex < 0 || slideIndex >= pptState.slides.length) throw new Error("Invalid slide index");
  pptState.slides[slideIndex].objects.push({ type: 'media', options });
  renderPreview();
  return true;
}

export function getPresentationState() {
  return pptState;
}

export async function exportPPT() {
  if (typeof PptxGenJS === 'undefined') {
    alert("PptxGenJS is not loaded!");
    return;
  }
  let pres = new PptxGenJS();
  for (const s of pptState.slides) {
    let slide = pres.addSlide();
    for (const obj of s.objects) {
      try {
        if (obj.type === 'text') slide.addText(obj.text, obj.options);
        else if (obj.type === 'shape') {
            const shapeObj = pres.ShapeType[obj.shapeName] || pres.ShapeType.rect;
            slide.addShape(shapeObj, obj.options);
        }
        else if (obj.type === 'image') slide.addImage(obj.options);
        else if (obj.type === 'chart') {
            const chartObj = pres.ChartType[obj.chartType] || pres.ChartType.bar;
            slide.addChart(chartObj, obj.data, obj.options);
        }
        else if (obj.type === 'media') slide.addMedia(obj.options);
      } catch (err) {
        console.error("Error adding object to slide", obj, err);
      }
    }
  }
  await pres.writeFile({ fileName: 'Presentation.pptx' });
}

function cleanHex(colorStr, defaultHex = 'FFFFFF') {
  if (!colorStr || colorStr === 'transparent' || colorStr === 'unset') return defaultHex;
  let hex = String(colorStr).replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return defaultHex;
  return hex.toUpperCase();
}

export async function exportLayoutToPPT(pagesOrSections, fileName = "LayoutMaker-Presentation.pptx", options = {}) {
  if (typeof PptxGenJS === 'undefined') {
    alert("PptxGenJS library is not loaded. Please wait or check your internet connection.");
    return;
  }
  if (!pagesOrSections || pagesOrSections.length === 0) {
    if (typeof showToast === 'function') showToast("Canvas is empty. Add pages, sections, or elements first.");
    return;
  }

  const pres = new PptxGenJS();
  const globalSlideSize = options.slideSize || 'dynamic';

  const pageList = (pagesOrSections[0] && Array.isArray(pagesOrSections[0].sections)) 
    ? pagesOrSections 
    : [{ id: 'p1', title: 'Page 1', sections: pagesOrSections, preset: globalSlideSize }];

  let slideCounter = 0;

  pageList.forEach((page, pIdx) => {
    const pageSections = page.sections || [];
    const presetKey = page.preset || globalSlideSize || '16:9';
    let slideW = 13.33;
    let slideH = 7.5;

    if (presetKey === '4:3') {
      slideW = 10.0; slideH = 7.5;
    } else if (presetKey === '16:9-portrait') {
      slideW = 7.5; slideH = 13.33;
    } else if (presetKey === 'letter-portrait') {
      slideW = 8.5; slideH = 11.0;
    } else if (presetKey === 'letter-landscape') {
      slideW = 11.0; slideH = 8.5;
    } else if (presetKey === 'a4-portrait') {
      slideW = 8.27; slideH = 11.69;
    } else if (presetKey === 'a4-landscape') {
      slideW = 11.69; slideH = 8.27;
    } else if (page.widthPx && page.heightPx && page.heightPx !== 'auto') {
      slideW = Number((page.widthPx / 96).toFixed(2));
      slideH = Number((page.heightPx / 96).toFixed(2));
    } else {
      slideW = 13.33; slideH = 7.5; // 16:9 widescreen default
    }

    const MARGIN_X = 0.5;
    const USABLE_W = slideW - (MARGIN_X * 2);

    if (pageSections.length === 0) {
      slideCounter++;
      const layoutName = `LAYOUT_PAGE_EMPTY_${pIdx}_${Date.now()}`;
      pres.defineLayout({ name: layoutName, width: slideW, height: slideH });
      pres.layout = layoutName;
      const slide = pres.addSlide();
      const bgHex = cleanHex(page.bg, 'FFFFFF');
      if (bgHex) slide.background = { fill: bgHex };
      return;
    }

    pageSections.forEach((sec, sIdx) => {
      slideCounter++;

      // 2D Grid Track Allocation Solver for 12-column layout
      const gridOccupancy = []; // gridOccupancy[row][col] = boolean

      const isSlotFree = (r, c, cSpan, rSpan) => {
        for (let ri = r; ri < r + rSpan; ri++) {
          if (!gridOccupancy[ri]) gridOccupancy[ri] = new Array(12).fill(false);
          for (let ci = c; ci < c + cSpan; ci++) {
            if (ci >= 12 || gridOccupancy[ri][ci]) return false;
          }
        }
        return true;
      };

      const occupySlot = (r, c, cSpan, rSpan) => {
        for (let ri = r; ri < r + rSpan; ri++) {
          if (!gridOccupancy[ri]) gridOccupancy[ri] = new Array(12).fill(false);
          for (let ci = c; ci < c + cSpan; ci++) {
            gridOccupancy[ri][ci] = true;
          }
        }
      };

      const findFreeGridPosition = (cSpan, rSpan) => {
        let r = 0;
        while (true) {
          if (!gridOccupancy[r]) gridOccupancy[r] = new Array(12).fill(false);
          for (let c = 0; c <= 12 - cSpan; c++) {
            if (isSlotFree(r, c, cSpan, rSpan)) {
              return { row: r, col: c };
            }
          }
          r++;
        }
      };

      const items = [];
      let maxOccupiedRow = 0;
      const ROW_UNIT_HEIGHT = 0.65;
      const ROW_GAP = 0.15;
      const TOP_OFFSET = 0.5;

      (sec.elements || []).forEach((el) => {
        const colSpan = Math.min(12, Math.max(1, el.colSpan || 12));
        const rowSpan = Math.max(1, el.rowSpan || 1);

        const { row, col } = findFreeGridPosition(colSpan, rowSpan);
        occupySlot(row, col, colSpan, rowSpan);

        maxOccupiedRow = Math.max(maxOccupiedRow, row + rowSpan);

        const elX = MARGIN_X + (col * (USABLE_W / 12));
        const elW = (colSpan * (USABLE_W / 12)) - 0.1;
        const elY = TOP_OFFSET + (row * (ROW_UNIT_HEIGHT + ROW_GAP));
        const elH = (rowSpan * ROW_UNIT_HEIGHT) + ((rowSpan - 1) * ROW_GAP);

        items.push({ el, elX, elY, elW, elH });
      });

      let finalSlideHeight = slideH;
      if (globalSlideSize === 'dynamic' || presetKey === 'ever-expanding') {
        finalSlideHeight = Math.max(slideH, Math.ceil((TOP_OFFSET + (maxOccupiedRow * (ROW_UNIT_HEIGHT + ROW_GAP)) + 0.5) * 10) / 10);
      }
      const layoutName = `LAYOUT_P_${pIdx}_S_${sIdx}_${Date.now()}`;
      pres.defineLayout({ name: layoutName, width: slideW, height: finalSlideHeight });
      pres.layout = layoutName;

      const slide = pres.addSlide();
      const bgHex = cleanHex(sec.bg || page.bg, 'FFFFFF');
      if (sec.hasBackground !== false && bgHex) {
        slide.background = { fill: bgHex };
      }

    items.forEach(({ el, elX, elY, elW, elH }) => {
      const fillHex = cleanHex(el.fill);
      const textHex = cleanHex(el.textColor, '0F172A');
      const borderHex = (el.hasBorder === true) ? cleanHex(el.borderColor, 'CBD5E1') : null;
      const lineProp = borderHex ? { color: borderHex, width: 1 } : undefined;

      if (el.type === 'heading' || el.type === 'subheading' || el.type === 'bodyText') {
        const isHeading = el.type === 'heading' || el.type === 'subheading';
        const fontSize = el.fontSize || (el.type === 'heading' ? 24 : el.type === 'subheading' ? 18 : 13);
        
        if (fillHex || lineProp) {
          slide.addShape(pres.ShapeType.rect, {
            x: elX, y: elY, w: elW, h: elH,
            fill: fillHex ? { color: fillHex } : undefined,
            line: lineProp
          });
        }
        slide.addText(el.text || '', {
          x: elX + 0.05, y: elY + 0.05, w: elW - 0.1, h: elH - 0.1,
          fontSize,
          bold: isHeading,
          color: textHex,
          align: 'left',
          valign: isHeading ? 'middle' : 'top',
          wrap: true
        });
      } else if (el.type === 'callout') {
        slide.addShape(pres.ShapeType.roundRect, {
          x: elX, y: elY, w: elW, h: elH,
          fill: { color: fillHex || 'F8FAFC' },
          line: lineProp || undefined,
          rectRadius: 0.1
        });
        slide.addText(el.text || '', {
          x: elX + 0.1, y: elY + 0.1, w: elW - 0.2, h: elH - 0.2,
          fontSize: el.fontSize || 13,
          color: textHex || '1E293B',
          align: 'left',
          valign: 'top',
          wrap: true
        });
      } else if (el.type === 'badge') {
        const badgePillText = el.badgeText || el.text || '[Badge]';
        const badgeBody = el.badgeBody || '';
        const pillW = Math.min(2.5, elW * 0.35);

        slide.addShape(pres.ShapeType.roundRect, {
          x: elX, y: elY, w: pillW, h: 0.35,
          fill: { color: cleanHex(el.badgeFill, '1C324A') },
          rectRadius: 0.15
        });
        slide.addText(badgePillText, {
          x: elX, y: elY, w: pillW, h: 0.35,
          fontSize: 10, bold: true, color: cleanHex(el.badgeTextColor, 'FFFFFF'),
          align: 'center', valign: 'middle'
        });

        if (badgeBody) {
          slide.addText(badgeBody, {
            x: elX + pillW + 0.1, y: elY, w: elW - pillW - 0.1, h: elH,
            fontSize: el.fontSize || 12, color: textHex || '1E293B',
            align: 'left', valign: 'top', wrap: true
          });
        }
      } else if (el.type === 'accordion') {
        const title = el.accordionTitle || 'Topic';
        const body = el.accordionBody || '';

        slide.addShape(pres.ShapeType.rect, {
          x: elX, y: elY, w: elW, h: 0.4,
          fill: { color: fillHex || 'E2E8F0' },
          line: lineProp
        });
        slide.addText(`${el.expanded ? '▼' : '►'} ${title}`, {
          x: elX + 0.1, y: elY, w: elW - 0.2, h: 0.4,
          fontSize: 13, bold: true, color: cleanHex(el.headerTextColor, 'FFFFFF'),
          align: 'left', valign: 'middle'
        });

        if (el.expanded && body) {
          slide.addShape(pres.ShapeType.rect, {
            x: elX, y: elY + 0.4, w: elW, h: Math.max(0.4, elH - 0.4),
            fill: { color: 'F8FAFC' },
            line: lineProp || undefined
          });
          slide.addText(body, {
            x: elX + 0.1, y: elY + 0.45, w: elW - 0.2, h: Math.max(0.3, elH - 0.5),
            fontSize: el.fontSize || 12, color: textHex || '1E293B',
            align: 'left', valign: 'top', wrap: true
          });
        }
      } else if (el.type === 'dataTable') {
        const tableLines = (el.tableBody || el.text || '').split('\n').filter(Boolean);
        const tableRows = tableLines.map((line, idx) => {
          const cells = line.split('|').map(c => c.trim());
          return cells.map(cellText => ({
            text: cellText,
            options: {
              bold: idx === 0,
              fontSize: 11,
              color: idx === 0 ? 'FFFFFF' : '0F172A',
              fill: idx === 0 ? '1E293B' : (idx % 2 === 1 ? 'F8FAFC' : 'FFFFFF'),
              align: 'left',
              valign: 'middle'
            }
          }));
        });

        if (tableRows.length > 0) {
          slide.addTable(tableRows, {
            x: elX, y: elY, w: elW, h: elH,
            border: lineProp ? { pt: 1, color: borderHex } : undefined
          });
        }
      } else if (el.type === 'icon') {
        const iconColor = cleanHex(el.iconColor, '2563EB');
        const iconName = el.iconName || 'lucide:star';
        if (fillHex || lineProp) {
          slide.addShape(pres.ShapeType.rect, {
            x: elX, y: elY, w: elW, h: elH,
            fill: fillHex ? { color: fillHex } : undefined,
            line: lineProp
          });
        }
        slide.addText(`★ [${iconName}]`, {
          x: elX, y: elY, w: elW, h: elH,
          fontSize: Math.min(36, Math.max(16, el.iconSize || 28)),
          bold: true,
          color: iconColor,
          align: el.align || 'center',
          valign: 'middle'
        });
      } else if (el.type === 'imageCard' || el.type === 'graph') {
        const mediaHeight = Math.max(0.4, el.showCaption !== false && el.text ? elH - 0.35 : elH);
        if (el.imageUrl) {
          try {
            slide.addImage({
              path: el.imageUrl,
              x: elX, y: elY, w: elW, h: mediaHeight
            });
          } catch(err) {
            slide.addShape(pres.ShapeType.rect, {
              x: elX, y: elY, w: elW, h: mediaHeight,
              fill: { color: fillHex || 'E2E8F0' },
              line: lineProp
            });
            slide.addText(`[Image: ${el.imageUrl}]`, {
              x: elX, y: elY, w: elW, h: mediaHeight,
              fontSize: 12, color: '64748B', align: 'center', valign: 'middle'
            });
          }
        } else {
          slide.addShape(pres.ShapeType.rect, {
            x: elX, y: elY, w: elW, h: mediaHeight,
            fill: { color: fillHex || 'E2E8F0' },
            line: lineProp
          });
          slide.addText(`[${el.type === 'graph' ? 'Chart / Graph' : 'Image Placeholder'}]`, {
            x: elX, y: elY, w: elW, h: mediaHeight,
            fontSize: 14, bold: true, color: '64748B',
            align: 'center', valign: 'middle'
          });
        }

        if (el.showCaption !== false && el.text) {
          slide.addText(el.text, {
            x: elX, y: elY + mediaHeight, w: elW, h: 0.35,
            fontSize: 11, color: textHex || '475569',
            align: el.captionAlign || 'left', valign: 'middle'
          });
        }
      }
    });
  });
});

  await pres.writeFile({ fileName });
}

if (typeof window !== 'undefined') {
  window.PPT = {
    pptState, addSlide, addText, addShape, addImage, addChart, addMedia,
    getPresentationState, exportPPT, exportLayoutToPPT, renderPreview
  };
}

