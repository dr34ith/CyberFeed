# CyberFeed

Personal cybersecurity news aggregator. No backend server, no build step, no paid services.

## Quick start

```bash
# 1. Fetch the latest articles from 13 cybersecurity sources (stdlib only, no pip install needed)
python fetch_feeds.py

# 2. Serve the folder locally
python -m http.server 8000

# 3. Open http://localhost:8000/index.html
```

The page reads `feeds.json` first. If it's missing or stale (e.g. you open `index.html`
without ever running the fetcher), the page falls back to fetching the same sources live,
in-browser, through public CORS proxies.

## Project structure

```
index.html          - page shell, markup, CSP, news/library/reader view containers
render-helpers.js   - shared DOM/formatting helpers (window.CF namespace), loaded first
app.js              - news feed logic (fetch/parse, render, filters, state)
books.js            - book feed: IndexedDB storage, pdf.js lazy-load, reader, reading timer
fetch_feeds.py      - stdlib-only fetcher, writes feeds.json
feeds.json          - generated snapshot (git-ignored except on CI; regenerate locally)
README.md           - this file
```

## Features

- Reads 13 cybersecurity RSS/Atom sources (news, advisories, vendor research blogs)
- Hero briefing with a live stats strip (total articles, unread, bookmarks, sources,
  reading time today)
- Search, time filter (24h/7d/30d), category/source/tag filters
- Auto-tagging (ransomware, malware, phishing, vulnerability, CVE extraction, etc.)
- Trending topics panel
- Critical Watch banner for high-severity keyword matches
- Per-article cover images: shows the feed's own thumbnail when it provides one
  (`media:thumbnail`, `enclosure`, `itunes:image`, or the first `<img>` in the article
  body), otherwise a locally generated gradient cover. Never a broken image, never a
  random stock photo.
- Bookmarks and read/unread tracking, persisted in `localStorage`
- Dark/light theme (follows system preference by default, toggle overrides)
- Card / compact view toggle
- Export/import of bookmarks, read state, and custom feeds as JSON
- Keyboard shortcuts (News view): `/` search, `j`/`k` navigate, `o` open, `b` bookmark, `t` theme
- Content is sanitized before insertion (no raw HTML from feeds ever reaches the DOM),
  links are restricted to http(s), and a CSP meta tag is set. A link that fails
  validation renders as a visibly disabled "⚠ link unavailable" title instead of a
  silent dead link.

### Book feed (PDF reader)

Switch to the **Books** tab to upload a PDF and read it in-page like a book:

- Upload via **+ Add PDF**; the file is parsed and rendered entirely in your browser
  with [pdf.js](https://mozilla.github.io/pdf.js/) (loaded from cdnjs, pinned to
  `3.11.174`, only when you open the Books tab; it never loads on a normal news visit).
- PDFs are stored **only in this browser** (IndexedDB). Nothing is uploaded anywhere,
  and books don't sync across devices/browsers.
- Page navigation (prev/next/jump) and zoom (50%–300%); your last-read page and zoom
  level are remembered per book.
- A reading timer runs while a book is open, pausing automatically when you switch
  tabs away (Page Visibility API) and resuming when you come back. Total time read per
  book is shown in the library list, and today's total appears in the news view's
  stats strip.

## Sources

See `SOURCES` in `fetch_feeds.py`. Three originally-planned sources had dead feed URLs
and were swapped for working ones:

- Sophos News feed URL needed a trailing-slash fix.
- MSRC blog feed is dead, replaced with the Microsoft Security Blog feed.
- Google Cloud/Mandiant threat-intel RSS is dead, replaced with Cisco Talos.

## Content security policy

```
default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src https: data: blob:; connect-src *; base-uri 'self'; form-action 'none'
```

`script-src`/`worker-src` allow exactly one external host (cdnjs) for the pdf.js
library and its worker: the one approved third-party dependency in this project.
`img-src` allows `https:` (feed-provided article thumbnails), `data:` (generated
gradient covers), and `blob:` (pdf.js page rendering). `connect-src *` is kept open
deliberately for the CORS-proxy live-feed fallback.

## Known limitations

- No backend scheduling yet. You must run `fetch_feeds.py` manually to refresh `feeds.json`.
- No dedupe across sources, no CISA KEV panel, no CVE/CVSS enrichment, no PWA/offline support yet.
- Article list is capped at 300 rendered items (no pagination/virtualization yet).
- Book feed is upload + paginated read + timer only: no text search within PDFs, no
  annotations/highlights, no PDF-metadata-derived titles.
- These are planned for v2. See the roadmap discussed with the project owner.

## Roadmap

v2 plan (sources.json-driven fetcher, cross-source dedupe, CISA KEV panel, CVE/CVSS
enrichment, watchlist/alerts, scoring, daily digest, OPML source management, PWA,
charts, GitHub Actions auto-update + Pages deploy) is tracked separately and built in
milestones after v1 sign-off.
