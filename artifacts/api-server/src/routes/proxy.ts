import { Router, type Request, type Response } from "express";
import { parse as parseHtml, HTMLElement as NHtmlElement } from "node-html-parser";

const router = Router();

// ─── In-memory resource cache (survives for 5 minutes) ────────────────────────
interface CacheEntry {
  status: number;
  contentType: string;
  body: Buffer;
  expiresAt: number;
}
const resourceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(url: string): CacheEntry | undefined {
  const entry = resourceCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { resourceCache.delete(url); return undefined; }
  return entry;
}
function cacheSet(url: string, entry: CacheEntry) {
  // Keep cache bounded — evict oldest entries when over 200 items
  if (resourceCache.size >= 200) {
    const oldest = [...resourceCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) resourceCache.delete(oldest[0]);
  }
  resourceCache.set(url, entry);
}

// ─── Per-domain request queue to prevent rate limiting ────────────────────────
const domainQueues = new Map<string, Promise<void>>();
const MIN_DELAY_MS = 50; // minimum delay between requests to the same domain

async function fetchWithQueue(targetUrl: string, headers: Record<string, string>): Promise<globalThis.Response> {
  const domain = new URL(targetUrl).hostname;
  const prev = domainQueues.get(domain) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  domainQueues.set(domain, prev.then(() => next));

  await prev;
  const delay = new Promise<void>((r) => setTimeout(r, MIN_DELAY_MS));
  try {
    return await fetch(targetUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } finally {
    await delay;
    resolve();
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────
function resolveUrl(base: string, relative: string): string {
  try { return new URL(relative, base).href; } catch { return relative; }
}

function rewriteUrl(url: string, base: string): string {
  const t = url.trim();
  if (
    !t ||
    t.startsWith("data:") ||
    t.startsWith("javascript:") ||
    t.startsWith("#") ||
    t.startsWith("blob:") ||
    t.startsWith("mailto:") ||
    t.startsWith("tel:")
  ) return url;
  const abs = /^https?:\/\//i.test(t) ? t : resolveUrl(base, t);
  return `/api/proxy?url=${encodeURIComponent(abs)}`;
}

// ─── HTML rewriter using node-html-parser ─────────────────────────────────────
const REWRITE_HREF = new Set(["a", "link", "base", "area"]);
const REWRITE_SRC  = new Set(["script", "img", "source", "track", "iframe", "frame", "embed", "audio", "video", "input"]);
const REWRITE_ACTION = new Set(["form"]);

function rewriteHtml(html: string, base: string): string {
  const root = parseHtml(html, {
    lowerCaseTagName: false,
    comment: true,
    fixNestedATags: false,
    parseNoneClosedTags: false,
  });

  // Walk every element
  for (const el of root.querySelectorAll("*")) {
    const tag = el.rawTagName?.toLowerCase() ?? "";

    // href
    if (REWRITE_HREF.has(tag)) {
      const href = el.getAttribute("href");
      if (href) el.setAttribute("href", rewriteUrl(href, base));
    }

    // src
    if (REWRITE_SRC.has(tag)) {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", rewriteUrl(src, base));
    }

    // srcset
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const rewritten = srcset
        .split(",")
        .map((part) => {
          const [u, ...rest] = part.trim().split(/\s+/);
          if (!u) return part;
          return [rewriteUrl(u, base), ...rest].join(" ");
        })
        .join(", ");
      el.setAttribute("srcset", rewritten);
    }

    // action (forms)
    if (REWRITE_ACTION.has(tag)) {
      const action = el.getAttribute("action");
      if (action) el.setAttribute("action", rewriteUrl(action, base));
    }

    // style attribute — rewrite url()
    const styleAttr = el.getAttribute("style");
    if (styleAttr) {
      el.setAttribute("style", rewriteCssUrls(styleAttr, base));
    }

    // <style> tags — rewrite url() inside them
    if (tag === "style") {
      el.set_content(rewriteCssUrls(el.text, base));
    }

    // Remove base tags from the original page — we'll inject our own
    if (tag === "base") {
      el.remove();
    }
  }

  // Inject a base tag so relative URLs that slipped through still resolve
  // We inject at the very top of <head> so it takes precedence
  const headEl = root.querySelector("head");
  const injectedBase = `<base href="${base}">`;
  const injectedScript = `<script>
(function() {
  // Intercept fetch()
  var _origFetch = window.fetch;
  window.fetch = function(resource, init) {
    if (typeof resource === 'string' && /^https?:\\/\\//.test(resource)) {
      resource = '/api/proxy?url=' + encodeURIComponent(resource);
    }
    return _origFetch.call(this, resource, init);
  };
  // Intercept XMLHttpRequest.open()
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && /^https?:\\/\\//.test(url)) {
      url = '/api/proxy?url=' + encodeURIComponent(url);
    }
    return _origOpen.apply(this, arguments);
  };
})();
</script>`;

  if (headEl) {
    headEl.set_content(injectedScript + headEl.innerHTML);
  } else {
    // No <head> — fall back to string prepend
    return injectedScript + root.toString();
  }

  return root.toString();
}

// ─── CSS url() rewriter ───────────────────────────────────────────────────────
function rewriteCssUrls(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_match, _q, val) => {
    if (val.startsWith("data:")) return _match;
    return `url("${rewriteUrl(val.trim(), base)}")`;
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (_match, q, val) => {
    return `@import ${q}${rewriteUrl(val, base)}${q}`;
  }).replace(/@import\s+url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_match, _q, val) => {
    return `@import url("${rewriteUrl(val.trim(), base)}")`;
  });
}

