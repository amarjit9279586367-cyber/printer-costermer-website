/* ============================================================================
 * FILE 5: app.js (QuickPrint Kiosk Pro V2.0)
 * Backend Sync, Live Daily Token, IndexedDB Auto-Save, Shopkeeper Live Queue,
 * Dynamic UPI Payment QR Code, PDF/JPG/Print Exports & Editable WhatsApp Link
 * ============================================================================ */

// ==================== 1. BACKEND CONNECTION VARIABLE ====================
const BACKEND_URL = "https://printerbeckrnd.onrender.com";

(function () {
  "use strict";

  // ==================== 2. STORAGE KEYS & SHOPKEEPER SETTINGS ====================
  const SETTINGS_STORAGE_KEY = "quickprint_pro_shop_settings_v2";
  const DAILY_TOKEN_KEY = "quickprint_pro_daily_token_v2";
  const LOCAL_JOBS_INDEX_KEY = "quickprint_pro_local_jobs_index_v2";
  const IDB_NAME = "QuickPrintKioskProDB";
  const IDB_STORE = "kiosk_session_store";
  const IDB_SESSION_KEY = "active_kiosk_state";

  let shopSettings = {
    whatsappNumber: "",
    upiId: "",
    colorRate: 20,
    bwRate: 10
  };

  let autoSaveTimer = null;

  function loadShopSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        shopSettings.whatsappNumber = parsed.whatsappNumber || "";
        shopSettings.upiId = parsed.upiId || "";
        shopSettings.colorRate = Number(parsed.colorRate) || 20;
        shopSettings.bwRate = Number(parsed.bwRate) || 10;
      }
    } catch (e) {
      console.warn("Could not read shop settings:", e);
    }
    syncShopSettingsToUI();
  }

  function saveShopSettings() {
    const wpInput = document.getElementById("shopkeeperWhatsappInput");
    const upiInput = document.getElementById("shopkeeperUpiInput");
    const cInput = document.getElementById("settingColorRateInput");
    const bwInput = document.getElementById("settingBwRateInput");

    const cleanPhone = (wpInput.value || "").replace(/\D/g, "").slice(-10);
    if (cleanPhone && cleanPhone.length !== 10) {
      alert("कृपया दुकानदार का सही 10 अंकों का WhatsApp मोबाइल नंबर लिखें!");
      return;
    }

    shopSettings.whatsappNumber = cleanPhone;
    shopSettings.upiId = (upiInput.value || "").trim();
    shopSettings.colorRate = Math.max(1, Number(cInput.value) || 20);
    shopSettings.bwRate = Math.max(1, Number(bwInput.value) || 10);

    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(shopSettings));
    } catch (e) {
      console.warn("Settings save error:", e);
    }

    syncShopSettingsToUI();
    updatePricingAndUpiUI();
    document.getElementById("settingsModal").classList.add("hidden");
  }

  function syncShopSettingsToUI() {
    const wpInput = document.getElementById("shopkeeperWhatsappInput");
    const upiInput = document.getElementById("shopkeeperUpiInput");
    const cInput = document.getElementById("settingColorRateInput");
    const bwInput = document.getElementById("settingBwRateInput");
    const cLabel = document.getElementById("colorRateLabel");
    const bwLabel = document.getElementById("bwRateLabel");

    if (wpInput) wpInput.value = shopSettings.whatsappNumber;
    if (upiInput) upiInput.value = shopSettings.upiId;
    if (cInput) cInput.value = shopSettings.colorRate;
    if (bwInput) bwInput.value = shopSettings.bwRate;
    if (cLabel) cLabel.textContent = shopSettings.colorRate;
    if (bwLabel) bwLabel.textContent = shopSettings.bwRate;
  }

  // ==================== 3. INDEXED-DB AUTO-SAVE (REFRESH PROTECTION) ====================
  function openKioskDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB not supported"));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function saveSessionToIndexedDB(stateObj) {
    const statusText = document.getElementById("autoSaveStatusText");
    const dot = document.getElementById("autoSaveDot");
    try {
      const db = await openKioskDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.put(JSON.parse(JSON.stringify(stateObj)), IDB_SESSION_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = (err) => reject(err);
      });
      if (statusText) statusText.textContent = "ऑटो-सेव चालू है (सुरक्षित)";
      if (dot) dot.className = "w-2 h-2 rounded-full bg-emerald-400";
    } catch (err) {
      try {
        localStorage.setItem(IDB_SESSION_KEY, JSON.stringify(stateObj));
      } catch (e) {}
    }
  }

  async function loadSessionFromIndexedDB() {
    try {
      const db = await openKioskDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const getReq = store.get(IDB_SESSION_KEY);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      });
    } catch (err) {
      try {
        const raw = localStorage.getItem(IDB_SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }
  }

  async function clearSavedSession() {
    try {
      const db = await openKioskDB();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(IDB_SESSION_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (e) {}
    try {
      localStorage.removeItem(IDB_SESSION_KEY);
    } catch (e) {}
  }

  window.scheduleAutoSave = function () {
    const statusText = document.getElementById("autoSaveStatusText");
    if (statusText) statusText.textContent = "सेव हो रहा है...";
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      saveSessionToIndexedDB(window.KioskState);
      updatePricingAndUpiUI();
    }, 300);
  };

  // ==================== 4. LIVE DAILY TOKEN SYSTEM (#01, #02...) ====================
  function getTodayDateString() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function formatTokenNumber(num) {
    const n = parseInt(String(num).replace(/\D/g, ""), 10) || 1;
    return String(n).padStart(2, "0");
  }

  function getNextLocalDailyToken(increment = false) {
    const today = getTodayDateString();
    let tracker = { date: today, count: 1 };
    try {
      const raw = localStorage.getItem(DAILY_TOKEN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.date === today) {
          tracker.count = increment ? (Number(parsed.count) || 1) + 1 : Number(parsed.count) || 1;
        } else {
          // Morning auto-reset to #01 on new day
          tracker = { date: today, count: 1 };
        }
      }
      localStorage.setItem(DAILY_TOKEN_KEY, JSON.stringify(tracker));
    } catch (e) {}
    return formatTokenNumber(tracker.count);
  }

  async function fetchNewLiveTokenFromServer(forceIncrement = false) {
    const today = getTodayDateString();

    if (BACKEND_URL && !BACKEND_URL.includes("your-backend.onrender.com")) {
      try {
        const cleanBase = BACKEND_URL.replace(/\/$/, "");
        const res = await fetch(`${cleanBase}/api/new-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: today })
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.token) {
            const formatted = formatTokenNumber(data.token);
            localStorage.setItem(DAILY_TOKEN_KEY, JSON.stringify({ date: today, count: parseInt(formatted, 10) }));
            return formatted;
          }
        }
      } catch (err) {
        console.warn("Backend token endpoint unreachable, using local daily fallback:", err);
      }
    }

    return getNextLocalDailyToken(forceIncrement);
  }

  function updateTokenBadgeUI() {
    const badge = document.getElementById("liveTokenBadge");
    if (badge) {
      badge.textContent = "#" + formatTokenNumber(window.KioskState.token);
    }
  }

  // '➕ नया टोकन' Button Handler
  async function handleNewTokenClick() {
    const hasWork =
      window.KioskState.customerName.trim() !== "" ||
      window.KioskState.pages.some((p) => p.items && p.items.length > 0);

    if (hasWork) {
      const ok = confirm("क्या आप नया टोकन और नया खाली पेज खोलना चाहते हैं? (वर्तमान पेज साफ हो जाएगा)");
      if (!ok) return;
    }

    await clearSavedSession();

    if (window.location.search.includes("token=")) {
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
      document.getElementById("shopkeeperModeBanner").classList.add("hidden");
    }

    const nextToken = await fetchNewLiveTokenFromServer(true);

    window.KioskState = {
      token: nextToken,
      customerName: "",
      paperSize: "a4-portrait",
      activeLayout: "id-vertical",
      colorMode: "color",
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
      pages: [{ id: "page_1", items: [] }]
    };

    window.KioskEngine.clearSelection();
    syncFullStateToUI();
    await window.KioskEngine.renderCanvas();
    await saveSessionToIndexedDB(window.KioskState);
  }

  // ==================== 5. PRICING, COLOR/B&W & DYNAMIC UPI QR CODE ====================
  function setColorMode(mode) {
    window.KioskState.colorMode = mode === "bw" ? "bw" : "color";
    const colorBtn = document.getElementById("selectColorModeBtn");
    const bwBtn = document.getElementById("selectBwModeBtn");

    if (window.KioskState.colorMode === "color") {
      colorBtn.classList.add("active-mode", "border-indigo-600", "bg-indigo-50/70");
      colorBtn.classList.remove("border-slate-200", "bg-slate-50");
      bwBtn.classList.remove("active-mode", "border-indigo-600", "bg-indigo-50/70");
      bwBtn.classList.add("border-slate-200", "bg-slate-50");
    } else {
      bwBtn.classList.add("active-mode", "border-indigo-600", "bg-indigo-50/70");
      bwBtn.classList.remove("border-slate-200", "bg-slate-50");
      colorBtn.classList.remove("active-mode", "border-indigo-600", "bg-indigo-50/70");
      colorBtn.classList.add("border-slate-200", "bg-slate-50");
    }

    updatePricingAndUpiUI();
    window.KioskEngine.renderCanvas();
    window.scheduleAutoSave();
  }

  function calculateTotalPrice() {
    const pageCount = Math.max(1, window.KioskState.pages.length);
    const copies = Math.max(1, Number(window.KioskState.copies) || 1);
    const rate = window.KioskState.colorMode === "bw" ? shopSettings.bwRate : shopSettings.colorRate;
    return {
      pageCount,
      copies,
      rate,
      total: pageCount * copies * rate
    };
  }

  function updatePricingAndUpiUI() {
    const { pageCount, copies, rate, total } = calculateTotalPrice();
    document.getElementById("copiesCountLabel").textContent = copies;
    document.getElementById("priceBreakdownText").textContent = `${pageCount} पेज × ${copies} कॉपी × ₹${rate}`;
    document.getElementById("totalPriceValue").textContent = total;
    document.getElementById("whatsappBtnPrice").textContent = total;

    // Update Dynamic UPI QR Card if Shopkeeper saved a UPI ID
    const upiCard = document.getElementById("upiPaymentCard");
    if (!upiCard) return;

    if (shopSettings.upiId && shopSettings.upiId.includes("@")) {
      upiCard.classList.remove("hidden");
      const tokenStr = formatTokenNumber(window.KioskState.token);
      const upiUri = `upi://pay?pa=${encodeURIComponent(shopSettings.upiId)}&pn=${encodeURIComponent("QuickPrint Kiosk")}&am=${total}&cu=INR&tn=${encodeURIComponent("Token #" + tokenStr)}`;
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiUri)}`;

      document.getElementById("upiQrImage").src = qrApiUrl;
      document.getElementById("upiAmountText").textContent = total;
      document.getElementById("upiBtnAmount").textContent = total;
      document.getElementById("upiIdDisplay").textContent = shopSettings.upiId;
      document.getElementById("upiDeepLinkBtn").href = upiUri;
    } else {
      upiCard.classList.add("hidden");
    }
  }

  // ==================== 6. PDF, JPG & DIRECT PRINT EXPORTS ====================
  function getSafeFileName(ext) {
    const tokenStr = formatTokenNumber(window.KioskState.token);
    const rawName = (window.KioskState.customerName || "Customer").trim().replace(/[^a-zA-Z0-9\u0900-\u097F_-]/g, "_");
    return `Token_${tokenStr}_${rawName}.${ext}`;
  }

  async function generateAndDownloadPDF() {
    const loading = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = "आपकी साफ PDF फाइल तैयार हो रही है...";
    if (loading) loading.classList.remove("hidden");

    try {
      const { jsPDF } = window.jspdf;
      const spec = window.KioskEngine.PAPER_SPECS[window.KioskState.paperSize] || window.KioskEngine.PAPER_SPECS["a4-portrait"];

      const pdf = new jsPDF({
        orientation: spec.pdfOrientation,
        unit: "mm",
        format: spec.pdfFormat,
        compress: true
      });

      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      for (let i = 0; i < window.KioskState.pages.length; i++) {
        if (i > 0) {
          pdf.addPage(spec.pdfFormat, spec.pdfOrientation);
        }
        const pageDataUrl = await window.KioskEngine.renderCleanPageToDataURL(i, "image/jpeg", 0.95);
        pdf.addImage(pageDataUrl, "JPEG", 0, 0, pageW, pageH, undefined, "FAST");
      }

      pdf.save(getSafeFileName("pdf"));
      return true;
    } catch (err) {
      console.error("PDF generation failed:", err);
      alert("PDF बनाने में समस्या आई। कृपया पुनः प्रयास करें।");
      return false;
    } finally {
      if (loading) loading.classList.add("hidden");
    }
  }

  async function downloadCurrentPageJPG() {
    const loading = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = "हाई-क्वालिटी JPG फोटो डाउनलोड हो रही है...";
    if (loading) loading.classList.remove("hidden");

    try {
      const dataUrl = await window.KioskEngine.renderCleanPageToDataURL(window.KioskState.currentPageIndex, "image/jpeg", 0.96);
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = getSafeFileName("jpg");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      if (loading) loading.classList.add("hidden");
    }
  }

  async function handleDirectPrint() {
    let printMount = document.getElementById("directPrintMount");
    if (!printMount) {
      printMount = document.createElement("div");
      printMount.id = "directPrintMount";
      document.body.appendChild(printMount);
    }
    printMount.innerHTML = "";

    for (let i = 0; i < window.KioskState.pages.length; i++) {
      const dataUrl = await window.KioskEngine.renderCleanPageToDataURL(i, "image/jpeg", 0.96);
      const img = document.createElement("img");
      img.src = dataUrl;
      img.className = "printable-page-img";
      printMount.appendChild(img);
    }

    setTimeout(() => {
      window.print();
    }, 250);
  }

  // ==================== 7. HINDI VOICE ALERT ====================
  function speakHindiTokenAlert(tokenNumber) {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(
        `आपका टोकन नंबर ${parseInt(tokenNumber, 10)} तैयार है`
      );
      utter.lang = "hi-IN";
      utter.rate = 0.95;
      utter.pitch = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) {}
  }

  // ==================== 8. BACKEND SAVE / LOAD & SHOPKEEPER LIVE QUEUE ====================
  function saveJobToLocalIndex(jobMeta) {
    try {
      const today = getTodayDateString();
      const raw = localStorage.getItem(LOCAL_JOBS_INDEX_KEY);
      let list = raw ? JSON.parse(raw) : [];
      // Filter only today's jobs
      list = list.filter((j) => j.date === today && j.token !== jobMeta.token);
      list.unshift(jobMeta);
      localStorage.setItem(LOCAL_JOBS_INDEX_KEY, JSON.stringify(list.slice(0, 50)));
    } catch (e) {}
  }

  async function saveTokenJobToBackend(tokenStr, payload) {
    try {
      localStorage.setItem(`quickprint_token_job_${tokenStr}`, JSON.stringify(payload));
      saveJobToLocalIndex({
        token: tokenStr,
        date: getTodayDateString(),
        customerName: payload.customerName,
        totalPrice: payload.totalPrice,
        updatedAt: new Date().toLocaleTimeString("hi-IN")
      });
    } catch (e) {}

    if (!BACKEND_URL || BACKEND_URL.includes("your-backend.onrender.com")) {
      return { ok: true, mode: "local-fallback" };
    }

    try {
      const cleanBase = BACKEND_URL.replace(/\/$/, "");
      const res = await fetch(`${cleanBase}/api/job/${tokenStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return { ok: res.ok, mode: "remote-backend" };
    } catch (err) {
      console.warn("Could not reach backend server, saved locally:", err);
      return { ok: false, mode: "local-fallback" };
    }
  }

  async function loadTokenJobFromBackend(tokenStr) {
    const formatted = formatTokenNumber(tokenStr);

    if (BACKEND_URL && !BACKEND_URL.includes("your-backend.onrender.com")) {
      try {
        const cleanBase = BACKEND_URL.replace(/\/$/, "");
        const res = await fetch(`${cleanBase}/api/job/${formatted}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.state) return data.state;
          if (data && data.pages) return data;
        }
      } catch (err) {
        console.warn("Remote token fetch failed, checking local storage:", err);
      }
    }

    try {
      const localRaw = localStorage.getItem(`quickprint_token_job_${formatted}`);
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        return parsed.state || parsed;
      }
    } catch (e) {}

    return null;
  }

  // 📋 Shopkeeper Live Orders Queue Dashboard
  async function openAndLoadLiveQueue() {
    const modal = document.getElementById("queueModal");
    const listEl = document.getElementById("queueListContainer");
    const countEl = document.getElementById("queueCountText");
    if (!modal || !listEl) return;

    modal.classList.remove("hidden");
    listEl.innerHTML = `<p class="text-center text-xs text-slate-500 py-8 font-bold">🔄 आज के टोकन लोड हो रहे हैं...</p>`;

    let jobs = [];

    // 1. Fetch from Backend /api/jobs
    if (BACKEND_URL && !BACKEND_URL.includes("your-backend.onrender.com")) {
      try {
        const cleanBase = BACKEND_URL.replace(/\/$/, "");
        const res = await fetch(`${cleanBase}/api/jobs`);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.jobs)) {
            jobs = data.jobs;
          }
        }
      } catch (e) {
        console.warn("Live queue backend fetch failed, using local index:", e);
      }
    }

    // 2. Merge with Local Jobs Index if empty
    if (jobs.length === 0) {
      try {
        const today = getTodayDateString();
        const raw = localStorage.getItem(LOCAL_JOBS_INDEX_KEY);
        if (raw) {
          jobs = JSON.parse(raw).filter((j) => j.date === today);
        }
      } catch (e) {}
    }

    if (countEl) countEl.textContent = `आज के कुल टोकन: ${jobs.length}`;

    if (jobs.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-8 space-y-2">
          <div class="text-3xl">📭</div>
          <p class="text-xs font-extrabold text-slate-700">आज अभी तक कोई प्रिंट ऑर्डर नहीं आया है।</p>
          <p class="text-[11px] text-slate-500">जब ग्राहक 'प्रिंट भेजें' दबाएगा, तो उसका टोकन यहाँ दिखेगा।</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    jobs.forEach((job) => {
      const tStr = formatTokenNumber(job.token);
      const row = document.createElement("div");
      row.className = "bg-white border-2 border-slate-200 hover:border-indigo-500 rounded-2xl p-3 flex items-center justify-between gap-2 shadow-sm transition";
      row.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="bg-indigo-950 text-amber-400 font-black text-sm px-3 py-2 rounded-xl">
            #${tStr}
          </div>
          <div>
            <h4 class="font-extrabold text-sm text-slate-900">${job.customerName || "ग्राहक"}</h4>
            <p class="text-[11px] text-slate-500 font-semibold">कुल राशि: <span class="text-emerald-700 font-extrabold">₹${job.totalPrice || 0}</span> • ${job.updatedAt || ""}</p>
          </div>
        </div>
        <button type="button" class="open-token-job-btn bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs px-3.5 py-2 rounded-xl shadow" data-token="${tStr}">
          🛠️ खोलें व प्रिंट करें
        </button>
      `;

      row.querySelector(".open-token-job-btn").addEventListener("click", async () => {
        modal.classList.add("hidden");
        await activateShopkeeperTokenEditMode(tStr);
      });

      listEl.appendChild(row);
    });
  }

  async function activateShopkeeperTokenEditMode(tokenStr) {
    const formattedToken = formatTokenNumber(tokenStr);
    const loading = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = `ग्राहक का टोकन #${formattedToken} लोड हो रहा है...`;
    if (loading) loading.classList.remove("hidden");

    const loadedState = await loadTokenJobFromBackend(formattedToken);
    if (loading) loading.classList.add("hidden");

    if (loadedState) {
      window.KioskState = loadedState;
      window.KioskState.isPageLocked = false;
      document.getElementById("editingTokenLabel").textContent = `टोकन #${formattedToken}`;
      document.getElementById("shopkeeperModeBanner").classList.remove("hidden");
      syncFullStateToUI();
      await window.KioskEngine.renderCanvas();
      return true;
    } else {
      alert(`टोकन #${formattedToken} का डेटा सर्वर पर नहीं मिला।`);
      return false;
    }
  }

  // ==================== 9. SEND WHATSAPP PRINT WITH EDITABLE TOKEN LINK ====================
  async function handleSendWhatsAppPrint() {
    const hasAnyItem = window.KioskState.pages.some((p) => p.items && p.items.length > 0);
    if (!hasAnyItem) {
      alert("कृपया प्रिंट भेजने से पहले कम से कम एक फोटो, PDF या साइन अपलोड करें!");
      return;
    }

    const tokenStr = formatTokenNumber(window.KioskState.token);
    const customerName = (window.KioskState.customerName || "ग्राहक").trim();
    const { pageCount, copies, total } = calculateTotalPrice();
    const modeLabel = window.KioskState.colorMode === "bw" ? "ब्लैक & व्हाइट (B&W)" : "कलर प्रिंट (Color)";

    // (क) Hindi Voice Alert & Download PDF on Customer's Phone
    speakHindiTokenAlert(tokenStr);
    await generateAndDownloadPDF();

    // (ख) Save complete editable state to Backend
    const loading = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = `टोकन #${tokenStr} सर्वर पर सेव हो रहा है...`;
    if (loading) loading.classList.remove("hidden");

    const jobPayload = {
      token: tokenStr,
      date: getTodayDateString(),
      customerName,
      totalPrice: total,
      createdAt: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(window.KioskState))
    };

    await saveTokenJobToBackend(tokenStr, jobPayload);
    if (loading) loading.classList.add("hidden");

    // (ग) Open Shopkeeper's WhatsApp Chat with Direct Editable Link (?token=03)
    const baseFrontendUrl = window.location.origin + window.location.pathname;
    const editableTokenUrl = `${baseFrontendUrl}?token=${tokenStr}`;

    const messageLines = [
      `🖨️ *QuickPrint Kiosk - नया प्रिंट ऑर्डर*`,
      `━━━━━━━━━━━━━━━━━━`,
      `🎫 *टोकन नंबर:* #${tokenStr}`,
      `👤 *ग्राहक का नाम:* ${customerName}`,
      `🎨 *प्रिंट मोड:* ${modeLabel}`,
      `📄 *कुल पेज:* ${pageCount} पेज × ${copies} कॉपी`,
      `💰 *कुल पैसे:* ₹${total}`,
      `━━━━━━━━━━━━━━━━━━`,
      `🛠️ *दुकानदार एडिट और सीधा प्रिंट लिंक:*`,
      editableTokenUrl
    ];

    const encodedMsg = encodeURIComponent(messageLines.join("\n"));
    const shopPhone = (shopSettings.whatsappNumber || "").replace(/\D/g, "");
    const whatsappUrl = shopPhone.length === 10
      ? `https://wa.me/91${shopPhone}?text=${encodedMsg}`
      : `https://wa.me/?text=${encodedMsg}`;

    window.open(whatsappUrl, "_blank");
  }

  // ==================== 10. SYNC STATE TO UI & INITIALIZATION ====================
  function syncFullStateToUI() {
    updateTokenBadgeUI();

    const nameInput = document.getElementById("customerNameInput");
    const clearBtn = document.getElementById("clearNameBtn");
    if (nameInput) nameInput.value = window.KioskState.customerName || "";
    if (clearBtn) clearBtn.classList.toggle("hidden", !window.KioskState.customerName);

    const paperSelect = document.getElementById("paperSizeSelect");
    if (paperSelect) paperSelect.value = window.KioskState.paperSize || "a4-portrait";

    const safeToggle = document.getElementById("safeMarginToggle");
    if (safeToggle) safeToggle.checked = window.KioskState.safeMarginEnabled !== false;

    let activeLayout = window.KioskState.activeLayout || "id-vertical";
    if (activeLayout === "aadhaar-vertical") activeLayout = "id-vertical";
    if (activeLayout === "aadhaar-horizontal") activeLayout = "id-horizontal";

    document.querySelectorAll(".layout-btn").forEach((btn) => {
      if (btn.dataset.layout === activeLayout) {
        btn.classList.add("active-layout", "border-indigo-600", "bg-indigo-50", "text-indigo-950");
        btn.classList.remove("border-slate-200", "bg-slate-50", "text-slate-800");
      } else {
        btn.classList.remove("active-layout", "border-indigo-600", "bg-indigo-50", "text-indigo-950");
        btn.classList.add("border-slate-200", "bg-slate-50", "text-slate-800");
      }
    });

    const ppPanel = document.getElementById("passportMakerPanel");
    if (ppPanel) ppPanel.classList.toggle("hidden", activeLayout !== "passport");

    if (window.KioskState.passportConfig) {
      const ppName = document.getElementById("passportTextName");
      const ppDate = document.getElementById("passportTextDate");
      if (ppName) ppName.value = window.KioskState.passportConfig.nameText || "";
      if (ppDate) ppDate.value = window.KioskState.passportConfig.dateText || "";
    }

    setColorMode(window.KioskState.colorMode || "color");
    window.KioskEngine.updatePaperSizeContainerUI();
    window.KioskEngine.updateSlotThumbnailsUI();
    window.KioskEngine.syncPageLockUI();
    updatePricingAndUpiUI();
  }

  function bindAppEvents() {
    // New Token Button
    document.getElementById("newTokenBtn").addEventListener("click", handleNewTokenClick);

    // Live Orders Queue Modal
    document.getElementById("openQueueModalBtn").addEventListener("click", openAndLoadLiveQueue);
    document.getElementById("closeQueueModalBtn").addEventListener("click", () => {
      document.getElementById("queueModal").classList.add("hidden");
    });
    document.getElementById("refreshQueueBtn").addEventListener("click", openAndLoadLiveQueue);

    // Shopkeeper Settings Modal
    document.getElementById("openSettingsBtn").addEventListener("click", () => {
      syncShopSettingsToUI();
      document.getElementById("settingsModal").classList.remove("hidden");
    });
    document.getElementById("closeSettingsModalBtn").addEventListener("click", () => {
      document.getElementById("settingsModal").classList.add("hidden");
    });
    document.getElementById("saveSettingsBtn").addEventListener("click", saveShopSettings);

    // Customer Name Input
    const nameInput = document.getElementById("customerNameInput");
    const clearNameBtn = document.getElementById("clearNameBtn");
    nameInput.addEventListener("input", (e) => {
      window.KioskState.customerName = e.target.value;
      clearNameBtn.classList.toggle("hidden", !e.target.value);
      window.scheduleAutoSave();
    });
    clearNameBtn.addEventListener("click", () => {
      window.KioskState.customerName = "";
      nameInput.value = "";
      clearNameBtn.classList.add("hidden");
      window.scheduleAutoSave();
    });

    // Color / B&W Mode Cards
    document.getElementById("selectColorModeBtn").addEventListener("click", () => setColorMode("color"));
    document.getElementById("selectBwModeBtn").addEventListener("click", () => setColorMode("bw"));

    // Copies Counter (- / +)
    document.getElementById("decreaseCopiesBtn").addEventListener("click", () => {
      window.KioskState.copies = Math.max(1, (Number(window.KioskState.copies) || 1) - 1);
      updatePricingAndUpiUI();
      window.scheduleAutoSave();
    });
    document.getElementById("increaseCopiesBtn").addEventListener("click", () => {
      window.KioskState.copies = Math.min(99, (Number(window.KioskState.copies) || 1) + 1);
      updatePricingAndUpiUI();
      window.scheduleAutoSave();
    });

    // 3 Download / Print Buttons + Green WhatsApp Button
    document.getElementById("downloadPdfBtn").addEventListener("click", generateAndDownloadPDF);
    document.getElementById("downloadJpgBtn").addEventListener("click", downloadCurrentPageJPG);
    document.getElementById("directPrintBtn").addEventListener("click", handleDirectPrint);
    document.getElementById("sendWhatsAppPrintBtn").addEventListener("click", handleSendWhatsAppPrint);
  }

  // ==================== 11. BOOTSTRAP ON PAGE LOAD ====================
  window.addEventListener("DOMContentLoaded", async () => {
    loadShopSettings();
    window.KioskEngine.init();
    bindAppEvents();

    // 1. Check if opened via Shopkeeper Editable Token Link (?token=03)
    const urlParams = new URLSearchParams(window.location.search);
    const requestedToken = urlParams.get("token");

    if (requestedToken) {
      const ok = await activateShopkeeperTokenEditMode(requestedToken);
      if (ok) return;
    }

    // 2. Normal Customer Load: Restore from IndexedDB Auto-Save if page was refreshed
    const savedState = await loadSessionFromIndexedDB();
    if (savedState && savedState.pages) {
      window.KioskState = savedState;
      syncFullStateToUI();
      await window.KioskEngine.renderCanvas();
    } else {
      // 3. Fresh Screen Load -> Fetch live daily token (#01, #02...)
      const initialToken = await fetchNewLiveTokenFromServer(false);
      window.KioskState.token = initialToken;
      syncFullStateToUI();
      await window.KioskEngine.renderCanvas();
      await saveSessionToIndexedDB(window.KioskState);
    }
  });
})();
