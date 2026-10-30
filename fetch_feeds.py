#!/usr/bin/env python3
"""Fetch cybersecurity news RSS/Atom feeds and write feeds.json.

Stdlib only (urllib, xml.etree, json) so it runs with plain `python fetch_feeds.py`,
no pip installs required.
"""
import json
import re
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape

OUTPUT_FILE = "feeds.json"
TIMEOUT = 15
USER_AGENT = "CyberFeedBot/1.0 (+https://github.com/; personal RSS aggregator)"
MAX_ITEMS_PER_SOURCE = 40

SOURCES = [
    {"id": "thehackernews", "name": "The Hacker News", "url": "https://feeds.feedburner.com/TheHackersNews", "category": "News"},
    {"id": "bleepingcomputer", "name": "BleepingComputer", "url": "https://www.bleepingcomputer.com/feed/", "category": "News"},
    {"id": "krebsonsecurity", "name": "Krebs on Security", "url": "https://krebsonsecurity.com/feed/", "category": "News"},
    {"id": "darkreading", "name": "Dark Reading", "url": "https://www.darkreading.com/rss.xml", "category": "News"},
    {"id": "securityweek", "name": "SecurityWeek", "url": "https://www.securityweek.com/feed/", "category": "News"},
    {"id": "schneier", "name": "Schneier on Security", "url": "https://www.schneier.com/feed/atom/", "category": "Analysis"},
    {"id": "sophosnews", "name": "Sophos News", "url": "https://news.sophos.com/en-us/feed", "category": "Vendor"},
    {"id": "cisa", "name": "CISA Advisories", "url": "https://www.cisa.gov/cybersecurity-advisories/all.xml", "category": "Advisory"},
    {"id": "msrc", "name": "Microsoft Security Blog", "url": "https://www.microsoft.com/en-us/security/blog/feed/", "category": "Vendor"},
    {"id": "talos", "name": "Cisco Talos", "url": "https://blog.talosintelligence.com/rss/", "category": "Research"},
    {"id": "unit42", "name": "Unit 42 (Palo Alto)", "url": "https://unit42.paloaltonetworks.com/feed/", "category": "Research"},
    {"id": "crowdstrike", "name": "CrowdStrike Blog", "url": "https://www.crowdstrike.com/blog/feed/", "category": "Vendor"},
    {"id": "therecord", "name": "The Record", "url": "https://therecord.media/feed/", "category": "News"},
    {"id": "sans_isc", "name": "SANS Internet Storm Center", "url": "https://isc.sans.edu/rssfeed_full.xml", "category": "Research"},
    {"id": "theregister", "name": "The Register Security", "url": "https://www.theregister.com/security/headlines.atom", "category": "News"},
    {"id": "projectzero", "name": "Google Project Zero", "url": "https://projectzero.google/feed.xml", "category": "Research"},
    {"id": "malwarebytes", "name": "Malwarebytes Labs", "url": "https://www.malwarebytes.com/blog/feed/index.xml", "category": "Vendor"},
    {"id": "securityaffairs", "name": "Security Affairs", "url": "https://securityaffairs.com/feed", "category": "News"},
]

TAG_RULES = {
    "ransomware": ["ransomware", "lockbit", "ransom "],
    "malware": ["malware", "trojan", "backdoor"],
    "phishing": ["phishing", "smishing"],
    "vulnerability": ["vulnerability", "cve-", "exploit", "zero-day", "0-day"],
    "data breach": ["data breach", "breach", "leaked data"],
    "nation-state": ["nation-state", "apt", "state-sponsored"],
    "cloud": ["aws", "azure", "google cloud", "cloud security"],
    "critical infrastructure": ["critical infrastructure", "ics", "scada", "ot security"],
}

CVE_RE = re.compile(r"CVE-\d{4}-\d{4,7}", re.IGNORECASE)
IMG_SRC_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)


def strip_html(text):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def is_valid_https_url(url):
    """Stricter check for images: the page's CSP only allows img-src https:."""
    if not url:
        return False
    try:
        from urllib.parse import urlparse
        return urlparse(url).scheme == "https"
    except ValueError:
        return False


def extract_image(element, raw_html_for_fallback=""):
    """Find an item/entry image via media:thumbnail, enclosure, itunes:image,
    or the first <img> in the raw description HTML, in that priority order."""
    for child in element:
        name = local_name(child.tag)
        if name == "thumbnail":
            url = child.get("url")
            if is_valid_https_url(url):
                return url
    for child in element:
        if local_name(child.tag) == "enclosure" and (child.get("type") or "").startswith("image/"):
            url = child.get("url")
            if is_valid_https_url(url):
                return url
    for child in element:
        if local_name(child.tag) == "image" and child.get("href"):
            url = child.get("href")
            if is_valid_https_url(url):
                return url
    match = IMG_SRC_RE.search(raw_html_for_fallback or "")
    if match and is_valid_https_url(match.group(1)):
        return match.group(1)
    return None