// ─── Headers ─────────────────────────────────────────────────────────────────
const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "x-xss-protection",
  "set-cookie",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
]);

function buildRequestHeaders(req: Request, targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "accept": req.headers["accept"] ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "identity", // no compression — simpler to handle
    "cache-control": "no-cache",
    "pragma": "no-cache",
  };

  // Forward referer, but de-proxy it
  const rawReferer = req.headers["referer"];
  if (rawReferer) {
    try {
      const refUrl = new URL(rawReferer);
      const originalRef = refUrl.searchParams.get("url");
      if (originalRef) headers["referer"] = originalRef;
    } catch { /* ignore */ }
  }

  // Cookie passthrough (optional — omit for privacy)
  // const cookie = req.headers["cookie"];
  // if (cookie) headers["cookie"] = cookie;

  return headers;
}

// ─── Route ────────────────────────────────────────────────────────────────────
async function handleProxy(req: Request, res: Response) {
  const rawUrl = req.query["url"] as string | undefined;

  if (!rawUrl) {
    res.status(400).json({ error: "Missing ?url= query parameter" });
    return;
  }

  let targetUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      res.status(400).json({ error: "Only http and https URLs are supported" });
      return;
    }
    targetUrl = parsed.href;
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  // Check cache first (for non-HTML resources)
  const cached = cacheGet(targetUrl);
  if (cached) {
    res.status(cached.status);
    res.setHeader("content-type", cached.contentType);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("x-proxy-cache", "HIT");
    res.send(cached.body);
    return;
  }

  let upstream: globalThis.Response;
  try {
    const fetchOpts: RequestInit = {
      method: req.method,
      headers: buildRequestHeaders(req, targetUrl),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    };
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
        fetchOpts.body = parts.join("&");
        (fetchOpts.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
      } else if (ct.includes("application/json")) {
        fetchOpts.body = JSON.stringify(req.body);
        (fetchOpts.headers as Record<string, string>)["content-type"] = "application/json";
      }
    }
    upstream = await fetch(targetUrl, fetchOpts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Failed to fetch: ${msg}` });
    return;
  }

  // Build safe response headers
  for (const [key, value] of upstream.headers.entries()) {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("x-frame-options", "ALLOWALL");
  res.setHeader("content-security-policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.removeHeader("content-encoding"); // we always serve uncompressed

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = upstream.url || targetUrl;

  if (contentType.includes("text/html")) {
    const text = await upstream.text();
    const rewritten = rewriteHtml(text, finalUrl);
    const buf = Buffer.from(rewritten, "utf8");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-length", buf.length);
    res.status(upstream.status).send(buf);
    // Don't cache HTML — it's the entry point and changes
  } else if (contentType.includes("text/css")) {
    const text = await upstream.text();
    const rewritten = rewriteCssUrls(text, finalUrl);
    const buf = Buffer.from(rewritten, "utf8");
    res.setHeader("content-type", "text/css; charset=utf-8");
    res.setHeader("content-length", buf.length);
    res.status(upstream.status).send(buf);
    cacheSet(targetUrl, { status: upstream.status, contentType: "text/css; charset=utf-8", body: buf, expiresAt: Date.now() + CACHE_TTL_MS });
  } else {
    // Binary / JS / images — buffer and cache
    const raw = await upstream.arrayBuffer();
    const buf = Buffer.from(raw);
    res.setHeader("content-type", contentType);
    res.setHeader("content-length", buf.length);
    res.status(upstream.status).send(buf);
    if (upstream.status === 200) {
      cacheSet(targetUrl, { status: upstream.status, contentType: contentType, body: buf, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  }
}

router.get("/proxy", handleProxy);
router.post("/proxy", handleProxy);

export default router;
