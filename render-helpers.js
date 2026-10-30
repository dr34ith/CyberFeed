window.CF = (function () {
  "use strict";

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  }

  function safeImageUrl(url) {
    // Stricter than safeLink: the page's CSP only allows img-src https: (plus data:/blob: for generated covers).
    if (!url) return null;
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "https:") return u.href;
    } catch {}
    return null;
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
  }

  // Earthen / amber family (matches the CyberFeed brand palette).
  const COVER_PALETTES = [
    ["#C98A4B", "#9C5F26"],
    ["#8CAA6E", "#5B7A3E"],
    ["#7E9AAE", "#4F6B80"],
    ["#697565", "#3C3D37"],
    ["#D9693E", "#A8482A"],
    ["#B9712F", "#7A4A1C"],
    ["#5B6049", "#262B1D"],
    ["#9CA786", "#697565"],
  ];

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function generateCoverSvg(category, tag) {
    // Card media containers vary in aspect ratio (roughly square to ~2:1 wide), and
    // object-fit:cover crops this 2:1 SVG symmetrically around the center to fill them.
    // Worst case (tallest card) keeps only the middle ~124 of 320 viewBox units visible,
    // so the label is centered and constrained well inside that to never get clipped.
    const label = (tag || category || "CyberFeed").toUpperCase();
    const [c1, c2] = COVER_PALETTES[hashStr(label) % COVER_PALETTES.length];
    const maxWidth = 100;
    const lengthAttr = label.length > 6 ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : "";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
      `</linearGradient></defs>` +
      `<rect width="320" height="160" fill="url(#g)"/>` +
      `<text x="160" y="88" text-anchor="middle"${lengthAttr} font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff" fill-opacity="0.95">${escapeXml(label)}</text>` +
      `</svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatDate(iso) {
    if (!iso) return "unknown date";
    const d = new Date(iso);
    if (isNaN(d)) return "unknown date";
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  function animateCount(el, target, duration = 650) {
    const prev = Number(el.dataset.value);
    if (prev === target) {
      el.textContent = String(target);
      return;
    }
    el.dataset.value = String(target);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = String(target);
      return;
    }
    const start = Number.isFinite(prev) ? prev : 0;
    const startTime = performance.now();
    const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
    function tick(now) {
      const progress = Math.min(1, (now - startTime) / duration);
      const value = Math.round(start + (target - start) * easeOutQuad(progress));
      el.textContent = String(value);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function setView(view) {
    document.documentElement.setAttribute("data-view", view);
    try { localStorage.setItem("cf_active_view", view); } catch {}
    document.dispatchEvent(new CustomEvent("cf:viewchange", { detail: { view } }));
  }

  return { el, safeImageUrl, generateCoverSvg, formatDuration, formatDate, setView, animateCount };
})();
