(() => {
  "use strict";

  const { el, formatDuration } = window.CF;

  const PDFJS_VERSION = "3.11.174";
  const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
  const PDFJS_SCRIPT_URL = `${PDFJS_BASE}/pdf.min.js`;
  const PDFJS_WORKER_URL = `${PDFJS_BASE}/pdf.worker.min.js`;

  const DB_NAME = "cyberfeed_books";
  const DB_VERSION = 1;
  const STORE_BOOKS = "books";
  const STORE_BLOBS = "bookBlobs";

  const FLUSH_INTERVAL_MS = 15000;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3.0;
  const ZOOM_STEP = 0.25;

  let dbPromise = null;
  let pdfJsPromise = null;

  let activeSession = null; // { bookId, startedAt, accumulatedMs, flushTimer }
  let reader = { pdfDoc: null, bookId: null, record: null, pageNum: 1, zoom: 1.0 };

  // ---------- IndexedDB ----------
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          const store = db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
          store.createIndex("byAddedAt", "addedAt");
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode) {
    const db = await openDb();
    return db.transaction(storeNames, mode);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listBooks() {
    const t = await tx([STORE_BOOKS], "readonly");
    const all = await reqToPromise(t.objectStore(STORE_BOOKS).getAll());
    return all.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }

  async function getBook(id) {
    const t = await tx([STORE_BOOKS], "readonly");
    return reqToPromise(t.objectStore(STORE_BOOKS).get(id));
  }

  async function putBook(record) {
    const t = await tx([STORE_BOOKS], "readwrite");
    t.objectStore(STORE_BOOKS).put(record);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function deleteBook(id) {
    const t = await tx([STORE_BOOKS, STORE_BLOBS], "readwrite");
    t.objectStore(STORE_BOOKS).delete(id);
    t.objectStore(STORE_BLOBS).delete(id);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function putBlob(id, blob) {
    const t = await tx([STORE_BLOBS], "readwrite");
    t.objectStore(STORE_BLOBS).put({ id, blob });
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function getBlob(id) {
    const t = await tx([STORE_BLOBS], "readonly");
    const rec = await reqToPromise(t.objectStore(STORE_BLOBS).get(id));
    return rec ? rec.blob : null;
  }

  // ---------- pdf.js lazy loader ----------
  function loadPdfJs() {
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const script = document.createElement("script");
      script.src = PDFJS_SCRIPT_URL;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error("Failed to load pdf.js"));
      document.head.appendChild(script);
    });
    return pdfJsPromise;
  }

  // ---------- Library view ----------
  async function renderBookLibrary() {
    const list = document.getElementById("book-list");
    const empty = document.getElementById("book-empty-state");
    if (!list) return;
    const books = await listBooks();
    list.innerHTML = "";
    empty.style.display = books.length ? "none" : "block";
    for (const b of books) {
      list.appendChild(el("div", { class: "book-row", role: "listitem" }, [
        el("div", { class: "book-info" }, [
          el("div", { class: "book-title", text: b.title }),
          el("div", { class: "book-meta", text: b.pageCount
            ? `Page ${b.lastReadPage} of ${b.pageCount}${b.totalTimeMs > 0 ? ` • ${formatDuration(b.totalTimeMs)} read` : ""}`
            : "Not opened yet" }),
        ]),
        el("div", { class: "book-actions" }, [
          el("button", { class: "btn", text: "Open", onclick: () => openBook(b.id) }),
          el("button", { class: "btn", text: "Delete", onclick: () => confirmDelete(b.id) }),
        ]),
      ]));
    }
    updateReadingTimeStat(books);
  }

  async function confirmDelete(id) {
    if (!confirm("Delete this book? This cannot be undone.")) return;
    await deleteBook(id);
    renderBookLibrary();
  }

  function updateReadingTimeStat(books) {
    const tile = document.getElementById("stat-reading-time");
    if (!tile) return;
    const today = new Date().toDateString();
    const total = books.reduce((sum, b) => {
      if (b.lastOpenedAt && new Date(b.lastOpenedAt).toDateString() === today) return sum + (b.todayMs || 0);
      return sum;
    }, 0);
    const valueEl = tile.querySelector(".stat-value");
    if (valueEl) valueEl.textContent = total > 0 ? formatDuration(total) : "0m";
  }

  async function handleUpload(file) {
    if (!file || file.type !== "application/pdf") {
      alert("Please choose a PDF file.");
      return;
    }
    const id = crypto.randomUUID();
    const arrayBuffer = await file.arrayBuffer();
    await putBlob(id, new Blob([arrayBuffer], { type: "application/pdf" }));
    await putBook({
      id,
      title: file.name.replace(/\.pdf$/i, ""),
      filename: file.name,
      addedAt: new Date().toISOString(),
      pageCount: null,
      lastReadPage: 1,
      zoomLevel: 1.0,
      totalTimeMs: 0,
      todayMs: 0,
      lastOpenedAt: null,
    });
    renderBookLibrary();
  }

  // ---------- Reader view ----------
  async function openBook(id) {
    const record = await getBook(id);
    if (!record) return;
    window.CF.setView("reader");
    document.getElementById("reader-title").textContent = record.title;
    document.getElementById("reader-canvas-wrap").classList.add("loading");

    const pdfjsLib = await loadPdfJs();
    const blob = await getBlob(id);
    const arrayBuffer = await blob.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    reader = { pdfDoc, bookId: id, record, pageNum: record.lastReadPage || 1, zoom: record.zoomLevel || 1.0 };
    if (!record.pageCount || record.pageCount !== pdfDoc.numPages) {
      record.pageCount = pdfDoc.numPages;
      await putBook(record);
    }
    reader.pageNum = Math.min(Math.max(reader.pageNum, 1), pdfDoc.numPages);

    document.getElementById("reader-canvas-wrap").classList.remove("loading");
    await renderPage(reader.pageNum);
    startSession(id);
  }

  async function renderPage(pageNum) {
    const canvas = document.getElementById("reader-canvas");
    const page = await reader.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: reader.zoom });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    reader.pageNum = pageNum;
    document.getElementById("reader-page-indicator").textContent = `Page ${pageNum} of ${reader.pdfDoc.numPages}`;
    document.getElementById("reader-page-jump").value = pageNum;
    document.getElementById("reader-zoom-level").textContent = `${Math.round(reader.zoom * 100)}%`;
    persistReaderProgress();
  }

  let progressDebounce;
  function persistReaderProgress() {
    clearTimeout(progressDebounce);
    progressDebounce = setTimeout(async () => {
      if (!reader.record) return;
      reader.record.lastReadPage = reader.pageNum;
      reader.record.zoomLevel = reader.zoom;
      await putBook(reader.record);
    }, 500);
  }

  let flipResetTimer;
  function triggerPageFlip() {
    const wrap = document.getElementById("reader-canvas-wrap");
    if (!wrap) return;
    wrap.classList.remove("page-turn");
    void wrap.offsetWidth; // restart the animation even on rapid consecutive page turns
    wrap.classList.add("page-turn");
    clearTimeout(flipResetTimer);
    flipResetTimer = setTimeout(() => wrap.classList.remove("page-turn"), 450);
  }

  function goToPage(n) {
    if (!reader.pdfDoc) return;
    const clamped = Math.min(Math.max(n, 1), reader.pdfDoc.numPages);
    if (clamped !== reader.pageNum) triggerPageFlip();
    renderPage(clamped);
  }

  function zoomBy(delta) {
    if (!reader.pdfDoc) return;
    reader.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(reader.zoom + delta).toFixed(2)));
    renderPage(reader.pageNum);
  }

  function closeReader() {
    pauseSession();
    reader = { pdfDoc: null, bookId: null, record: null, pageNum: 1, zoom: 1.0 };
    const panel = document.getElementById("reader-shortcuts-panel");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      document.getElementById("reader-shortcuts-btn")?.setAttribute("aria-expanded", "false");
    }
    window.CF.setView("library");
    renderBookLibrary();
  }

  // ---------- Reading timer ----------
  function startSession(bookId) {
    pauseSession();
    activeSession = { bookId, startedAt: Date.now(), accumulatedMs: 0 };
    tickTimerDisplay();
    activeSession.tickTimer = setInterval(tickTimerDisplay, 1000);
    activeSession.flushTimer = setInterval(flushSession, FLUSH_INTERVAL_MS);
  }

  function tickTimerDisplay() {
    const indicator = document.getElementById("reader-session-timer");
    if (!activeSession || !indicator) return;
    const elapsed = activeSession.accumulatedMs + (Date.now() - activeSession.startedAt);
    indicator.textContent = formatDuration(elapsed);
  }

  async function flushSession() {
    if (!activeSession) return;
    const now = Date.now();
    const delta = now - activeSession.startedAt;
    activeSession.startedAt = now;
    activeSession.accumulatedMs += delta;
    if (reader.record && reader.bookId === activeSession.bookId) {
      reader.record.totalTimeMs = (reader.record.totalTimeMs || 0) + delta;
      const today = new Date().toDateString();
      reader.record.todayMs = reader.record.lastOpenedAt && new Date(reader.record.lastOpenedAt).toDateString() === today
        ? (reader.record.todayMs || 0) + delta
        : delta;
      reader.record.lastOpenedAt = new Date().toISOString();
      await putBook(reader.record);
    }
  }

  function pauseSession() {
    if (!activeSession) return;
    clearInterval(activeSession.tickTimer);
    clearInterval(activeSession.flushTimer);
    flushSession();
    activeSession = null;
  }

  function resumeSession() {
    if (activeSession || !reader.bookId) return;
    startSession(reader.bookId);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseSession();
    else if (reader.bookId && (document.documentElement.getAttribute("data-view") === "reader")) resumeSession();
  });
  window.addEventListener("beforeunload", () => { if (activeSession) flushSession(); });

  // ---------- Wiring ----------
  function wireBooks() {
    document.getElementById("book-upload-btn").addEventListener("click", () => document.getElementById("book-upload").click());
    document.getElementById("book-upload").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) handleUpload(file);
    });
    document.getElementById("reader-back").addEventListener("click", closeReader);
    document.getElementById("reader-prev").addEventListener("click", () => goToPage(reader.pageNum - 1));
    document.getElementById("reader-next").addEventListener("click", () => goToPage(reader.pageNum + 1));
    document.getElementById("reader-page-jump").addEventListener("change", (e) => goToPage(parseInt(e.target.value, 10) || 1));
    document.getElementById("reader-zoom-in").addEventListener("click", () => zoomBy(ZOOM_STEP));
    document.getElementById("reader-zoom-out").addEventListener("click", () => zoomBy(-ZOOM_STEP));

    const shortcutsBtn = document.getElementById("reader-shortcuts-btn");
    const shortcutsPanel = document.getElementById("reader-shortcuts-panel");
    shortcutsBtn.addEventListener("click", () => {
      const nowOpen = shortcutsPanel.hidden;
      shortcutsPanel.hidden = !nowOpen;
      shortcutsBtn.setAttribute("aria-expanded", String(nowOpen));
    });
    document.addEventListener("click", (e) => {
      if (!shortcutsPanel.hidden && !shortcutsPanel.contains(e.target) && e.target !== shortcutsBtn) {
        shortcutsPanel.hidden = true;
        shortcutsBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Registered once (not per book-open) and gated on the current view, so there is never
    // more than one listener and nothing to clean up when the reader closes or re-opens.
    document.addEventListener("keydown", (e) => {
      if (document.documentElement.getAttribute("data-view") !== "reader") return;
      if (!reader.pdfDoc) return;

      // Never intercept keys while the user is typing (the page-jump field, or anything else).
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" ||
        activeEl.tagName === "SELECT" || activeEl.isContentEditable
      );
      if (isTyping) {
        if (e.key === "Escape") activeEl.blur();
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (!shortcutsPanel.hidden) {
          shortcutsPanel.hidden = true;
          shortcutsBtn.setAttribute("aria-expanded", "false");
        } else {
          closeReader();
        }
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goToPage(reader.pageNum + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goToPage(reader.pageNum - 1);
      } else if (e.key === " ") {
        e.preventDefault();
        goToPage(reader.pageNum + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Home") {
        e.preventDefault();
        goToPage(1);
      } else if (e.key === "End") {
        e.preventDefault();
        goToPage(reader.pdfDoc.numPages);
      }
    });

    document.addEventListener("cf:viewchange", (e) => {
      if (e.detail.view === "library") renderBookLibrary();
      if (e.detail.view !== "reader" && activeSession) pauseSession();
    });
    document.addEventListener("cf:statsrendered", async () => {
      updateReadingTimeStat(await listBooks());
    });

    openDb().then(() => listBooks()).then(updateReadingTimeStat).catch(() => {});
  }

  wireBooks();
})();