def parse_date(raw):
    if not raw:
        return None
    raw = raw.strip()
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except ValueError:
            continue
    return None


def auto_tag(title, summary):
    haystack = f"{title} {summary}".lower()
    tags = [tag for tag, keywords in TAG_RULES.items() if any(kw in haystack for kw in keywords)]
    cves = sorted(set(m.upper() for m in CVE_RE.findall(f"{title} {summary}")))
    return tags, cves


def fetch_raw(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def fetch_with_retry(url, retries=2, backoff=2):
    last_err = None
    for attempt in range(retries + 1):
        try:
            return fetch_raw(url)
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
    raise last_err


def local_name(tag):
    return tag.split("}")[-1] if "}" in tag else tag


def parse_rss(root):
    items = []
    for item in root.iter():
        if local_name(item.tag) != "item":
            continue
        fields = {local_name(c.tag): (c.text or "") for c in item}
        link = fields.get("link", "").strip()
        guid_el = item.find("guid")
        if not link and guid_el is not None and (guid_el.text or "").startswith("http"):
            link = guid_el.text.strip()
        raw_description = fields.get("description", "") or fields.get("encoded", "")
        items.append({
            "title": strip_html(fields.get("title", "")),
            "link": link,
            "summary": strip_html(raw_description)[:320],
            "published": parse_date(fields.get("pubDate", "")),
            "image": extract_image(item, raw_description),
        })
    return items


def parse_atom(root):
    items = []
    for entry in root.iter():
        if local_name(entry.tag) != "entry":
            continue
        title = ""
        summary = ""
        link = ""
        published = None
        for c in entry:
            name = local_name(c.tag)
            if name == "title":
                title = c.text or ""
            elif name in ("summary", "content"):
                summary = c.text or summary
            elif name == "link":
                href = c.get("href")
                rel = c.get("rel", "alternate")
                if href and (not link or rel == "alternate"):
                    link = href
            elif name in ("published", "updated") and not published:
                published = c.text
        items.append({
            "title": strip_html(title),
            "link": link.strip(),
            "summary": strip_html(summary)[:320],
            "published": parse_date(published),
            "image": extract_image(entry, summary),
        })
    return items


def parse_feed(raw_bytes):
    root = ET.fromstring(raw_bytes)
    tag = local_name(root.tag)
    if tag == "feed":
        return parse_atom(root)
    return parse_rss(root)


def normalize_url(url):
    if not url:
        return url
    url = url.split("#")[0]
    if "?" in url:
        base, query = url.split("?", 1)
        kept = [p for p in query.split("&") if p and not p.split("=")[0].startswith("utm_")]
        url = base + ("?" + "&".join(kept) if kept else "")
    return url.rstrip("/")


def fetch_source(source):
    report = {"id": source["id"], "name": source["name"], "ok": False, "count": 0, "error": None, "fetched_at": datetime.now(timezone.utc).isoformat()}
    try:
        raw = fetch_with_retry(source["url"])
        items = parse_feed(raw)[:MAX_ITEMS_PER_SOURCE]
        for it in items:
            it["link"] = normalize_url(it["link"])
            it["source"] = source["name"]
            it["source_id"] = source["id"]
            it["category"] = source["category"]
            tags, cves = auto_tag(it["title"], it["summary"])
            it["tags"] = tags
            it["cves"] = cves
        report["ok"] = True
        report["count"] = len(items)
        return items, report
    except Exception as e:
        report["error"] = f"{type(e).__name__}: {e}"
        return [], report


def main():
    all_items = []
    health = []
    for source in SOURCES:
        items, report = fetch_source(source)
        all_items.extend(items)
        health.append(report)
        status = "OK" if report["ok"] else f"FAILED ({report['error']})"
        print(f"[{source['id']}] {status} - {report['count']} items")

    all_items = [it for it in all_items if it.get("link") and it.get("title")]
    seen = set()
    deduped = []
    for it in all_items:
        if it["link"] in seen:
            continue
        seen.add(it["link"])
        deduped.append(it)

    deduped.sort(key=lambda x: x.get("published") or "", reverse=True)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": deduped,
        "health": health,
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    ok_count = sum(1 for h in health if h["ok"])
    print(f"\nWrote {len(deduped)} items from {ok_count}/{len(SOURCES)} sources to {OUTPUT_FILE}")
    return 0 if ok_count > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
