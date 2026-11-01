/* ============================================================================
 * FILE 3: canvas-engine.js (QuickPrint Kiosk Pro V2.0)
 * Interactive A4 Canvas, Text & Whiteout Tool, Safe Print Margin (5mm),
 * 5 Smart Layouts, Passport Maker, 2-Step Locked Cropper & Dual Signature
 * ============================================================================ */

(function () {
  "use strict";

  // ==================== 1. PAPER SIZE DEFINITIONS (150 DPI HIGH-RES) ====================
  const PAPER_SPECS = {
    "a4-portrait": {
      width: 1240,
      height: 1754,
      safeMarginPx: 30, // ~5mm at 150 DPI
      cssClass: "paper-a4-portrait",
      label: "A4 Portrait (210×297 mm)",
      pdfFormat: "a4",
      pdfOrientation: "portrait"
    },
    "a4-landscape": {
      width: 1754,
      height: 1240,
      safeMarginPx: 30,
      cssClass: "paper-a4-landscape",
      label: "A4 Landscape (297×210 mm)",
      pdfFormat: "a4",
      pdfOrientation: "landscape"
    },
    "4x6": {
      width: 1200,
      height: 1800,
      safeMarginPx: 28,
      cssClass: "paper-4x6",
      label: "4×6 Photo Paper (102×152 mm)",
      pdfFormat: [102, 152],
      pdfOrientation: "portrait"
    },
    "legal": {
      width: 1275,
      height: 2100,
      safeMarginPx: 30,
      cssClass: "paper-legal",
      label: "Legal Size (216×356 mm)",
      pdfFormat: "legal",
      pdfOrientation: "portrait"
    }
  };

  // ==================== 2. GLOBAL KIOSK STATE ====================
  window.KioskState = {
    token: "01",
    customerName: "",
    paperSize: "a4-portrait",
    activeLayout: "id-vertical",
    colorMode: "color", // 'color' | 'bw'
    copies: 1,
    safeMarginEnabled: true,
    isPageLocked: false,
    currentPageIndex: 0,
    passportConfig: {
      count: 6,
      nameText: "",
      dateText: ""
    },
    slots: {
      front: { rawSrc: null, croppedSrc: null },
      back: { rawSrc: null, croppedSrc: null }
    },
    pages: [
      { id: "page_1", items: [] }
    ]
  };

  // Internal runtime state
  const imageCache = new Map();
  let selectedItemId = null;
  let editingTextItemId = null; // Tracks if user is editing an existing text/whiteout item
  let dragAction = null; // null | 'move' | 'nw' | 'ne' | 'se' | 'sw'
  let dragStartPointer = { x: 0, y: 0 };
  let dragStartItemBox = { x: 0, y: 0, w: 0, h: 0, scale: 100 };
  let showCenterGuideX = false;
  let showCenterGuideY = false;

  // Cropper & Camera runtime variables
  let cropperInstance = null;
  let activeCropContext = null; // { target, itemId, rawSrc, customCallback }
  let activeCameraTarget = null; // 'front' | 'back' | 'signature'
  let activeCameraStream = null;

  // Signature Pad & Paper Signature runtime variables
  let sigPadDrawing = false;
  let sigPenColor = "#0f172a";
  let rawPaperSignatureImg = null;
  let processedPaperSignatureDataUrl = null;

  // DOM Elements cache
  let canvas, ctx;

  // ==================== 3. IMAGE CACHE & HELPERS ====================
  function getLoadedImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      if (imageCache.has(src)) {
        const cached = imageCache.get(src);
        if (cached.complete) return resolve(cached);
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imageCache.set(src, img);
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function triggerStateSave() {
    if (typeof window.scheduleAutoSave === "function") {
      window.scheduleAutoSave();
    }
  }

  function getCurrentPage() {
    const pages = window.KioskState.pages;
    if (!pages || pages.length === 0) {
      window.KioskState.pages = [{ id: "page_1", items: [] }];
      window.KioskState.currentPageIndex = 0;
    }
    if (window.KioskState.currentPageIndex >= window.KioskState.pages.length) {
      window.KioskState.currentPageIndex = window.KioskState.pages.length - 1;
    }
    return window.KioskState.pages[window.KioskState.currentPageIndex];
  }

  function getSelectedItem() {
    const page = getCurrentPage();
    if (!selectedItemId) return null;
    return page.items.find((it) => it.id === selectedItemId) || null;
  }

  function clampItemToSafeMargin(item, spec) {
    if (!window.KioskState.safeMarginEnabled) return;
    const m = spec.safeMarginPx || 30;
    const maxW = spec.width - m * 2;
    const maxH = spec.height - m * 2;
    if (item.w > maxW) item.w = maxW;
    if (item.h > maxH) item.h = maxH;
    if (item.x < m) item.x = m;
    if (item.y < m) item.y = m;
    if (item.x + item.w > spec.width - m) item.x = spec.width - m - item.w;
    if (item.y + item.h > spec.height - m) item.y = spec.height - m - item.h;
  }

  // ==================== 4. RENDER LIVE CANVAS & CLEAN PAGE EXPORT ====================
  async function renderCanvas() {
    if (!canvas || !ctx) return;
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];

    if (canvas.width !== spec.width || canvas.height !== spec.height) {
      canvas.width = spec.width;
      canvas.height = spec.height;
    }

    const page = getCurrentPage();
    await drawPageOnContext(ctx, spec.width, spec.height, page, {
      isInteractive: true,
      selectedId: window.KioskState.isPageLocked ? null : selectedItemId,
      guideX: showCenterGuideX,
      guideY: showCenterGuideY,
      colorMode: window.KioskState.colorMode,
      safeMarginPx: window.KioskState.safeMarginEnabled ? spec.safeMarginPx : 0
    });

    updateSelectedItemUI();
    updatePageNavigationUI();
  }

  async function drawPageOnContext(targetCtx, width, height, page, options) {
    // 1. Clean White Paper Background
    targetCtx.save();
    targetCtx.fillStyle = "#ffffff";
    targetCtx.fillRect(0, 0, width, height);

    // 2. Draw all items on page
    for (const item of page.items) {
      const img = await getLoadedImage(item.src);
      if (!img) continue;

      targetCtx.save();

      const b = item.brightness || 100;
      const c = item.contrast || 100;
      const gray = options.colorMode === "bw" ? "grayscale(100%) " : "";
      targetCtx.filter = `${gray}brightness(${b}%) contrast(${c}%)`;

      const centerX = item.x + item.w / 2;
      const centerY = item.y + item.h / 2;

      targetCtx.translate(centerX, centerY);
      targetCtx.rotate(((item.rotation || 0) * Math.PI) / 180);

      targetCtx.drawImage(img, -item.w / 2, -item.h / 2, item.w, item.h);

      targetCtx.filter = "none";

      // NO-BORDER RULE: Only draw black border if item.hasBorder is explicitly checked
      if (item.hasBorder === true) {
        targetCtx.strokeStyle = "#000000";
        targetCtx.lineWidth = 3;
        targetCtx.strokeRect(-item.w / 2, -item.h / 2, item.w, item.h);
      }

      targetCtx.restore();
    }

    // 3. Safe Print Margin (5mm) Visual Guide on Interactive Canvas
    if (options.isInteractive && options.safeMarginPx > 0) {
      const m = options.safeMarginPx;
      targetCtx.save();
      targetCtx.strokeStyle = "rgba(16, 185, 129, 0.55)";
      targetCtx.lineWidth = 2;
      targetCtx.setLineDash([10, 8]);
      targetCtx.strokeRect(m, m, width - m * 2, height - m * 2);
      targetCtx.setLineDash([]);
      targetCtx.restore();
    }

    // 4. Red Center Alignment Grid Lines when dragging/centering
    if (options.isInteractive && (options.guideX || options.guideY)) {
      targetCtx.save();
      targetCtx.strokeStyle = "#ef4444";
      targetCtx.lineWidth = 3;
      targetCtx.setLineDash([12, 8]);

      if (options.guideX) {
        targetCtx.beginPath();
        targetCtx.moveTo(width / 2, 0);
        targetCtx.lineTo(width / 2, height);
        targetCtx.stroke();
      }
      if (options.guideY) {
        targetCtx.beginPath();
        targetCtx.moveTo(0, height / 2);
        targetCtx.lineTo(width, height / 2);
        targetCtx.stroke();
      }
      targetCtx.restore();
    }

    // 5. Selection Box & 4 Large Blue Corner Resize Handles
    if (options.isInteractive && options.selectedId) {
      const sel = page.items.find((it) => it.id === options.selectedId);
      if (sel) {
        targetCtx.save();
        targetCtx.strokeStyle = "#2563eb";
        targetCtx.lineWidth = 4;
        targetCtx.setLineDash([8, 6]);
        targetCtx.strokeRect(sel.x, sel.y, sel.w, sel.h);
        targetCtx.setLineDash([]);

        const handleRadius = 22;
        const corners = [
          { x: sel.x, y: sel.y },
          { x: sel.x + sel.w, y: sel.y },
          { x: sel.x + sel.w, y: sel.y + sel.h },
          { x: sel.x, y: sel.y + sel.h }
        ];

        corners.forEach((pt) => {
          targetCtx.beginPath();
          targetCtx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
          targetCtx.fillStyle = "#2563eb";
          targetCtx.fill();
          targetCtx.lineWidth = 5;
          targetCtx.strokeStyle = "#ffffff";
          targetCtx.stroke();
        });

        targetCtx.restore();
      }
    }

    targetCtx.restore();
  }

  async function renderCleanPageToDataURL(pageIndex, mimeType = "image/jpeg", quality = 0.95) {
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const page = window.KioskState.pages[pageIndex] || getCurrentPage();
    const offCanvas = document.createElement("canvas");
    offCanvas.width = spec.width;
    offCanvas.height = spec.height;
    const offCtx = offCanvas.getContext("2d");

    await drawPageOnContext(offCtx, spec.width, spec.height, page, {
      isInteractive: false,
      selectedId: null,
      guideX: false,
      guideY: false,
      colorMode: window.KioskState.colorMode,
      safeMarginPx: 0
    });

    // If Safe Margin is enabled, ensure clean white 5mm border so printer edges never clip
    if (window.KioskState.safeMarginEnabled && spec.safeMarginPx > 0) {
      const m = spec.safeMarginPx;
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, spec.width, m);
      offCtx.fillRect(0, spec.height - m, spec.width, m);
      offCtx.fillRect(0, 0, m, spec.height);
      offCtx.fillRect(spec.width - m, 0, m, spec.height);
    }

    return offCanvas.toDataURL(mimeType, quality);
  }

  // ==================== 5. 5 SMART DOCUMENT LAYOUTS & PASSPORT MAKER ====================
  async function applySmartLayout(layoutName) {
    // Normalize legacy layout names if loaded from older token state
    if (layoutName === "aadhaar-vertical") layoutName = "id-vertical";
    if (layoutName === "aadhaar-horizontal") layoutName = "id-horizontal";

    window.KioskState.activeLayout = layoutName;

    document.querySelectorAll(".layout-btn").forEach((btn) => {
      if (btn.dataset.layout === layoutName) {
        btn.classList.add("active-layout", "border-indigo-600", "bg-indigo-50", "text-indigo-950");
        btn.classList.remove("border-slate-200", "bg-slate-50", "text-slate-800");
      } else {
        btn.classList.remove("active-layout", "border-indigo-600", "bg-indigo-50", "text-indigo-950");
        btn.classList.add("border-slate-200", "bg-slate-50", "text-slate-800");
      }
    });

    const ppPanel = document.getElementById("passportMakerPanel");
    if (ppPanel) {
      ppPanel.classList.toggle("hidden", layoutName !== "passport");
    }

    if (layoutName === "passport") {
      await window.applyPassportLayout();
      return;
    }

    const page = getCurrentPage();
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const PW = spec.width;
    const PH = spec.height;
    const margin = window.KioskState.safeMarginEnabled ? spec.safeMarginPx + 18 : 48;

    page.items = page.items.filter((it) => it.type !== "passport-tile");

    const frontItem = page.items.find((it) => it.type === "front");
    const backItem = page.items.find((it) => it.type === "back");

    if (layoutName === "id-vertical") {
      const cardW = Math.round(PW * 0.56);
      const cardH = Math.round(cardW * 0.63);
      if (frontItem) {
        setItemDimensions(frontItem, Math.round((PW - cardW) / 2), Math.round(PH * 0.10), cardW, cardH);
      }
      if (backItem) {
        setItemDimensions(backItem, Math.round((PW - cardW) / 2), Math.round(PH * 0.10) + cardH + 90, cardW, cardH);
      }
    } else if (layoutName === "id-horizontal") {
      const gap = 44;
      const cardW = Math.round((PW - margin * 2 - gap) / 2);
      const cardH = Math.round(cardW * 0.63);
      const topY = Math.round(PH * 0.14);
      if (frontItem) {
        setItemDimensions(frontItem, margin, topY, cardW, cardH);
      }
      if (backItem) {
        setItemDimensions(backItem, margin + cardW + gap, topY, cardW, cardH);
      }
    } else if (layoutName === "passbook") {
      const pbW = Math.round(PW * 0.86);
      const pbH = Math.round(PH * 0.40);
      if (frontItem) {
        setItemDimensions(frontItem, Math.round((PW - pbW) / 2), Math.round(PH * 0.06), pbW, pbH);
      }
      if (backItem) {
        setItemDimensions(backItem, Math.round((PW - pbW) / 2), Math.round(PH * 0.51), pbW, pbH);
      }
    } else if (layoutName === "full-a4") {
      const fullW = PW - margin * 2;
      const fullH = PH - margin * 2;
      if (frontItem && !backItem) {
        setItemDimensions(frontItem, margin, margin, fullW, fullH);
      } else if (frontItem && backItem) {
        const halfH = Math.round((fullH - 36) / 2);
        setItemDimensions(frontItem, margin, margin, fullW, halfH);
        setItemDimensions(backItem, margin, margin + halfH + 36, fullW, halfH);
      }
    }

    await renderCanvas();
    triggerStateSave();
  }

  function setItemDimensions(item, x, y, w, h) {
    item.x = x;
    item.y = y;
    item.w = w;
    item.h = h;
    item.baseW = w;
    item.baseH = h;
    item.scale = 100;
  }

  window.setPassportCount = function (count) {
    window.KioskState.passportConfig.count = count;
    [6, 8, 12].forEach((n) => {
      const btn = document.getElementById("ppCount" + n);
      if (!btn) return;
      if (n === count) {
        btn.className = "pp-count-btn bg-indigo-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow";
      } else {
        btn.className = "pp-count-btn bg-white text-indigo-900 border border-indigo-300 font-bold text-xs px-3 py-1.5 rounded-lg";
      }
    });
    window.applyPassportLayout();
  };

  window.applyPassportLayout = async function () {
    const frontSrc = window.KioskState.slots.front.croppedSrc;
    if (!frontSrc) {
      alert("पासपोर्ट साइज़ फोटो बनाने के लिए पहले 'स्टेप 1: पहली फोटो (Front)' में अपनी फोटो अपलोड करें!");
      return;
    }

    const nameInput = document.getElementById("passportTextName");
    const dateInput = document.getElementById("passportTextDate");
    const nameText = nameInput ? nameInput.value.trim() : "";
    const dateText = dateInput ? dateInput.value.trim() : "";

    window.KioskState.passportConfig.nameText = nameText;
    window.KioskState.passportConfig.dateText = dateText;

    const tileDataUrl = await buildPassportTileDataURL(frontSrc, nameText, dateText);
    const page = getCurrentPage();
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const PW = spec.width;

    page.items = page.items.filter((it) => it.type === "signature" || it.type === "extra" || it.type === "text");

    const count = window.KioskState.passportConfig.count || 6;
    const cols = count === 8 ? 4 : 6;
    const gapX = 24;
    const gapY = 30;
    const marginX = 60;
    const startY = 70;

    const tileW = Math.floor((PW - marginX * 2 - gapX * (cols - 1)) / cols);
    const tileH = Math.round(tileW * (45 / 35));

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = marginX + c * (tileW + gapX);
      const y = startY + r * (tileH + gapY);

      page.items.push({
        id: "pp_tile_" + Date.now() + "_" + i,
        type: "passport-tile",
        label: `पासपोर्ट फोटो #${i + 1}`,
        rawSrc: window.KioskState.slots.front.rawSrc || frontSrc,
        src: tileDataUrl,
        x,
        y,
        w: tileW,
        h: tileH,
        baseW: tileW,
        baseH: tileH,
        scale: 100,
        rotation: 0,
        hasBorder: false,
        brightness: 100,
        contrast: 100
      });
    }

    if (page.items.length > 0) {
      selectedItemId = page.items[0].id;
    }

    await renderCanvas();
    triggerStateSave();
  };

  async function buildPassportTileDataURL(photoSrc, nameText, dateText) {
    const img = await getLoadedImage(photoSrc);
    if (!img) return photoSrc;

    const W = 413;
    const H = 531;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const tCtx = c.getContext("2d");

    tCtx.fillStyle = "#ffffff";
    tCtx.fillRect(0, 0, W, H);
    tCtx.drawImage(img, 0, 0, W, H);

    if (nameText || dateText) {
      const stripH = nameText && dateText ? 86 : 50;
      tCtx.fillStyle = "#ffffff";
      tCtx.fillRect(0, H - stripH, W, stripH);

      tCtx.fillStyle = "#000000";
      tCtx.textAlign = "center";
      tCtx.textBaseline = "middle";

      if (nameText && dateText) {
        tCtx.font = "bold 24px Arial, sans-serif";
        tCtx.fillText(nameText.toUpperCase(), W / 2, H - stripH + 25);
        tCtx.font = "bold 21px Arial, sans-serif";
        tCtx.fillText(dateText, W / 2, H - stripH + 62);
      } else {
        tCtx.font = "bold 25px Arial, sans-serif";
        tCtx.fillText((nameText || dateText).toUpperCase(), W / 2, H - stripH / 2);
      }
    }

    return c.toDataURL("image/jpeg", 0.95);
  }

  // ==================== 6. TEXT EDIT & WHITEOUT ERASER TOOL ====================
  function createTextStripDataURL(config) {
    const text = (config.text || "").trim();
    const color = config.color || "#000000";
    const bgMode = config.bgMode || "whiteout"; // 'whiteout' | 'transparent'
    const isBold = config.isBold !== false;

    const tempCanvas = document.createElement("canvas");
    const tCtx = tempCanvas.getContext("2d");

    // If empty text and whiteout selected -> pure whiteout patch to cover unwanted PDF/photo text!
    if (!text) {
      tempCanvas.width = 420;
      tempCanvas.height = 110;
      tCtx.fillStyle = "#ffffff";
      tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      return tempCanvas.toDataURL("image/png");
    }

    const lines = text.split("\n");
    const fontSize = 44;
    const fontStr = `${isBold ? "bold " : ""}${fontSize}px "Noto Sans Devanagari", Arial, sans-serif`;
    tCtx.font = fontStr;

    let maxLineW = 140;
    lines.forEach((line) => {
      const m = tCtx.measureText(line);
      if (m.width > maxLineW) maxLineW = m.width;
    });

    const padX = 32;
    const padY = 22;
    const lineHeight = Math.round(fontSize * 1.32);

    tempCanvas.width = Math.ceil(maxLineW + padX * 2);
    tempCanvas.height = Math.ceil(lines.length * lineHeight + padY * 2);

    if (bgMode === "whiteout") {
      tCtx.fillStyle = "#ffffff";
      tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    } else {
      tCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    }

    tCtx.font = fontStr;
    tCtx.fillStyle = color;
    tCtx.textBaseline = "top";

    lines.forEach((line, idx) => {
      tCtx.fillText(line, padX, padY + idx * lineHeight);
    });

    return tempCanvas.toDataURL("image/png");
  }

  function openTextModalForNew() {
    editingTextItemId = null;
    document.getElementById("customTextInput").value = "";
    document.getElementById("customTextColorSelect").value = "#000000";
    document.getElementById("customTextBgSelect").value = "whiteout";
    document.getElementById("customTextBoldCheckbox").checked = true;
    document.getElementById("textToolModal").classList.remove("hidden");
  }

  function openTextModalForEdit(item) {
    if (!item || item.type !== "text") return;
    editingTextItemId = item.id;
    const cfg = item.textConfig || {};
    document.getElementById("customTextInput").value = cfg.text || "";
    document.getElementById("customTextColorSelect").value = cfg.color || "#000000";
    document.getElementById("customTextBgSelect").value = cfg.bgMode || "whiteout";
    document.getElementById("customTextBoldCheckbox").checked = cfg.isBold !== false;
    document.getElementById("textToolModal").classList.remove("hidden");
  }

  async function saveTextToolToCanvas() {
    const textVal = document.getElementById("customTextInput").value;
    const colorVal = document.getElementById("customTextColorSelect").value;
    const bgVal = document.getElementById("customTextBgSelect").value;
    const boldVal = document.getElementById("customTextBoldCheckbox").checked;

    if (!textVal.trim() && bgVal === "transparent") {
      alert("कृपया कुछ टेक्स्ट लिखें या पीछे 'सफेद पट्टी (Whiteout)' चुनें!");
      return;
    }

    const textConfig = {
      text: textVal,
      color: colorVal,
      bgMode: bgVal,
      isBold: boldVal
    };

    const dataUrl = createTextStripDataURL(textConfig);
    const img = await getLoadedImage(dataUrl);
    const page = getCurrentPage();
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];

    if (editingTextItemId) {
      const existing = page.items.find((it) => it.id === editingTextItemId);
      if (existing) {
        existing.src = dataUrl;
        existing.rawSrc = dataUrl;
        existing.textConfig = textConfig;
        existing.label = textVal.trim() ? `टेक्स्ट: "${textVal.trim().slice(0, 14)}"` : "सफेद पट्टी (Whiteout)";
        if (img) {
          const aspect = img.height / Math.max(1, img.width);
          existing.h = Math.round(existing.w * aspect);
        }
        selectedItemId = existing.id;
      }
    } else {
      const w = img ? Math.min(Math.round(spec.width * 0.55), img.width) : 320;
      const h = img ? Math.round(w * (img.height / Math.max(1, img.width))) : 90;
      const newItem = {
        id: "text_" + Date.now(),
        type: "text",
        label: textVal.trim() ? `टेक्स्ट: "${textVal.trim().slice(0, 14)}"` : "सफेद पट्टी (Whiteout)",
        textConfig,
        rawSrc: dataUrl,
        src: dataUrl,
        x: Math.round((spec.width - w) / 2),
        y: Math.round(spec.height * 0.45),
        w,
        h,
        baseW: w,
        baseH: h,
        scale: 100,
        rotation: 0,
        hasBorder: false,
        brightness: 100,
        contrast: 100
      };
      page.items.push(newItem);
      selectedItemId = newItem.id;
    }

    editingTextItemId = null;
    document.getElementById("textToolModal").classList.add("hidden");
    await renderCanvas();
    triggerStateSave();
  }

  // ==================== 7. CANVAS TOUCH & MOUSE DRAG / RESIZE ENGINE ====================
  function getCanvasPointerCoords(evt) {
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function hitTestCornerHandle(item, px, py) {
    const hitRadius = 38;
    const corners = [
      { name: "nw", x: item.x, y: item.y },
      { name: "ne", x: item.x + item.w, y: item.y },
      { name: "se", x: item.x + item.w, y: item.y + item.h },
      { name: "sw", x: item.x, y: item.y + item.h }
    ];
    for (const c of corners) {
      if (Math.hypot(px - c.x, py - c.y) <= hitRadius) return c.name;
    }
    return null;
  }

  function onPointerDown(evt) {
    if (window.KioskState.isPageLocked) return;

    const pt = getCanvasPointerCoords(evt);
    const page = getCurrentPage();

    const currentSel = getSelectedItem();
    if (currentSel) {
      const corner = hitTestCornerHandle(currentSel, pt.x, pt.y);
      if (corner) {
        if (evt.cancelable) evt.preventDefault();
        dragAction = corner;
        dragStartPointer = pt;
        dragStartItemBox = {
          x: currentSel.x,
          y: currentSel.y,
          w: currentSel.w,
          h: currentSel.h
        };
        return;
      }
    }

    let foundItem = null;
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (pt.x >= it.x && pt.x <= it.x + it.w && pt.y >= it.y && pt.y <= it.y + it.h) {
        foundItem = it;
        break;
      }
    }

    if (foundItem) {
      if (evt.cancelable) evt.preventDefault();
      selectedItemId = foundItem.id;
      page.items = page.items.filter((it) => it.id !== foundItem.id);
      page.items.push(foundItem);

      dragAction = "move";
      dragStartPointer = pt;
      dragStartItemBox = {
        x: foundItem.x,
        y: foundItem.y,
        w: foundItem.w,
        h: foundItem.h
      };
      renderCanvas();
    } else {
      selectedItemId = null;
      dragAction = null;
      renderCanvas();
    }
  }

  function onPointerMove(evt) {
    if (!dragAction || window.KioskState.isPageLocked) return;
    const sel = getSelectedItem();
    if (!sel) return;

    if (evt.cancelable) evt.preventDefault();
    const pt = getCanvasPointerCoords(evt);
    const dx = pt.x - dragStartPointer.x;
    const dy = pt.y - dragStartPointer.y;

    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const PW = spec.width;
    const PH = spec.height;

    showCenterGuideX = false;
    showCenterGuideY = false;

    if (dragAction === "move") {
      let newX = dragStartItemBox.x + dx;
      let newY = dragStartItemBox.y + dy;

      const itemCenterX = newX + sel.w / 2;
      const itemCenterY = newY + sel.h / 2;
      const snapThreshold = 18;

      if (Math.abs(itemCenterX - PW / 2) < snapThreshold) {
        newX = PW / 2 - sel.w / 2;
        showCenterGuideX = true;
      }
      if (Math.abs(itemCenterY - PH / 2) < snapThreshold) {
        newY = PH / 2 - sel.h / 2;
        showCenterGuideY = true;
      }

      sel.x = Math.round(newX);
      sel.y = Math.round(newY);
      clampItemToSafeMargin(sel, spec);
    } else {
      const aspect = dragStartItemBox.w / Math.max(1, dragStartItemBox.h);
      let newW = dragStartItemBox.w;
      let newH = dragStartItemBox.h;
      let newX = dragStartItemBox.x;
      let newY = dragStartItemBox.y;

      if (dragAction === "se") {
        newW = Math.max(60, dragStartItemBox.w + dx);
        newH = newW / aspect;
      } else if (dragAction === "sw") {
        newW = Math.max(60, dragStartItemBox.w - dx);
        newH = newW / aspect;
        newX = dragStartItemBox.x + (dragStartItemBox.w - newW);
      } else if (dragAction === "ne") {
        newW = Math.max(60, dragStartItemBox.w + dx);
        newH = newW / aspect;
        newY = dragStartItemBox.y + (dragStartItemBox.h - newH);
      } else if (dragAction === "nw") {
        newW = Math.max(60, dragStartItemBox.w - dx);
        newH = newW / aspect;
        newX = dragStartItemBox.x + (dragStartItemBox.w - newW);
        newY = dragStartItemBox.y + (dragStartItemBox.h - newH);
      }

      sel.x = Math.round(newX);
      sel.y = Math.round(newY);
      sel.w = Math.round(newW);
      sel.h = Math.round(newH);

      if (sel.baseW) {
        sel.scale = Math.min(250, Math.max(15, Math.round((sel.w / sel.baseW) * 100)));
      }
    }

    renderCanvas();
  }

  function onPointerUp() {
    if (dragAction) {
      dragAction = null;
      showCenterGuideX = false;
      showCenterGuideY = false;
      renderCanvas();
      triggerStateSave();
    }
  }

  // ==================== 8. 2-STEP LOCKED CROPPER MODAL ====================
  function openLockedCropper(context) {
    activeCropContext = context;
    const modal = document.getElementById("cropModal");
    const imgEl = document.getElementById("cropperTargetImage");
    if (!modal || !imgEl) return;

    if (cropperInstance) {
      cropperInstance.destroy();
      cropperInstance = null;
    }

    modal.classList.remove("hidden");
    imgEl.src = context.rawSrc;

    imgEl.onload = function () {
      if (cropperInstance) cropperInstance.destroy();

      cropperInstance = new Cropper(imgEl, {
        viewMode: 1,
        dragMode: "none",
        movable: false,
        zoomable: false,
        zoomOnTouch: false,
        zoomOnWheel: false,
        rotatable: true,
        scalable: false,
        guides: true,
        center: true,
        highlight: true,
        background: true,
        autoCropArea: 0.88,
        responsive: true,
        toggleDragModeOnDblclick: false
      });
    };
  }

  function closeLockedCropper() {
    const modal = document.getElementById("cropModal");
    if (modal) modal.classList.add("hidden");
    if (cropperInstance) {
      cropperInstance.destroy();
      cropperInstance = null;
    }
    activeCropContext = null;
  }

  async function applyCropAndPlace() {
    if (!cropperInstance || !activeCropContext) return;

    const croppedCanvas = cropperInstance.getCroppedCanvas({
      maxWidth: 1800,
      maxHeight: 1800,
      fillColor: activeCropContext.target === "signature" ? "transparent" : "#ffffff"
    });

    if (!croppedCanvas) return;

    const mime = activeCropContext.target === "signature" ? "image/png" : "image/jpeg";
    const croppedDataUrl = croppedCanvas.toDataURL(mime, 0.93);
    const ctxInfo = { ...activeCropContext };

    closeLockedCropper();

    // If opened by PDF Studio with a custom callback, return the cropped image to PDF Studio
    if (typeof ctxInfo.customCallback === "function") {
      await ctxInfo.customCallback(croppedDataUrl);
      return;
    }

    if (ctxInfo.target === "signature") {
      await loadPaperSignatureForRemoval(croppedDataUrl);
      return;
    }

    if (ctxInfo.target === "recrop-item" && ctxInfo.itemId) {
      const page = getCurrentPage();
      const item = page.items.find((it) => it.id === ctxInfo.itemId);
      if (item) {
        const img = await getLoadedImage(croppedDataUrl);
        item.src = croppedDataUrl;
        if (img) {
          const aspect = img.height / Math.max(1, img.width);
          item.h = Math.round(item.w * aspect);
          item.baseW = item.w;
          item.baseH = item.h;
          item.scale = 100;
        }
        if (item.type === "front") window.KioskState.slots.front.croppedSrc = croppedDataUrl;
        if (item.type === "back") window.KioskState.slots.back.croppedSrc = croppedDataUrl;
        updateSlotThumbnailsUI();
        await renderCanvas();
        triggerStateSave();
      }
      return;
    }

    await addOrUpdatePhotoOnPage(ctxInfo.target, ctxInfo.rawSrc, croppedDataUrl);
  }

  async function addOrUpdatePhotoOnPage(slotType, rawSrc, croppedSrc) {
    const page = getCurrentPage();
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const PW = spec.width;
    const PH = spec.height;
    const img = await getLoadedImage(croppedSrc);
    const aspect = img ? img.height / Math.max(1, img.width) : 0.63;

    if (slotType === "front" || slotType === "back") {
      window.KioskState.slots[slotType] = { rawSrc, croppedSrc };
      updateSlotThumbnailsUI();

      let existing = page.items.find((it) => it.type === slotType);
      const cardW = Math.round(PW * 0.56);
      const cardH = Math.round(cardW * aspect);
      const defaultX = Math.round((PW - cardW) / 2);
      const defaultY = slotType === "front" ? Math.round(PH * 0.10) : Math.round(PH * 0.52);

      if (existing) {
        existing.rawSrc = rawSrc;
        existing.src = croppedSrc;
        existing.w = cardW;
        existing.h = cardH;
        existing.baseW = cardW;
        existing.baseH = cardH;
        existing.scale = 100;
        selectedItemId = existing.id;
      } else {
        const newItem = {
          id: slotType + "_" + Date.now(),
          type: slotType,
          label: slotType === "front" ? "पहली फोटो (Front)" : "दूसरी फोटो (Back)",
          rawSrc,
          src: croppedSrc,
          x: defaultX,
          y: defaultY,
          w: cardW,
          h: cardH,
          baseW: cardW,
          baseH: cardH,
          scale: 100,
          rotation: 0,
          hasBorder: false,
          brightness: 100,
          contrast: 100
        };
        page.items.push(newItem);
        selectedItemId = newItem.id;
      }

      if (window.KioskState.activeLayout !== "passport") {
        await applySmartLayout(window.KioskState.activeLayout);
      } else {
        await window.applyPassportLayout();
      }
    } else if (slotType === "extra") {
      const w = Math.round(PW * 0.48);
      const h = Math.round(w * aspect);
      const newItem = {
        id: "extra_" + Date.now(),
        type: "extra",
        label: "अतिरिक्त फोटो (Extra)",
        rawSrc,
        src: croppedSrc,
        x: Math.round((PW - w) / 2),
        y: Math.round((PH - h) / 2),
        w,
        h,
        baseW: w,
        baseH: h,
        scale: 100,
        rotation: 0,
        hasBorder: false,
        brightness: 100,
        contrast: 100
      };
      page.items.push(newItem);
      selectedItemId = newItem.id;
      await renderCanvas();
      triggerStateSave();
    }
  }

  // ==================== 9. PDF STUDIO IMPORT HELPERS ====================
  // 1. Import Selected PDF Pages as Full A4 Pages
  async function addPdfPagesAsFullA4(pageDataUrls) {
    if (!pageDataUrls || !pageDataUrls.length) return;
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const margin = window.KioskState.safeMarginEnabled ? spec.safeMarginPx : 0;
    const targetW = spec.width - margin * 2;
    const targetH = spec.height - margin * 2;

    // If current page is completely empty, use it for the first PDF page; otherwise append new pages
    const currPage = getCurrentPage();
    let startOnCurrent = currPage.items.length === 0;

    for (let i = 0; i < pageDataUrls.length; i++) {
      const src = pageDataUrls[i];
      const itemObj = {
        id: "pdf_page_" + Date.now() + "_" + i,
        type: "extra",
        label: `PDF पेज #${i + 1}`,
        rawSrc: src,
        src: src,
        x: margin,
        y: margin,
        w: targetW,
        h: targetH,
        baseW: targetW,
        baseH: targetH,
        scale: 100,
        rotation: 0,
        hasBorder: false,
        brightness: 100,
        contrast: 100
      };

      if (i === 0 && startOnCurrent) {
        currPage.items.push(itemObj);
        selectedItemId = itemObj.id;
      } else {
        window.KioskState.pages.push({
          id: "page_" + Date.now() + "_" + i,
          items: [itemObj]
        });
        window.KioskState.currentPageIndex = window.KioskState.pages.length - 1;
        selectedItemId = itemObj.id;
      }
    }

    await renderCanvas();
    triggerStateSave();
  }

  // 2. Import 2 PDF Pages on 1 A4 Sheet (2-in-1 Micro Notes Mode)
  async function addPdfPagesTwoInOne(pageDataUrls) {
    if (!pageDataUrls || !pageDataUrls.length) return;
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const margin = window.KioskState.safeMarginEnabled ? spec.safeMarginPx + 10 : 36;
    const gap = 28;
    const boxW = spec.width - margin * 2;
    const boxH = Math.floor((spec.height - margin * 2 - gap) / 2);

    const currPage = getCurrentPage();
    let useCurrent = currPage.items.length === 0;

    for (let i = 0; i < pageDataUrls.length; i += 2) {
      const topSrc = pageDataUrls[i];
      const bottomSrc = pageDataUrls[i + 1] || null;
      const itemsForSheet = [];

      itemsForSheet.push({
        id: "pdf_2in1_top_" + Date.now() + "_" + i,
        type: "extra",
        label: `PDF (2-in-1) पेज #${i + 1}`,
        rawSrc: topSrc,
        src: topSrc,
        x: margin,
        y: margin,
        w: boxW,
        h: boxH,
        baseW: boxW,
        baseH: boxH,
        scale: 100,
        rotation: 0,
        hasBorder: true,
        brightness: 100,
        contrast: 100
      });

      if (bottomSrc) {
        itemsForSheet.push({
          id: "pdf_2in1_bot_" + Date.now() + "_" + i,
          type: "extra",
          label: `PDF (2-in-1) पेज #${i + 2}`,
          rawSrc: bottomSrc,
          src: bottomSrc,
          x: margin,
          y: margin + boxH + gap,
          w: boxW,
          h: boxH,
          baseW: boxW,
          baseH: boxH,
          scale: 100,
          rotation: 0,
          hasBorder: true,
          brightness: 100,
          contrast: 100
        });
      }

      if (i === 0 && useCurrent) {
        currPage.items.push(...itemsForSheet);
        selectedItemId = itemsForSheet[0].id;
      } else {
        window.KioskState.pages.push({
          id: "page_2in1_" + Date.now() + "_" + i,
          items: itemsForSheet
        });
        window.KioskState.currentPageIndex = window.KioskState.pages.length - 1;
        selectedItemId = itemsForSheet[0].id;
      }
    }

    await renderCanvas();
    triggerStateSave();
  }

  // 3. Place Auto-Cut Government ID Card (Front + Back) directly into Front/Back Slots
  async function addAutoCutIdCardsToCanvas(frontCardUrl, backCardUrl) {
    if (frontCardUrl) {
      await addOrUpdatePhotoOnPage("front", frontCardUrl, frontCardUrl);
    }
    if (backCardUrl) {
      await addOrUpdatePhotoOnPage("back", backCardUrl, backCardUrl);
    }
    await applySmartLayout("id-horizontal");
  }

  // ==================== 10. SLOT THUMBNAILS, CAMERA & SIGNATURE ====================
  function updateSlotThumbnailsUI() {
    ["front", "back"].forEach((slot) => {
      const data = window.KioskState.slots[slot];
      const box = document.getElementById(slot + "ThumbBox");
      const img = document.getElementById(slot + "ThumbImg");
      const badge = document.getElementById(slot + "StatusBadge");

      if (data && data.croppedSrc) {
        if (box) box.classList.remove("hidden");
        if (img) img.src = data.croppedSrc;
        if (badge) {
          badge.textContent = "अपलोड हो गया ✅";
          badge.className = "text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800";
        }
      } else {
        if (box) box.classList.add("hidden");
        if (img) img.src = "";
        if (badge) {
          badge.textContent = slot === "front" ? "अपलोड नहीं है" : "वैकल्पिक";
          badge.className = "text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500";
        }
      }
    });
  }

  window.recropSlot = function (slot) {
    const data = window.KioskState.slots[slot];
    if (!data || !data.rawSrc) return;
    openLockedCropper({ target: slot, rawSrc: data.rawSrc });
  };

  window.removeSlotPhoto = async function (slot) {
    window.KioskState.slots[slot] = { rawSrc: null, croppedSrc: null };
    const page = getCurrentPage();
    page.items = page.items.filter((it) => it.type !== slot);
    if (slot === "front") {
      page.items = page.items.filter((it) => it.type !== "passport-tile");
    }
    selectedItemId = page.items.length ? page.items[page.items.length - 1].id : null;
    updateSlotThumbnailsUI();
    await renderCanvas();
    triggerStateSave();
  };

  window.openDirectCamera = async function (targetType) {
    activeCameraTarget = targetType;
    const modal = document.getElementById("liveCameraModal");
    const video = document.getElementById("liveCameraVideo");

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        activeCameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        video.srcObject = activeCameraStream;
        modal.classList.remove("hidden");
        return;
      } catch (err) {
        console.warn("WebRTC Rear Camera unavailable, using fallback:", err);
      }
    }

    if (targetType === "front") document.getElementById("frontCameraFallbackInput").click();
    else if (targetType === "back") document.getElementById("backCameraFallbackInput").click();
    else if (targetType === "signature") document.getElementById("paperSigCameraFallbackInput").click();
  };

  function closeDirectCamera() {
    const modal = document.getElementById("liveCameraModal");
    const video = document.getElementById("liveCameraVideo");
    if (modal) modal.classList.add("hidden");
    if (activeCameraStream) {
      activeCameraStream.getTracks().forEach((t) => t.stop());
      activeCameraStream = null;
    }
    if (video) video.srcObject = null;
  }

  function captureFromLiveCamera() {
    const video = document.getElementById("liveCameraVideo");
    if (!video || !video.videoWidth) return;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    tempCanvas.getContext("2d").drawImage(video, 0, 0);

    const dataUrl = tempCanvas.toDataURL("image/jpeg", 0.92);
    const target = activeCameraTarget || "front";
    closeDirectCamera();
    openLockedCropper({ target, rawSrc: dataUrl });
  }

  function initSignatureSystem() {
    const sigCanvas = document.getElementById("signaturePadCanvas");
    if (!sigCanvas) return;
    const sCtx = sigCanvas.getContext("2d");

    function getSigCoords(e) {
      const r = sigCanvas.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: (cx - r.left) * (sigCanvas.width / r.width),
        y: (cy - r.top) * (sigCanvas.height / r.height)
      };
    }

    function startDraw(e) {
      if (e.cancelable) e.preventDefault();
      sigPadDrawing = true;
      const p = getSigCoords(e);
      sCtx.beginPath();
      sCtx.moveTo(p.x, p.y);
    }

    function moveDraw(e) {
      if (!sigPadDrawing) return;
      if (e.cancelable) e.preventDefault();
      const p = getSigCoords(e);
      sCtx.lineWidth = 4.2;
      sCtx.lineCap = "round";
      sCtx.lineJoin = "round";
      sCtx.strokeStyle = sigPenColor;
      sCtx.lineTo(p.x, p.y);
      sCtx.stroke();
    }

    function endDraw() {
      sigPadDrawing = false;
    }

    sigCanvas.addEventListener("mousedown", startDraw);
    sigCanvas.addEventListener("mousemove", moveDraw);
    window.addEventListener("mouseup", endDraw);
    sigCanvas.addEventListener("touchstart", startDraw, { passive: false });
    sigCanvas.addEventListener("touchmove", moveDraw, { passive: false });
    sigCanvas.addEventListener("touchend", endDraw);

    document.getElementById("clearSigPadBtn").addEventListener("click", () => {
      sCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    });

    document.getElementById("addDrawnSigToPageBtn").addEventListener("click", async () => {
      const trimmedDataUrl = trimTransparentCanvas(sigCanvas);
      if (!trimmedDataUrl) {
        alert("कृपया पहले बॉक्स में उंगली से अपना साइन करें!");
        return;
      }
      await insertSignatureOnPage(trimmedDataUrl);
      sCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
      document.getElementById("signatureModal").classList.add("hidden");
    });

    const inkSlider = document.getElementById("sigInkDarknessSlider");
    if (inkSlider) {
      inkSlider.addEventListener("input", () => {
        document.getElementById("sigInkSliderValue").textContent = inkSlider.value + "%";
        processPaperSignatureThreshold(Number(inkSlider.value));
      });
    }

    document.getElementById("addPaperSigToPageBtn").addEventListener("click", async () => {
      if (!processedPaperSignatureDataUrl) return;
      await insertSignatureOnPage(processedPaperSignatureDataUrl);
      document.getElementById("signatureModal").classList.add("hidden");
    });
  }

  window.setSigPenColor = function (color) {
    sigPenColor = color;
  };

  async function loadPaperSignatureForRemoval(croppedDataUrl) {
    const sigModal = document.getElementById("signatureModal");
    if (sigModal) sigModal.classList.remove("hidden");
    document.getElementById("tabPaperSignBtn").click();
    document.getElementById("paperSigProcessBox").classList.remove("hidden");

    rawPaperSignatureImg = await getLoadedImage(croppedDataUrl);
    const sliderVal = Number(document.getElementById("sigInkDarknessSlider").value || 55);
    processPaperSignatureThreshold(sliderVal);
  }

  function processPaperSignatureThreshold(darknessPercent) {
    if (!rawPaperSignatureImg) return;
    const prevCanvas = document.getElementById("processedSigPreviewCanvas");
    if (!prevCanvas) return;

    const w = rawPaperSignatureImg.width;
    const h = rawPaperSignatureImg.height;
    prevCanvas.width = w;
    prevCanvas.height = h;
    const pCtx = prevCanvas.getContext("2d");
    pCtx.drawImage(rawPaperSignatureImg, 0, 0, w, h);

    const imgData = pCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const threshold = Math.round(80 + (darknessPercent / 100) * 150);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      if (lum > threshold) {
        data[i + 3] = 0;
      } else {
        const darkenFactor = Math.max(0, (lum / threshold) * 0.45);
        data[i] = Math.round(r * darkenFactor);
        data[i + 1] = Math.round(g * darkenFactor);
        data[i + 2] = Math.round(b * darkenFactor);
        data[i + 3] = 255;
      }
    }

    pCtx.putImageData(imgData, 0, 0);
    processedPaperSignatureDataUrl = trimTransparentCanvas(prevCanvas) || prevCanvas.toDataURL("image/png");
  }

  function trimTransparentCanvas(sourceCanvas) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const pixels = sourceCanvas.getContext("2d").getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = 0, maxY = 0;
    let hasInk = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (pixels[(y * w + x) * 4 + 3] > 20) {
          hasInk = true;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!hasInk) return null;

    const pad = 12;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);

    const cutW = Math.max(1, maxX - minX + 1);
    const cutH = Math.max(1, maxY - minY + 1);

    const out = document.createElement("canvas");
    out.width = cutW;
    out.height = cutH;
    out.getContext("2d").drawImage(sourceCanvas, minX, minY, cutW, cutH, 0, 0, cutW, cutH);
    return out.toDataURL("image/png");
  }

  async function insertSignatureOnPage(sigDataUrl) {
    const page = getCurrentPage();
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const img = await getLoadedImage(sigDataUrl);
    const aspect = img ? img.height / Math.max(1, img.width) : 0.4;

    const sigW = Math.round(spec.width * 0.28);
    const sigH = Math.max(60, Math.round(sigW * aspect));

    const newSig = {
      id: "sig_" + Date.now(),
      type: "signature",
      label: "डिजिटल साइन (Signature)",
      rawSrc: sigDataUrl,
      src: sigDataUrl,
      x: Math.round((spec.width - sigW) / 2),
      y: Math.round(spec.height * 0.78),
      w: sigW,
      h: sigH,
      baseW: sigW,
      baseH: sigH,
      scale: 100,
      rotation: 0,
      hasBorder: false,
      brightness: 100,
      contrast: 100
    };

    page.items.push(newSig);
    selectedItemId = newSig.id;
    await renderCanvas();
    triggerStateSave();
  }

  // ==================== 11. ITEM CONTROL PANEL & PAGE NAVIGATION UI ====================
  function updateSelectedItemUI() {
    const sel = getSelectedItem();
    const titleEl = document.getElementById("selectedItemTitle");
    const editTxtBtn = document.getElementById("editSelectedTextBtn");
    const borderChk = document.getElementById("itemBorderCheckbox");
    const scaleSlider = document.getElementById("itemScaleSlider");
    const scaleLabel = document.getElementById("itemScaleValueLabel");
    const bSlider = document.getElementById("itemBrightnessSlider");
    const cSlider = document.getElementById("itemContrastSlider");
    const bLabel = document.getElementById("brightnessValLabel");
    const cLabel = document.getElementById("contrastValLabel");

    if (!sel) {
      if (titleEl) titleEl.textContent = "कंट्रोल टूल (कैनवास पर किसी फोटो, साइन या टेक्स्ट को छूकर चुनें)";
      if (editTxtBtn) editTxtBtn.classList.add("hidden");
      if (borderChk) borderChk.checked = false;
      return;
    }

    if (titleEl) titleEl.textContent = `चुना गया: ${sel.label}`;
    if (editTxtBtn) editTxtBtn.classList.toggle("hidden", sel.type !== "text");
    if (borderChk) borderChk.checked = Boolean(sel.hasBorder);
    if (scaleSlider) scaleSlider.value = sel.scale || 100;
    if (scaleLabel) scaleLabel.textContent = (sel.scale || 100) + "%";
    if (bSlider) bSlider.value = sel.brightness || 100;
    if (cSlider) cSlider.value = sel.contrast || 100;
    if (bLabel) bLabel.textContent = (sel.brightness || 100) + "%";
    if (cLabel) cLabel.textContent = (sel.contrast || 100) + "%";
  }

  function applyScaleToSelected(newScale) {
    const sel = getSelectedItem();
    if (!sel) return;
    const clamped = Math.min(250, Math.max(15, newScale));
    const centerX = sel.x + sel.w / 2;
    const centerY = sel.y + sel.h / 2;

    const baseW = sel.baseW || sel.w;
    const baseH = sel.baseH || sel.h;
    sel.w = Math.round((baseW * clamped) / 100);
    sel.h = Math.round((baseH * clamped) / 100);
    sel.x = Math.round(centerX - sel.w / 2);
    sel.y = Math.round(centerY - sel.h / 2);
    sel.scale = clamped;

    renderCanvas();
    triggerStateSave();
  }

  function updatePageNavigationUI() {
    const total = window.KioskState.pages.length;
    const curr = window.KioskState.currentPageIndex + 1;
    document.getElementById("currentPageIndexLabel").textContent = curr;
    document.getElementById("totalPagesCountLabel").textContent = total;
    document.getElementById("prevPageBtn").disabled = curr <= 1;
    document.getElementById("nextPageBtn").disabled = curr >= total;
    document.getElementById("deleteCurrentPageBtn").classList.toggle("hidden", total <= 1);
  }

  function updatePaperSizeContainerUI() {
    const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
    const container = document.getElementById("canvasContainer");
    const dimLabel = document.getElementById("canvasPaperDimensionLabel");
    if (container) {
      container.classList.remove("paper-a4-portrait", "paper-a4-landscape", "paper-4x6", "paper-legal");
      container.classList.add(spec.cssClass);
    }
    if (dimLabel) dimLabel.textContent = spec.label;
  }

  // ==================== 12. BIND ALL UI CONTROLS ====================
  function bindEngineEvents() {
    canvas = document.getElementById("kioskCanvas");
    ctx = canvas.getContext("2d");

    canvas.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    canvas.addEventListener("touchstart", onPointerDown, { passive: false });
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("touchend", onPointerUp);

    function bindFileInput(inputId, targetType) {
      const el = document.getElementById(inputId);
      if (!el) return;
      el.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          openLockedCropper({ target: targetType, rawSrc: ev.target.result });
        };
        reader.readAsDataURL(file);
        el.value = "";
      });
    }

    bindFileInput("frontGalleryInput", "front");
    bindFileInput("frontCameraFallbackInput", "front");
    bindFileInput("backGalleryInput", "back");
    bindFileInput("backCameraFallbackInput", "back");
    bindFileInput("extraPhotoInput", "extra");
    bindFileInput("paperSigGalleryInput", "signature");
    bindFileInput("paperSigCameraFallbackInput", "signature");

    // Cropper Modal
    document.getElementById("closeCropModalBtn").addEventListener("click", closeLockedCropper);
    document.getElementById("cancelCropBtn").addEventListener("click", closeLockedCropper);
    document.getElementById("applyCropBtn").addEventListener("click", applyCropAndPlace);
    document.getElementById("cropRotateLeftBtn").addEventListener("click", () => cropperInstance && cropperInstance.rotate(-90));
    document.getElementById("cropRotateRightBtn").addEventListener("click", () => cropperInstance && cropperInstance.rotate(90));
    document.getElementById("cropResetBoxBtn").addEventListener("click", () => cropperInstance && cropperInstance.reset());

    // Live Camera Modal
    document.getElementById("closeLiveCameraBtn").addEventListener("click", closeDirectCamera);
    document.getElementById("capturePhotoBtn").addEventListener("click", captureFromLiveCamera);

    // Signature Modal & Tabs
    document.getElementById("openSignatureModalBtn").addEventListener("click", () => {
      document.getElementById("signatureModal").classList.remove("hidden");
    });
    document.getElementById("closeSignatureModalBtn").addEventListener("click", () => {
      document.getElementById("signatureModal").classList.add("hidden");
    });

    const tabDrawBtn = document.getElementById("tabDrawSignBtn");
    const tabPaperBtn = document.getElementById("tabPaperSignBtn");
    tabDrawBtn.addEventListener("click", () => {
      tabDrawBtn.className = "bg-indigo-600 text-white font-extrabold text-xs sm:text-sm py-2.5 rounded-xl shadow transition";
      tabPaperBtn.className = "bg-white text-slate-700 font-extrabold text-xs sm:text-sm py-2.5 rounded-xl border border-slate-200 transition";
      document.getElementById("drawSignTabContent").classList.remove("hidden");
      document.getElementById("paperSignTabContent").classList.add("hidden");
    });
    tabPaperBtn.addEventListener("click", () => {
      tabPaperBtn.className = "bg-indigo-600 text-white font-extrabold text-xs sm:text-sm py-2.5 rounded-xl shadow transition";
      tabDrawBtn.className = "bg-white text-slate-700 font-extrabold text-xs sm:text-sm py-2.5 rounded-xl border border-slate-200 transition";
      document.getElementById("paperSignTabContent").classList.remove("hidden");
      document.getElementById("drawSignTabContent").classList.add("hidden");
    });

    // Text & Whiteout Tool Modal
    document.getElementById("openTextToolModalBtn").addEventListener("click", openTextModalForNew);
    document.getElementById("closeTextToolModalBtn").addEventListener("click", () => {
      document.getElementById("textToolModal").classList.add("hidden");
    });
    document.getElementById("saveTextToCanvasBtn").addEventListener("click", saveTextToolToCanvas);
    document.getElementById("editSelectedTextBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (sel && sel.type === "text") openTextModalForEdit(sel);
    });

    // Safe Print Margin Switch
    const safeToggle = document.getElementById("safeMarginToggle");
    if (safeToggle) {
      safeToggle.addEventListener("change", (e) => {
        window.KioskState.safeMarginEnabled = e.target.checked;
        renderCanvas();
        triggerStateSave();
      });
    }

    // 5 Smart Layout Buttons & Paper Size
    document.querySelectorAll(".layout-btn").forEach((btn) => {
      btn.addEventListener("click", () => applySmartLayout(btn.dataset.layout));
    });

    document.getElementById("paperSizeSelect").addEventListener("change", async (e) => {
      window.KioskState.paperSize = e.target.value;
      updatePaperSizeContainerUI();
      await applySmartLayout(window.KioskState.activeLayout);
    });

    // Multi-Page Controls
    document.getElementById("prevPageBtn").addEventListener("click", () => {
      if (window.KioskState.currentPageIndex > 0) {
        window.KioskState.currentPageIndex--;
        selectedItemId = null;
        renderCanvas();
      }
    });
    document.getElementById("nextPageBtn").addEventListener("click", () => {
      if (window.KioskState.currentPageIndex < window.KioskState.pages.length - 1) {
        window.KioskState.currentPageIndex++;
        selectedItemId = null;
        renderCanvas();
      }
    });
    document.getElementById("addNewPageBtn").addEventListener("click", () => {
      window.KioskState.pages.push({ id: "page_" + Date.now(), items: [] });
      window.KioskState.currentPageIndex = window.KioskState.pages.length - 1;
      selectedItemId = null;
      renderCanvas();
      triggerStateSave();
    });
    document.getElementById("deleteCurrentPageBtn").addEventListener("click", () => {
      if (window.KioskState.pages.length <= 1) return;
      if (!confirm("क्या आप इस पेज को हटाना चाहते हैं?")) return;
      window.KioskState.pages.splice(window.KioskState.currentPageIndex, 1);
      window.KioskState.currentPageIndex = Math.max(0, window.KioskState.currentPageIndex - 1);
      selectedItemId = null;
      renderCanvas();
      triggerStateSave();
    });

    // Page Lock & Fullscreen Preview
    document.getElementById("togglePageLockBtn").addEventListener("click", () => {
      window.KioskState.isPageLocked = !window.KioskState.isPageLocked;
      syncPageLockUI();
      renderCanvas();
      triggerStateSave();
    });

    document.getElementById("openFullscreenPreviewBtn").addEventListener("click", async () => {
      const cleanUrl = await renderCleanPageToDataURL(window.KioskState.currentPageIndex, "image/jpeg", 0.95);
      document.getElementById("fullscreenPreviewImage").src = cleanUrl;
      document.getElementById("fullscreenPreviewModal").classList.remove("hidden");
    });
    document.getElementById("closeFullscreenPreviewBtn").addEventListener("click", () => {
      document.getElementById("fullscreenPreviewModal").classList.add("hidden");
    });

    // Item Controls
    document.getElementById("itemBorderCheckbox").addEventListener("change", (e) => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.hasBorder = e.target.checked;
      renderCanvas();
      triggerStateSave();
    });

    document.getElementById("deleteSelectedItemBtn").addEventListener("click", () => {
      const page = getCurrentPage();
      const sel = getSelectedItem();
      if (!sel) {
        alert("हटाने के लिए पहले कैनवास पर किसी फोटो, साइन या टेक्स्ट को छूकर चुनें!");
        return;
      }
      page.items = page.items.filter((it) => it.id !== sel.id);
      if (sel.type === "front" || sel.type === "back") {
        window.KioskState.slots[sel.type] = { rawSrc: null, croppedSrc: null };
        updateSlotThumbnailsUI();
      }
      selectedItemId = page.items.length ? page.items[page.items.length - 1].id : null;
      renderCanvas();
      triggerStateSave();
    });

    document.getElementById("itemScaleSlider").addEventListener("input", (e) => {
      applyScaleToSelected(Number(e.target.value));
    });
    document.getElementById("scaleDownBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (sel) applyScaleToSelected((sel.scale || 100) - 8);
    });
    document.getElementById("scaleUpBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (sel) applyScaleToSelected((sel.scale || 100) + 8);
    });

    document.getElementById("rotate90Btn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.rotation = ((sel.rotation || 0) + 90) % 360;
      renderCanvas();
      triggerStateSave();
    });

    document.getElementById("centerAlignBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) return;
      const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
      sel.x = Math.round((spec.width - sel.w) / 2);
      showCenterGuideX = true;
      renderCanvas();
      setTimeout(() => {
        showCenterGuideX = false;
        renderCanvas();
      }, 650);
      triggerStateSave();
    });

    document.getElementById("fitFullA4Btn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) return;
      const spec = PAPER_SPECS[window.KioskState.paperSize] || PAPER_SPECS["a4-portrait"];
      const margin = window.KioskState.safeMarginEnabled ? spec.safeMarginPx : 36;
      sel.x = margin;
      sel.y = margin;
      sel.w = spec.width - margin * 2;
      sel.h = spec.height - margin * 2;
      sel.baseW = sel.w;
      sel.baseH = sel.h;
      sel.scale = 100;
      renderCanvas();
      triggerStateSave();
    });

    document.getElementById("recropSelectedBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) {
        alert("फिर से काटने के लिए पहले कैनवास पर किसी फोटो को चुनें!");
        return;
      }
      openLockedCropper({
        target: "recrop-item",
        itemId: sel.id,
        rawSrc: sel.rawSrc || sel.src
      });
    });

    // Scanner Brightness & Contrast Sliders
    document.getElementById("itemBrightnessSlider").addEventListener("input", (e) => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.brightness = Number(e.target.value);
      document.getElementById("brightnessValLabel").textContent = sel.brightness + "%";
      renderCanvas();
      triggerStateSave();
    });
    document.getElementById("itemContrastSlider").addEventListener("input", (e) => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.contrast = Number(e.target.value);
      document.getElementById("contrastValLabel").textContent = sel.contrast + "%";
      renderCanvas();
      triggerStateSave();
    });
    document.getElementById("magicScannerCleanBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.brightness = 118;
      sel.contrast = 148;
      renderCanvas();
      triggerStateSave();
    });
    document.getElementById("resetScannerFilterBtn").addEventListener("click", () => {
      const sel = getSelectedItem();
      if (!sel) return;
      sel.brightness = 100;
      sel.contrast = 100;
      renderCanvas();
      triggerStateSave();
    });
  }

  function syncPageLockUI() {
    const locked = Boolean(window.KioskState.isPageLocked);
    const btn = document.getElementById("togglePageLockBtn");
    const icon = document.getElementById("pageLockIcon");
    const text = document.getElementById("pageLockText");
    const badge = document.getElementById("canvasLockedBadge");

    if (canvas) canvas.classList.toggle("canvas-locked", locked);
    if (badge) badge.classList.toggle("hidden", !locked);

    if (locked) {
      if (icon) icon.textContent = "🔒";
      if (text) text.textContent = "पेज अनलॉक करें";
      if (btn) btn.className = "flex-1 sm:flex-initial bg-amber-500 text-white border border-amber-600 font-extrabold text-xs px-3 py-2 rounded-xl flex items-center justify-center gap-1 transition shadow";
    } else {
      if (icon) icon.textContent = "🔓";
      if (text) text.textContent = "पेज लॉक करें";
      if (btn) btn.className = "flex-1 sm:flex-initial bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-300 font-extrabold text-xs px-3 py-2 rounded-xl flex items-center justify-center gap-1 transition shadow-sm";
    }
  }

  // ==================== 13. EXPOSE PUBLIC ENGINE API ====================
  window.KioskEngine = {
    PAPER_SPECS,
    init: function () {
      bindEngineEvents();
      initSignatureSystem();
      updatePaperSizeContainerUI();
      updateSlotThumbnailsUI();
      syncPageLockUI();
      renderCanvas();
    },
    renderCanvas,
    renderCleanPageToDataURL,
    applySmartLayout,
    updateSlotThumbnailsUI,
    updatePaperSizeContainerUI,
    syncPageLockUI,
    openTextModalForNew,
    openLockedCropperWithCallback: function (rawSrc, customCallback) {
      openLockedCropper({
        target: "pdf-crop",
        rawSrc,
        customCallback
      });
    },
    addPdfPagesAsFullA4,
    addPdfPagesTwoInOne,
    addAutoCutIdCardsToCanvas,
    addOrUpdatePhotoOnPage,
    clearSelection: function () {
      selectedItemId = null;
    }
  };
})();
