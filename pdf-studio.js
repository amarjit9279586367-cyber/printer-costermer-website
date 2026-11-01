/* ============================================================================
 * FILE 4: pdf-studio.js (QuickPrint Kiosk Pro V2.0)
 * Dedicated PDF Studio Engine: Client-Side PDF.js Rendering, Password Unlock,
 * Page Selector, 2-in-1 Notes Mode, Auto Government ID Card Cutter & Text Tool
 * ============================================================================ */

(function () {
  "use strict";

  // Configure PDF.js worker source
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  let loadedPdfDoc = null;
  let pdfPagesCache = []; // Stores { pageNum, dataUrl, selected: boolean }
  let currentRawFileArrayBuffer = null;

  // ==================== 1. OPEN / CLOSE PDF STUDIO WINDOW ====================
  function openPdfStudioWindow() {
    const win = document.getElementById("pdfStudioWindow");
    if (win) win.classList.remove("hidden");
  }

  function closePdfStudioWindow() {
    const win = document.getElementById("pdfStudioWindow");
    if (win) win.classList.add("hidden");
  }

  // ==================== 2. LOAD & RENDER PDF FILE ====================
  async function handlePdfFileSelected(file) {
    if (!file || file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      alert("कृपया मान्य .pdf फाइल चुनें!");
      return;
    }

    const loading = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = "PDF लोड हो रही है...";
    if (loading) loading.classList.remove("hidden");

    try {
      const arrayBuffer = await file.arrayBuffer();
      currentRawFileArrayBuffer = arrayBuffer;
      await processPdfArrayBuffer(arrayBuffer, "");
    } catch (err) {
      console.warn("PDF load error or password protected:", err);
      if (loading) loading.classList.add("hidden");
      // Show Password Prompt Box
      document.getElementById("pdfStudioEmptyState").classList.add("hidden");
      document.getElementById("pdfPagesGrid").classList.add("hidden");
      document.getElementById("pdfPasswordBox").classList.remove("hidden");
    } finally {
      if (loading) loading.classList.add("hidden");
    }
  }

  async function processPdfArrayBuffer(arrayBuffer, password) {
    const loading = document.getElementById("loadingOverlay");
    if (loading) loading.classList.remove("hidden");

    try {
      const loadingTask = window.pdfjsLib.getDocument({
        data: arrayBuffer,
        password: password || undefined
      });

      loadedPdfDoc = await loadingTask.promise;
      pdfPagesCache = [];

      const totalPages = loadedPdfDoc.numPages;
      document.getElementById("pdfFileMetaSubtitle").textContent = `कुल पेज: ${totalPages} | सभी पेज तैयार हैं`;

      for (let i = 1; i <= totalPages; i++) {
        const page = await loadedPdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 }); // High-res 150 DPI render

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const pCtx = canvas.getContext("2d");

        await page.render({ canvasContext: pCtx, viewport }).promise;
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

        pdfPagesCache.push({
          pageNum: i,
          dataUrl,
          selected: true // Default all pages selected
        });
      }

      document.getElementById("pdfPasswordBox").classList.add("hidden");
      document.getElementById("pdfStudioEmptyState").classList.add("hidden");
      document.getElementById("pdfPagesGrid").classList.remove("hidden");

      renderPdfPagesGridUI();
      updatePdfSelectedCountBadge();
    } catch (err) {
      console.error("PDF Render Failed:", err);
      if (err.name === "PasswordException" || String(err.message).toLowerCase().includes("password")) {
        document.getElementById("pdfStudioEmptyState").classList.add("hidden");
        document.getElementById("pdfPagesGrid").classList.add("hidden");
        document.getElementById("pdfPasswordBox").classList.remove("hidden");
      } else {
        alert("PDF फाइल पढ़ने में असमर्थ। संभव है फाइल повреждена (corrupted) हो।");
      }
    } finally {
      if (loading) loading.classList.add("hidden");
    }
  }

  // ==================== 3. RENDER PDF THUMBNAILS GRID UI ====================
  function renderPdfPagesGridUI() {
    const grid = document.getElementById("pdfPagesGrid");
    if (!grid) return;
    grid.innerHTML = "";

    pdfPagesCache.forEach((pageObj, idx) => {
      const card = document.createElement("div");
      card.className = `pdf-page-card ${pageObj.selected ? "selected-pdf-page" : ""}`;
      card.dataset.index = idx;

      card.innerHTML = `
        <div class="p-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <label class="inline-flex items-center gap-2 cursor-pointer text-xs font-black text-white">
            <input type="checkbox" ${pageObj.selected ? "checked" : ""} class="pdf-card-chk w-4 h-4 accent-emerald-500 rounded" data-index="${idx}" />
            <span>पेज #${pageObj.pageNum}</span>
          </label>
          <button type="button" class="crop-single-pdf-btn bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[11px] px-2.5 py-1 rounded-lg" data-index="${idx}">
            ✂️ काटें (Crop)
          </button>
        </div>

        <div class="pdf-thumb-wrapper" data-index="${idx}">
          <img src="${pageObj.dataUrl}" alt="PDF Page ${pageObj.pageNum}" />
        </div>

        <div class="p-2.5 bg-slate-900 border-t border-slate-800 text-center text-[11px] text-slate-400 font-medium">
          टैप करके चुनें या क्रॉप करें
        </div>
      `;

      // Card checkbox toggle
      card.querySelector(".pdf-card-chk").addEventListener("change", (e) => {
        pdfPagesCache[idx].selected = e.target.checked;
        card.classList.toggle("selected-pdf-page", e.target.checked);
        updatePdfSelectedCountBadge();
      });

      // Clicking thumb or card toggles selection
      card.querySelector(".pdf-thumb-wrapper").addEventListener("click", () => {
        pdfPagesCache[idx].selected = !pdfPagesCache[idx].selected;
        const chk = card.querySelector(".pdf-card-chk");
        chk.checked = pdfPagesCache[idx].selected;
        card.classList.toggle("selected-pdf-page", pdfPagesCache[idx].selected);
        updatePdfSelectedCountBadge();
      });

      // Crop single PDF page using 2-step Locked Cropper
      card.querySelector(".crop-single-pdf-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        window.KioskEngine.openLockedCropperWithCallback(pageObj.dataUrl, async (croppedUrl) => {
          pdfPagesCache[idx].dataUrl = croppedUrl;
          renderPdfPagesGridUI();
        });
      });

      grid.appendChild(card);
    });
  }

  function updatePdfSelectedCountBadge() {
    const count = pdfPagesCache.filter((p) => p.selected).length;
    const badge = document.getElementById("pdfSelectedCountBadge");
    if (badge) badge.textContent = count;
  }

  // ==================== 4. SPECIAL SMART PDF TOOLS ====================
  // A. Auto Government ID Card Cutter: Automatically detects and crops top/bottom half of ID card
  async function handleAutoIdCardCut() {
    const selected = pdfPagesCache.filter((p) => p.selected);
    if (!selected.length) {
      alert("कृपया पहले PDF का वह पेज चुनें जिस पर आईडी कार्ड है!");
      return;
    }

    const targetImgUrl = selected[0].dataUrl;
    const img = new Image();
    img.src = targetImgUrl;
    await new Promise((res) => { img.onload = res; });

    const w = img.width;
    const h = img.height;

    // Split top and bottom halves for Front and Back ID card
    const cTop = document.createElement("canvas");
    cTop.width = w;
    cTop.height = Math.floor(h / 2);
    cTop.getContext("2d").drawImage(img, 0, 0, w, h / 2, 0, 0, w, h / 2);

    const cBot = document.createElement("canvas");
    cBot.width = w;
    cBot.height = Math.floor(h / 2);
    cBot.getContext("2d").drawImage(img, 0, h / 2, w, h / 2, 0, 0, w, h / 2);

    const frontUrl = cTop.toDataURL("image/jpeg", 0.93);
    const backUrl = cBot.toDataURL("image/jpeg", 0.93);

    closePdfStudioWindow();
    await window.KioskEngine.addAutoCutIdCardsToCanvas(frontUrl, backUrl);
    alert("✅ सरकारी आईडी कार्ड सफलतापूर्वक कटकर मुख्य कैनवास पर सेट हो गया है!");
  }

  // B. Import 2 PDF Pages on 1 A4 Sheet (2-in-1 Micro Notes)
  async function handleTwoInOneImport() {
    const selectedUrls = pdfPagesCache.filter((p) => p.selected).map((p) => p.dataUrl);
    if (!selectedUrls.length) {
      alert("कृपया 2-in-1 प्रिंट के लिए कम से कम एक पेज चुनें!");
      return;
    }
    closePdfStudioWindow();
    await window.KioskEngine.addPdfPagesTwoInOne(selectedUrls);
  }

  // C. Import Selected Pages as Full A4
  async function handleImportSelectedPages() {
    const selectedUrls = pdfPagesCache.filter((p) => p.selected).map((p) => p.dataUrl);
    if (!selectedUrls.length) {
      alert("कृपया इम्पोर्ट करने के लिए कम से कम एक पेज चुनें!");
      return;
    }
    closePdfStudioWindow();
    await window.KioskEngine.addPdfPagesAsFullA4(selectedUrls);
  }

  // ==================== 5. BIND PDF STUDIO EVENTS ====================
  function bindPdfStudioEvents() {
    // Launcher & Close
    document.getElementById("openPdfStudioWindowBtn").addEventListener("click", openPdfStudioWindow);
    document.getElementById("closePdfStudioWindowBtn").addEventListener("click", closePdfStudioWindow);

    // File inputs
    const fileInput1 = document.getElementById("pdfStudioFileInput");
    const fileInput2 = document.getElementById("pdfStudioCenterFileInput");

    [fileInput1, fileInput2].forEach((input) => {
      if (!input) return;
      input.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handlePdfFileSelected(file);
        input.value = "";
      });
    });

    // Password Unlock
    document.getElementById("unlockPdfPasswordBtn").addEventListener("click", async () => {
      const pwd = document.getElementById("pdfPasswordInput").value;
      if (!pwd) {
        alert("कृपया पासवर्ड लिखें!");
        return;
      }
      if (currentRawFileArrayBuffer) {
        await processPdfArrayBuffer(currentRawFileArrayBuffer, pwd);
      }
    });

    // Range Selection Toolbar
    document.getElementById("pdfSelectAllBtn").addEventListener("click", () => {
      pdfPagesCache.forEach((p) => { p.selected = true; });
      renderPdfPagesGridUI();
      updatePdfSelectedCountBadge();
    });

    document.getElementById("pdfSelectFirstBtn").addEventListener("click", () => {
      pdfPagesCache.forEach((p, idx) => { p.selected = idx === 0; });
      renderPdfPagesGridUI();
      updatePdfSelectedCountBadge();
    });

    document.getElementById("pdfDeselectAllBtn").addEventListener("click", () => {
      pdfPagesCache.forEach((p) => { p.selected = false; });
      renderPdfPagesGridUI();
      updatePdfSelectedCountBadge();
    });

    document.getElementById("applyPdfRangeBtn").addEventListener("click", () => {
      const rangeStr = document.getElementById("pdfRangeInput").value.trim();
      if (!rangeStr) return;

      const selectedPagesSet = new Set();
      rangeStr.split(",").forEach((part) => {
        part = part.trim();
        if (part.includes("-")) {
          const [start, end] = part.split("-").map(Number);
          for (let n = start; n <= end; n++) selectedPagesSet.add(n);
        } else {
          const n = Number(part);
          if (!isNaN(n)) selectedPagesSet.add(n);
        }
      });

      pdfPagesCache.forEach((p) => {
        p.selected = selectedPagesSet.has(p.pageNum);
      });

      renderPdfPagesGridUI();
      updatePdfSelectedCountBadge();
    });

    // Smart Tools
    document.getElementById("pdfAutoIdCardCutBtn").addEventListener("click", handleAutoIdCardCut);
    document.getElementById("pdfTwoInOneImportBtn").addEventListener("click", handleTwoInOneImport);
    document.getElementById("importSelectedPdfPagesBtn").addEventListener("click", handleImportSelectedPages);
  }

  window.addEventListener("DOMContentLoaded", () => {
    bindPdfStudioEvents();
  });
})();
