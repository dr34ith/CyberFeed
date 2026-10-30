(() => {
  "use strict";

  const { el, safeImageUrl, generateCoverSvg, formatDate } = window.CF;

  const FEEDS_JSON_URL = "feeds.json";
  // corsproxy.io now requires a paid API key and allorigins' /raw endpoint has gone flaky,
  // so this list leans on multiple independent proxies (including allorigins' JSON-wrapped
  // /get endpoint, unwrapped below) and gives up on each one quickly rather than hanging.
  const CORS_PROXIES = [
    { build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, unwrap: (t) => t },
    { build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, unwrap: (t) => t },
    { build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, unwrap: (t) => { try { return JSON.parse(t).contents || ""; } catch { return ""; } } },
  ];
  const PROXY_TIMEOUT_MS = 8000;
  const MAX_SNIPPET = 320;
  const CRITICAL_KEYWORDS = ["critical", "actively exploited", "zero-day", "0-day", "emergency patch", "widespread exploitation"];
  const TAG_RULES = {
    "ransomware": ["ransomware", "lockbit", "ransom "],
    "malware": ["malware", "trojan", "backdoor"],
    "phishing": ["phishing", "smishing"],
    "vulnerability": ["vulnerability", "cve-", "exploit", "zero-day", "0-day"],
    "data breach": ["data breach", "breach", "leaked data"],
    "nation-state": ["nation-state", "apt", "state-sponsored"],
    "cloud": ["aws", "azure", "google cloud", "cloud security"],
    "critical infrastructure": ["critical infrastructure", "ics", "scada", "ot security"],
  };
  const CVE_RE = /CVE-\d{4}-\d{4,7}/gi;
  const IMG_TAG_RE = /<img[^>]+src="([^"]+)"/i;

  const FALLBACK_SOURCES = [
    { id: "thehackernews", name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", category: "News" },
    { id: "bleepingcomputer", name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", category: "News" },
    { id: "krebsonsecurity", name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", category: "News" },
    { id: "darkreading", name: "Dark Reading", url: "https://www.darkreading.com/rss.xml", category: "News" },
    { id: "securityweek", name: "SecurityWeek", url: "https://www.securityweek.com/feed/", category: "News" },
    { id: "schneier", name: "Schneier on Security", url: "https://www.schneier.com/feed/atom/", category: "Analysis" },
    { id: "sophosnews", name: "Sophos News", url: "https://news.sophos.com/en-us/feed", category: "Vendor" },
    { id: "cisa", name: "CISA Advisories", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", category: "Advisory" },
    { id: "msrc", name: "Microsoft Security Blog", url: "https://www.microsoft.com/en-us/security/blog/feed/", category: "Vendor" },
    { id: "talos", name: "Cisco Talos", url: "https://blog.talosintelligence.com/rss/", category: "Research" },
    { id: "unit42", name: "Unit 42 (Palo Alto)", url: "https://unit42.paloaltonetworks.com/feed/", category: "Research" },
    { id: "crowdstrike", name: "CrowdStrike Blog", url: "https://www.crowdstrike.com/blog/feed/", category: "Vendor" },
    { id: "therecord", name: "The Record", url: "https://therecord.media/feed/", category: "News" },
    { id: "sans_isc", name: "SANS Internet Storm Center", url: "https://isc.sans.edu/rssfeed_full.xml", category: "Research" },
    { id: "theregister", name: "The Register Security", url: "https://www.theregister.com/security/headlines.atom", category: "News" },
    { id: "projectzero", name: "Google Project Zero", url: "https://projectzero.google/feed.xml", category: "Research" },
    { id: "malwarebytes", name: "Malwarebytes Labs", url: "https://www.malwarebytes.com/blog/feed/index.xml", category: "Vendor" },
    { id: "securityaffairs", name: "Security Affairs", url: "https://securityaffairs.com/feed", category: "News" },
  ];

  const LS = {
    read: "cf_read_ids",
    bookmarks: "cf_bookmarks",
    theme: "cf_theme",
    view: "cf_view",
    customFeeds: "cf_custom_feeds",
    activeView: "cf_active_view",
    userName: "cf_user_name",
    onboardingDismissed: "cf_onboarding_dismissed",
    customTags: "cf_custom_tags",
  };

  const state = {
    items: [],
    incoming: [],
    generatedAt: null,
    feedSource: "snapshot",
    read: new Set(loadJSON(LS.read, [])),
    bookmarks: new Set(loadJSON(LS.bookmarks, [])),
    customFeeds: loadJSON(LS.customFeeds, []),
    customTags: loadJSON(LS.customTags, []),
    filters: { time: "all", status: null, category: null, source: null, tag: null, query: "" },
    view: localStorage.getItem(LS.view) || "card",
    sort: "newest",
  };

  const POLL_INTERVAL = { snapshot: 2 * 60 * 1000, live: 8 * 60 * 1000 };
  let pollTimer = null;

  const CATEGORY_BADGE_CLASS = {
    Advisory: "badge-advisory",
    Analysis: "badge-analysis",
    News: "badge-news",
    Research: "badge-research",
    Vendor: "badge-vendor",
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function persistSets() {
    saveJSON(LS.read, [...state.read]);
    saveJSON(LS.bookmarks, [...state.bookmarks]);
  }

  function safeLink(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {}
    return null;
  }

  function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    const text = tmp.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  }

  function autoTag(title, summary) {
    const hay = `${title} ${summary}`.toLowerCase();
    const tags = Object.keys(TAG_RULES).filter((tag) => TAG_RULES[tag].some((kw) => hay.includes(kw)));
    const cves = [...new Set((title + " " + summary).match(CVE_RE) || [])].map((c) => c.toUpperCase());
    return { tags, cves };
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      [...u.searchParams.keys()].forEach((k) => { if (k.startsWith("utm_")) u.searchParams.delete(k); });
      u.hash = "";
      return u.href.replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  // ---------- Feed loading ----------
  async function loadFeeds() {
    // Opening index.html directly (file://) can never fetch feeds.json: browsers block
    // fetch() against the local filesystem outright, so there's no point even trying.
    if (location.protocol === "file:") {
      console.warn("CyberFeed was opened as a local file:// page, so the feeds.json snapshot can't be loaded (browsers block fetch() of local files). Falling back to a live fetch; for the full experience, serve this folder over http(s), e.g. `python -m http.server`.");
    } else {
      try {
        const res = await fetch(FEEDS_JSON_URL, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.items) && data.items.length) {
            return { items: data.items, health: data.health || [], source: "snapshot", generatedAt: data.generated_at };
          }
        }
      } catch (e) {
        console.warn("feeds.json unavailable, falling back to live proxy fetch", e);
      }
    }
    return fetchLiveViaProxies();
  }

  async function fetchLiveViaProxies() {
    const sources = [...FALLBACK_SOURCES, ...state.customFeeds];
    const results = await Promise.all(sources.map((s) => fetchOneLive(s)));
    const items = results.flat();
    return { items, health: [], source: "live", generatedAt: new Date().toISOString() };
  }

  async function fetchOneLive(source) {
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy.build(source.url), { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
        if (!res.ok) continue;
        const text = await res.text();
        const xml = proxy.unwrap(text);
        if (!xml) continue;
        const items = parseFeedXml(xml, source);
        if (items.length) return items;
      } catch {
        continue;
      }
    }
    return [];
  }

  function extractImage(node, isAtom, rawSummary) {
    const media = node.getElementsByTagNameNS ? node.getElementsByTagNameNS("http://search.yahoo.com/mrss/", "thumbnail")[0] : null;
    if (media) {
      const u = safeImageUrl(media.getAttribute("url"));
      if (u) return u;
    }
    const thumbFallback = [...node.getElementsByTagName("media:thumbnail"), ...node.getElementsByTagName("thumbnail")][0];
    if (thumbFallback) {
      const u = safeImageUrl(thumbFallback.getAttribute("url"));
      if (u) return u;
    }
    const enclosure = [...node.getElementsByTagName("enclosure")].find((e) => (e.getAttribute("type") || "").startsWith("image/"));
    if (enclosure) {
      const u = safeImageUrl(enclosure.getAttribute("url"));
      if (u) return u;
    }
    const itunesImg = node.getElementsByTagName("itunes:image")[0];
    if (itunesImg) {
      const u = safeImageUrl(itunesImg.getAttribute("href"));
      if (u) return u;
    }
    const match = rawSummary && rawSummary.match(IMG_TAG_RE);
    if (match) {
      const u = safeImageUrl(match[1]);
      if (u) return u;
    }
    return null;
  }

  function parseFeedXml(xmlText, source) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, "application/xml");
      if (doc.querySelector("parsererror")) return [];
    } catch {
      return [];
    }
    const isAtom = doc.documentElement.localName === "feed";
    const nodes = isAtom ? [...doc.getElementsByTagName("entry")] : [...doc.getElementsByTagName("item")];
    return nodes.map((node) => {
      const get = (tag) => node.getElementsByTagName(tag)[0];
      let title = get("title")?.textContent || "";
      let link = "";
      if (isAtom) {
        const links = [...node.getElementsByTagName("link")];
        const alt = links.find((l) => l.getAttribute("rel") === "alternate") || links[0];
        link = alt?.getAttribute("href") || "";
      } else {
        link = get("link")?.textContent || get("guid")?.textContent || "";
      }
      const rawSummary = get("description")?.textContent || get("summary")?.textContent || get("content")?.textContent || "";
      const summary = stripHtml(rawSummary).slice(0, MAX_SNIPPET);
      const published = get("pubDate")?.textContent || get("published")?.textContent || get("updated")?.textContent || null;
      const { tags, cves } = autoTag(title, summary);
      const image = extractImage(node, isAtom, rawSummary);
      return {
        title: stripHtml(title),
        link: normalizeUrl(link),
        summary,
        published: published ? new Date(published).toISOString() : null,
        source: source.name,
        source_id: source.id,
        category: source.category,
        tags,
        cves,
        image,
      };
    }).filter((it) => it.title && it.link);
  }

  // ---------- Rendering ----------
  function matchesFilters(item) {
    const f = state.filters;
    if (f.time !== "all") {
      const age = Date.now() - (item.published ? new Date(item.published).getTime() : 0);
      const limits = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      if (!item.published || age > limits[f.time]) return false;
    }
    if (f.status === "unread" && state.read.has(item.link)) return false;
    if (f.status === "bookmarked" && !state.bookmarks.has(item.link)) return false;
    if (f.category && item.category !== f.category) return false;
    if (f.source && item.source_id !== f.source) return false;
    if (f.tag && !(item.tags || []).includes(f.tag)) return false;
    if (f.query) {
      const q = f.query.toLowerCase();
      const hay = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function isCritical(item) {
    const hay = `${item.title} ${item.summary}`.toLowerCase();
    return CRITICAL_KEYWORDS.some((kw) => hay.includes(kw));
  }

  function renderCriticalBanner(items) {
    const banner = document.getElementById("critical-banner");
    const criticalItems = items.filter(isCritical).slice(0, 6);
    if (criticalItems.length === 0) {
      banner.classList.remove("show");
      return;
    }
    document.getElementById("cw-count").textContent = `${criticalItems.length} high-severity ${criticalItems.length === 1 ? "story" : "stories"}`;

    const buildHeadline = (item) => {
      const href = safeLink(item.link);
      return el("a", {
        class: "cw-headline",
        href: href || "#",
        target: "_blank",
        rel: "noopener noreferrer",
        text: item.title,
        onclick: href ? () => { state.read.add(item.link); persistSets(); } : (e) => e.preventDefault(),
      });
    };
    const sep = () => el("span", { "aria-hidden": "true", style: "color:var(--critical-text);opacity:0.5;" }, document.createTextNode("•"));

    const track = document.getElementById("cw-track");
    track.innerHTML = "";
    // Duplicate the headline set once so the CSS marquee (translateX -50%) loops seamlessly.
    for (let copy = 0; copy < 2; copy++) {
      criticalItems.forEach((item, i) => {
        if (i > 0 || copy > 0) track.appendChild(sep());
        track.appendChild(buildHeadline(item));
      });
    }
    banner.classList.add("show");

    // Keep the scroll speed calm and constant regardless of how many headlines are
    // looping (a fixed duration would scroll faster as more critical items appear).
    const TICKER_PX_PER_SEC = 28;
    const TICKER_MIN_SECONDS = 45;
    const oneCopyWidth = track.scrollWidth / 2;
    const duration = Math.max(TICKER_MIN_SECONDS, oneCopyWidth / TICKER_PX_PER_SEC);
    track.style.animationDuration = `${duration}s`;
  }

  function buildBookStack() {
    // A tiny decorative stack of leaning book spines, used above each stat number.
    return el("span", { class: "stat-books", "aria-hidden": "true" }, [
      el("span", { class: "spine s1" }),
      el("span", { class: "spine s2" }),
      el("span", { class: "spine s3" }),
    ]);
  }

  function renderStats(items) {
    const strip = document.getElementById("stats-strip");
    if (!strip) return;
    const unread = items.filter((i) => !state.read.has(i.link)).length;
    const sources = new Set(items.map((i) => i.source_id)).size;
    const stats = [
      { key: "total", icon: "📰", label: "Total articles", value: items.length },
      { key: "unread", icon: "●", label: "Unread", value: unread },
      { key: "bookmarks", icon: "★", label: "Bookmarks", value: state.bookmarks.size },
      { key: "sources", icon: "◆", label: "Sources", value: sources },
    ];

    // Build the tile DOM once; every later call only updates numbers in place.
    // Rebuilding from scratch each time (as before) would destroy the per-tile
    // dataset.value tracking that animateCount relies on, and would also re-trigger
    // the CSS entrance animation on every filter click instead of just on first load.
    if (!strip.dataset.built) {
      for (const s of stats) {
        strip.appendChild(el("div", { class: "stat-tile", "data-key": s.key }, [
          buildBookStack(),
          el("div", { class: "stat-value" }),
          el("div", { class: "stat-label", text: s.label }),
        ]));
      }
      strip.appendChild(el("div", { class: "stat-tile", id: "stat-reading-time" }, [
        buildBookStack(),
        el("div", { class: "stat-value", text: "0m" }),
        el("div", { class: "stat-label", text: "Reading time today" }),
      ]));
      strip.dataset.built = "1";
    }

    for (const s of stats) {
      const valueEl = strip.querySelector(`.stat-tile[data-key="${s.key}"] .stat-value`);
      if (valueEl) window.CF.animateCount(valueEl, s.value);
    }
    document.dispatchEvent(new CustomEvent("cf:statsrendered"));
  }

  function renderCustomTags() {
    const list = document.getElementById("your-tags-list");
    if (!list) return;
    list.innerHTML = "";
    if (state.customTags.length === 0) {
      list.appendChild(el("span", { id: "your-tags-empty", text: "Add a vendor or keyword to watch for it across articles." }));
      return;
    }
    for (const tag of state.customTags) {
      const chip = el("span", { class: "tag-chip custom-tag-chip" }, [
        el("button", {
          text: tag,
          style: "background:none;border:none;color:inherit;cursor:pointer;padding:0;",
          onclick: () => { state.filters.query = tag; document.getElementById("search").value = tag; renderList(); },
        }),
        el("button", {
          class: "rm",
          text: "×",
          "aria-label": `Remove ${tag}`,
          style: "background:none;border:none;cursor:pointer;padding:0;",
          onclick: (e) => {
            e.stopPropagation();
            state.customTags = state.customTags.filter((t) => t !== tag);
            saveJSON(LS.customTags, state.customTags);
            renderCustomTags();
          },
        }),
      ]);
      list.appendChild(chip);
    }
  }

  function renderTopSources(items) {
    const container = document.getElementById("top-sources-list");
    if (!container) return;
    const counts = new Map();
    for (const i of items) counts.set(i.source, (counts.get(i.source) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = top.length ? top[0][1] : 1;
    container.innerHTML = "";
    for (const [name, count] of top) {
      container.appendChild(el("div", { class: "src-bar-row" }, [
        el("div", { class: "src-bar-label" }, [
          el("span", { text: name }),
          el("span", { class: "n", text: String(count) }),
        ]),
        el("div", { class: "src-bar-track" }, [
          el("div", { class: "src-bar-fill", style: `width:${Math.round((count / max) * 100)}%` }),
        ]),
      ]));
    }
  }

  function renderTrending(items) {
    const counts = new Map();
    for (const it of items) for (const tag of (it.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const container = document.getElementById("trending-chips");
    container.innerHTML = "";
    if (top.length === 0) {
      container.appendChild(el("span", { text: "Not enough data yet.", style: "color:var(--muted)" }));
      return;
    }
    for (const [tag, count] of top) {
      container.appendChild(el("button", {
        class: "pill" + (state.filters.tag === tag ? " on" : ""),
        text: `${tag} (${count})`,
        onclick: () => { state.filters.tag = state.filters.tag === tag ? null : tag; render(); },
      }));
    }
  }

  function renderSidebarLists(items) {
    const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
    const catList = document.getElementById("category-list");
    catList.innerHTML = "";
    for (const cat of categories) {
      catList.appendChild(el("button", {
        class: "cat-btn" + (state.filters.category === cat ? " active" : ""),
        text: cat,
        onclick: () => { state.filters.category = state.filters.category === cat ? null : cat; render(); },
      }));
    }

    const counts = new Map();
    for (const i of items) counts.set(i.source_id, (counts.get(i.source_id) || 0) + 1);
    const sources = [...new Map(items.map((i) => [i.source_id, i.source])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const srcList = document.getElementById("source-list");
    srcList.innerHTML = "";
    for (const [id, name] of sources) {
      srcList.appendChild(el("button", {
        class: "cat-btn src-btn" + (state.filters.source === id ? " active" : ""),
        onclick: () => { state.filters.source = state.filters.source === id ? null : id; render(); },
      }, [
        el("span", { class: "src-name", text: name }),
        el("span", { class: "src-count", text: String(counts.get(id) || 0) }),
      ]));
    }
  }

  function buildCardMedia(item) {
    const realImg = safeImageUrl(item.image);
    const fallback = generateCoverSvg(item.category, (item.tags || [])[0]);
    const img = el("img", {
      class: "card-img",
      loading: "lazy",
      alt: "",
      src: realImg || fallback,
    });
    if (realImg) {
      img.addEventListener("error", () => { img.src = fallback; }, { once: true });
    }
    return el("div", { class: "card-media" }, [img]);
  }

  function renderCard(item) {
    const isRead = state.read.has(item.link);
    const isBookmarked = state.bookmarks.has(item.link);
    const link = safeLink(item.link);

    let titleNode;
    if (link) {
      titleNode = el("a", {
        href: link,
        target: "_blank",
        rel: "noopener noreferrer",
        text: item.title,
        onclick: () => { state.read.add(item.link); persistSets(); renderList(); },
      });
    } else {
      titleNode = el("span", {
        class: "title-disabled",
        text: item.title,
        title: "This article's link could not be verified as safe",
      }, [el("span", { class: "tag-chip", text: "⚠ link unavailable", style: "margin-left:6px;color:var(--critical);" })]);
    }

    const tagsRow = el("div", { class: "tags" }, (item.tags || []).map((t) =>
      el("button", {
        class: "tag-chip",
        text: t,
        style: "cursor:pointer;",
        onclick: () => { state.filters.tag = state.filters.tag === t ? null : t; render(); },
      })
    ));
    if (isCritical(item)) tagsRow.appendChild(el("span", { class: "tag-chip", text: "⚠ critical", style: "color:var(--critical);" }));
    for (const cve of item.cves || []) tagsRow.appendChild(el("span", { class: "tag-chip", text: cve }));

    const badgeClass = CATEGORY_BADGE_CLASS[item.category] || "badge-news";
    const topRow = el("div", { class: "card-top-row" }, [
      item.category ? el("span", { class: `badge ${badgeClass}`, text: item.category }) : null,
      ...(item.cves || []).slice(0, 1).map((cve) => el("span", { class: "tag-chip", text: cve })),
    ]);

    const bookmarkBtn = el("button", {
      class: "icon-btn" + (isBookmarked ? " on" : ""),
      text: isBookmarked ? "★ Bookmarked" : "☆ Bookmark",
      "aria-label": "Toggle bookmark",
      onclick: () => {
        if (isBookmarked) state.bookmarks.delete(item.link); else state.bookmarks.add(item.link);
        persistSets(); render();
      },
    });
    const openBtn = link ? el("a", {
      class: "icon-btn",
      href: link,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "↗ Open",
      "aria-label": "Open original article",
      onclick: () => { state.read.add(item.link); persistSets(); renderList(); },
    }) : null;
    const readBtn = el("button", {
      class: "icon-btn" + (isRead ? " on" : ""),
      text: isRead ? "✓ Read" : "Mark read",
      "aria-label": "Toggle read status",
      onclick: () => {
        if (isRead) state.read.delete(item.link); else state.read.add(item.link);
        persistSets(); render();
      },
    });

    return el("article", {
      class: `card ${state.view === "compact" ? "compact" : ""} ${isRead ? "read" : "unread"}`,
      role: "listitem",
    }, [
      buildCardMedia(item),
      el("div", { class: "card-body" }, [
        topRow,
        el("h3", {}, titleNode),
        el("div", { class: "meta" }, [
          el("span", { text: item.source }),
          el("span", { text: "•" }),
          el("span", { text: formatDate(item.published) }),
        ]),
        el("p", { class: "snippet", text: item.summary }),
        tagsRow,
        el("div", { class: "card-actions" }, [bookmarkBtn, openBtn, readBtn]),
      ]),
    ]);
  }

  function renderList() {
    const dir = state.sort === "oldest" ? 1 : -1;
    const filtered = state.items.filter(matchesFilters).sort((a, b) =>
      dir * (new Date(b.published || 0) - new Date(a.published || 0))
    ).slice(0, 300);

    const container = document.getElementById("articles");
    container.innerHTML = "";
    document.getElementById("loading").style.display = "none";
    const emptyEl = document.getElementById("empty-state");
    emptyEl.style.display = filtered.length ? "none" : "block";
    if (!filtered.length) {
      emptyEl.textContent = state.items.length
        ? "No articles match your filters."
        : (location.protocol === "file:"
          ? "Couldn't load any articles. This page was opened as a local file, and browsers block it from reading feeds.json that way. Serve this folder over http(s) instead, e.g. run `python -m http.server` here and open http://localhost:8000."
          : "Couldn't load any articles right now. The feed snapshot and live sources are both unreachable. Try Refresh in a moment.");
    }
    document.getElementById("result-count").textContent = `${filtered.length} article${filtered.length === 1 ? "" : "s"}`;
    for (const item of filtered) container.appendChild(renderCard(item));
  }

  function render() {
    renderList();
    renderTrending(state.items);
    renderSidebarLists(state.items);
    renderCriticalBanner(state.items);
    renderStats(state.items);
    renderTopSources(state.items);
    renderCustomTags();
    syncTimeButtons();
    syncStatusButtons();
  }

  function syncTimeButtons() {
    document.querySelectorAll("[data-time]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.time === state.filters.time);
    });
  }
  function syncStatusButtons() {
    document.querySelectorAll("[data-status]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.status === state.filters.status);
    });
  }

  // ---------- View tabs ----------
  function wireViewTabs() {
    document.querySelectorAll("[data-view-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.CF.setView(btn.dataset.viewTab);
        syncViewTabs();
      });
    });
    document.addEventListener("cf:viewchange", syncViewTabs);
    const saved = localStorage.getItem(LS.activeView) || "news";
    window.CF.setView(saved);
    syncViewTabs();
  }
  function syncViewTabs() {
    const current = document.documentElement.getAttribute("data-view") || "news";
    document.querySelectorAll("[data-view-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.viewTab === current);
    });
  }

  // ---------- Controls ----------
  function wireControls() {
    wireViewTabs();

    document.querySelectorAll("[data-time]").forEach((btn) => {
      btn.addEventListener("click", () => { state.filters.time = btn.dataset.time; render(); });
    });
    document.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filters.status = state.filters.status === btn.dataset.status ? null : btn.dataset.status;
        render();
      });
    });

    let debounceTimer;
    document.getElementById("search").addEventListener("input", (e) => {
      clearTimeout(debounceTimer);
      const val = e.target.value;
      debounceTimer = setTimeout(() => { state.filters.query = val; renderList(); }, 200);
    });

    document.getElementById("sort-select").addEventListener("change", (e) => {
      state.sort = e.target.value;
      renderList();
    });

    document.getElementById("nav-home").addEventListener("click", () => {
      state.filters = { time: "all", status: null, category: null, source: null, tag: null, query: "" };
      document.getElementById("search").value = "";
      render();
    });
    document.getElementById("nav-my-feed").addEventListener("click", () => {
      state.filters.status = state.filters.status === "bookmarked" ? null : "bookmarked";
      render();
    });

    const cwPauseBtn = document.getElementById("cw-pause-btn");
    cwPauseBtn.addEventListener("click", () => {
      const banner = document.getElementById("critical-banner");
      const nowPaused = banner.classList.toggle("paused");
      cwPauseBtn.textContent = nowPaused ? "▶" : "⏸";
      cwPauseBtn.setAttribute("aria-pressed", String(nowPaused));
      cwPauseBtn.setAttribute("aria-label", nowPaused ? "Resume ticker" : "Pause ticker");
    });

    document.getElementById("tag-add-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("tag-add-input");
      const value = input.value.trim();
      if (!value) return;
      if (!state.customTags.some((t) => t.toLowerCase() === value.toLowerCase())) {
        state.customTags.push(value);
        saveJSON(LS.customTags, state.customTags);
        renderCustomTags();
      }
      input.value = "";
    });

    const root = document.documentElement;
    document.getElementById("theme-toggle").addEventListener("click", () => {
      // CyberFeed's default identity is light (no media-query fallback); only an explicit
      // data-theme="dark" attribute switches it, so that's the only case treated as "dark".
      const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem(LS.theme, next);
    });
    const savedTheme = localStorage.getItem(LS.theme);
    if (savedTheme) root.setAttribute("data-theme", savedTheme);

    document.getElementById("view-toggle").addEventListener("click", () => {
      state.view = state.view === "card" ? "compact" : "card";
      localStorage.setItem(LS.view, state.view);
      renderList();
    });

    document.getElementById("export-btn").addEventListener("click", () => {
      const payload = {
        bookmarks: [...state.bookmarks],
        read: [...state.read],
        customFeeds: state.customFeeds,
        customTags: state.customTags,
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cyberfeed-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-file").click());
    document.getElementById("import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (Array.isArray(data.bookmarks)) state.bookmarks = new Set(data.bookmarks);
        if (Array.isArray(data.read)) state.read = new Set(data.read);
        if (Array.isArray(data.customFeeds)) state.customFeeds = data.customFeeds;
        if (Array.isArray(data.customTags)) state.customTags = data.customTags;
        persistSets();
        saveJSON(LS.customFeeds, state.customFeeds);
        saveJSON(LS.customTags, state.customTags);
        render();
        alert("Import complete.");
      } catch (err) {
        alert("Import failed: invalid file.");
      }
      e.target.value = "";
    });

    document.getElementById("help-btn").addEventListener("click", () => {
      alert("Keyboard shortcuts:\n/ : focus search\nj/k : next/previous article\no : open focused article\nb : bookmark focused article\nt : toggle theme\nEsc : clear search focus");
    });

    let focusedIndex = -1;
    function getCards() { return [...document.querySelectorAll("#articles .card")]; }
    function setFocusCard(i) {
      const cards = getCards();
      if (!cards.length) return;
      focusedIndex = Math.max(0, Math.min(i, cards.length - 1));
      cards.forEach((c, idx) => c.style.outline = idx === focusedIndex ? "2px solid var(--accent)" : "none");
      cards[focusedIndex].scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("keydown", (e) => {
      if ((document.documentElement.getAttribute("data-view") || "news") !== "news") return;
      if (!document.getElementById("onboarding-modal").hidden) return;
      const activeTag = document.activeElement.tagName;
      if ((e.key === "/" && activeTag !== "INPUT") || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        document.getElementById("search").focus();
        return;
      }
      if (activeTag === "INPUT") {
        if (e.key === "Escape") document.activeElement.blur();
        return;
      }
      if (e.key === "j") setFocusCard(focusedIndex + 1);
      else if (e.key === "k") setFocusCard(focusedIndex - 1);
      else if (e.key === "t") document.getElementById("theme-toggle").click();
      else if (e.key === "o") {
        const cards = getCards();
        if (cards[focusedIndex]) cards[focusedIndex].querySelector("h3 a")?.click();
      } else if (e.key === "b") {
        const cards = getCards();
        cards[focusedIndex]?.querySelector(".card-actions .icon-btn")?.click();
      }
    });
  }

  // ---------- Onboarding ----------
  function updateHeroGreeting() {
    const name = localStorage.getItem(LS.userName);
    const greetingEl = document.getElementById("hero-greeting");
    const subEl = document.getElementById("hero-sub");
    if (name) {
      greetingEl.textContent = `Welcome back, ${name}.`;
      subEl.textContent = "Your daily cybersecurity intelligence is ready.";
    } else {
      greetingEl.textContent = "Welcome to CyberFeed.";
      subEl.textContent = "Your daily cybersecurity briefing, aggregated from trusted sources.";
    }
  }

  function updateProfileBtn() {
    const name = localStorage.getItem(LS.userName);
    document.getElementById("profile-btn").textContent = name ? name.trim()[0].toUpperCase() : "?";
  }

  function wireOnboarding() {
    const modal = document.getElementById("onboarding-modal");
    const input = document.getElementById("onboarding-input");
    const continueBtn = document.getElementById("onboarding-continue");
    const skipBtn = document.getElementById("onboarding-skip");
    let editingExisting = false;

    function openModal(editing) {
      editingExisting = editing;
      input.value = editing ? (localStorage.getItem(LS.userName) || "") : "";
      skipBtn.textContent = editing ? "Cancel" : "Skip for now";
      modal.hidden = false;
      input.focus();
    }
    function closeModal() {
      modal.hidden = true;
    }
    function submit() {
      const value = input.value.trim();
      if (!value) {
        if (editingExisting) {
          // Clearing the name while editing resets to the anonymous default.
          localStorage.removeItem(LS.userName);
          updateHeroGreeting();
          updateProfileBtn();
          closeModal();
        }
        // First-run with an empty name: ignore (name stays unset, modal stays open).
        return;
      }
      localStorage.setItem(LS.userName, value);
      localStorage.setItem(LS.onboardingDismissed, "1");
      updateHeroGreeting();
      updateProfileBtn();
      closeModal();
    }

    continueBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); localStorage.setItem(LS.onboardingDismissed, "1"); closeModal(); }
    });
    skipBtn.addEventListener("click", () => {
      localStorage.setItem(LS.onboardingDismissed, "1");
      closeModal();
    });
    document.getElementById("profile-btn").addEventListener("click", () => openModal(true));

    if (!localStorage.getItem(LS.userName) && !localStorage.getItem(LS.onboardingDismissed)) {
      openModal(false);
    }
    updateHeroGreeting();
    updateProfileBtn();
  }

  // ---------- Live updates ----------
  function setLiveDot(stale) {
    const dot = document.getElementById("live-dot");
    if (dot) dot.classList.toggle("stale", !!stale);
  }

  function updateFeedUpdatedText() {
    const label = document.getElementById("feed-updated-text");
    if (!label) return;
    label.textContent = state.generatedAt ? formatDate(state.generatedAt) : "unknown";
  }

  function renderNewArticlesBanner() {
    const banner = document.getElementById("new-articles-banner");
    const btn = document.getElementById("new-articles-btn");
    if (!banner || !btn) return;
    const n = state.incoming.length;
    if (n === 0) {
      banner.classList.remove("show");
      return;
    }
    btn.textContent = `↑ ${n} new ${n === 1 ? "story" : "stories"} available. Click to load`;
    banner.classList.add("show");
  }

  function mergeIncoming() {
    if (!state.incoming.length) return;
    const seen = new Set(state.items.map((i) => i.link));
    const fresh = state.incoming.filter((i) => !seen.has(i.link));
    state.items = [...fresh, ...state.items];
    state.incoming = [];
    renderNewArticlesBanner();
    render();
    document.getElementById("feed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function pollFeeds() {
    const btn = document.getElementById("refresh-btn");
    btn?.classList.add("spinning");
    try {
      if (state.feedSource === "snapshot") {
        const res = await fetch(FEEDS_JSON_URL, { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        if (!data || !Array.isArray(data.items)) throw new Error("bad payload");
        if (data.generated_at) state.generatedAt = data.generated_at;
        const known = new Set([...state.items, ...state.incoming].map((i) => i.link));
        const fresh = data.items.filter((i) => !known.has(i.link));
        if (fresh.length) {
          state.incoming = [...fresh, ...state.incoming];
          renderNewArticlesBanner();
        }
      } else {
        const result = await fetchLiveViaProxies();
        state.generatedAt = result.generatedAt;
        const known = new Set([...state.items, ...state.incoming].map((i) => i.link));
        const fresh = result.items.filter((i) => !known.has(i.link));
        if (fresh.length) {
          state.incoming = [...fresh, ...state.incoming];
          renderNewArticlesBanner();
        }
      }
      setLiveDot(false);
    } catch (e) {
      console.warn("Live poll failed, will retry", e);
      setLiveDot(true);
    } finally {
      updateFeedUpdatedText();
      btn?.classList.remove("spinning");
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    const interval = POLL_INTERVAL[state.feedSource] || POLL_INTERVAL.snapshot;
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      pollFeeds();
    }, interval);
  }

  function wireLiveUpdates() {
    document.getElementById("refresh-btn")?.addEventListener("click", () => pollFeeds());
    document.getElementById("new-articles-btn")?.addEventListener("click", mergeIncoming);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollFeeds();
    });
    setInterval(updateFeedUpdatedText, 30000);
    startPolling();
  }

  // ---------- Init ----------
  async function init() {
    wireControls();
    wireOnboarding();
    const result = await loadFeeds();
    state.items = result.items;
    state.generatedAt = result.generatedAt || null;
    state.feedSource = result.source || "snapshot";
    document.getElementById("loading").style.display = "none";
    render();
    updateFeedUpdatedText();
    wireLiveUpdates();
  }

  init();
})();
