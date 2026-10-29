<p align="center">
  <strong>Your personal cybersecurity intelligence hub.</strong>
  <br />
  <sub>Security news. Threat intelligence. Continuous learning.</sub>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/54edf6ac-ad1c-4155-843a-52817f562faf" width="100%" alt="CyberFeed dashboard preview" />
</p>

CyberFeed brings cybersecurity news, threat advisories, vulnerability reports, and security research from trusted sources into one interface. It also includes a personal PDF library with an integrated, book style reader for self paced learning.

**Lightweight by design.** No backend server, build step, or paid services required.

## <span style="color:#38BDF8">Features</span>

<table>
  <tr>
    <td width="50%">
      <h3>Cybersecurity News</h3>
      <p>Aggregates updates from 13 cybersecurity sources.</p>
      <ul>
        <li>Search and filter articles</li>
        <li>Bookmark and track read status</li>
        <li>Highlight critical security updates</li>
      </ul>
    </td>
    <td width="50%">
      <h3>Personal PDF Library</h3>
      <p>A dedicated space for security research and study materials.</p>
      <ul>
        <li>Import and read PDF books</li>
        <li>Store files locally with IndexedDB</li>
        <li>Navigate pages and chapters with keyboard shortcuts</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>Privacy First</h3>
      <ul>
        <li>No account required</li>
        <li>Local browser storage for preferences and bookmarks</li>
        <li>Content Security Policy included</li>
      </ul>
    </td>
    <td width="50%">
      <h3>Simple Setup</h3>
      <ul>
        <li>No frontend build process</li>
        <li>Python standard library for feed fetching</li>
        <li>Runs locally in your browser</li>
      </ul>
    </td>
  </tr>
</table>

## <span style="color:#38BDF8">Quick Start</span>

### 1. Clone the repository

```bash
git clone <repository-url>
cd CyberFeed
```

### 2. Fetch the latest feeds

```bash
python fetch_feeds.py
```

### 3. Start the local server

```bash
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## <span style="color:#38BDF8">Project Structure</span>

```text
CyberFeed/
├── index.html
├── app.js
├── books.js
├── render-helpers.js
├── fetch_feeds.py
├── feeds.json
└── README.md
```

## <span style="color:#38BDF8">Technology Stack</span>

| Component | Technology |
|:--|:--|
| Frontend | HTML, CSS, JavaScript |
| Feed Fetcher | Python |
| News Aggregation | RSS and Atom |
| Browser Storage | LocalStorage and IndexedDB |
| PDF Rendering | PDF.js |

## <span style="color:#38BDF8">News Sources</span>

CyberFeed's feed sources are configured in [`feeds.json`](feeds.json), making it easier to maintain and update the source list.

## <span style="color:#38BDF8">Limitations</span>

- Feed updates require running the Python fetcher.
- Books, bookmarks, and preferences are stored locally in the browser.
- Cloud synchronization and user accounts are not supported.

## <span style="color:#38BDF8">License</span>

Distributed under the MIT License. See [`LICENSE`](LICENSE) for details.

---

<p align="center">
  <sub>Built for curiosity, continuous learning, and better security awareness.</sub>
</p>
