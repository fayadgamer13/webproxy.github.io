import { useState, useRef, useCallback, useEffect } from "react";
import {
  Globe, ArrowRight, RefreshCw, X, Shield, Lock,
  AlertCircle, ExternalLink, ChevronLeft, ChevronRight, Plus,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Tab {
  id: string;
  inputUrl: string;
  activeTarget: string;
  proxyUrl: string;
  title: string;
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;
}

let tabCounter = 0;
function newTabId() { return `tab-${++tabCounter}`; }

function makeBlankTab(): Tab {
  return {
    id: newTabId(),
    inputUrl: "",
    activeTarget: "",
    proxyUrl: "",
    title: "New Tab",
    loading: false,
    error: null,
    history: [],
    historyIndex: -1,
  };
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return "https://" + t;
}

function buildProxyUrl(target: string): string {
  return `/api/proxy?url=${encodeURIComponent(target)}`;
}

// ── Quick links ───────────────────────────────────────────────────────────────
const QUICK_LINKS = [
  { label: "Wikipedia", url: "https://en.wikipedia.org" },
  { label: "Hacker News", url: "https://news.ycombinator.com" },
  { label: "GitHub", url: "https://github.com" },
  { label: "MDN Docs", url: "https://developer.mozilla.org" },
  { label: "Dictionary", url: "https://www.merriam-webster.com" },
  { label: "Archive.org", url: "https://archive.org" },
];

// ── Component ─────────────────────────────────────────────────────────────────
export default function ProxyPage() {
  const [tabs, setTabs] = useState<Tab[]>([makeBlankTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // Listen for title messages from proxied pages
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "proxy-title" && e.data.tabId && e.data.title) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === e.data.tabId ? { ...t, title: e.data.title } : t,
          ),
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ── Tab mutations ───────────────────────────────────────────────────────────
  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const addTab = useCallback(() => {
    const t = makeBlankTab();
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length === 1) return [makeBlankTab()];
        const next = prev.filter((t) => t.id !== id);
        if (id === activeId) {
          const idx = Math.max(0, prev.findIndex((t) => t.id === id) - 1);
          setActiveId(next[idx]?.id ?? next[0].id);
        }
        return next;
      });
    },
    [activeId],
  );

  const switchTab = useCallback((id: string) => {
    setActiveId(id);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const navigate = useCallback(
    (target: string, tabId = activeId, pushHistory = true) => {
      const normalized = normalizeUrl(target);
      if (!normalized) return;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          const sliced = pushHistory ? t.history.slice(0, t.historyIndex + 1) : t.history;
          const newHistory = pushHistory ? [...sliced, normalized] : sliced;
          const newIndex = pushHistory ? newHistory.length - 1 : t.historyIndex;
          return {
            ...t,
            inputUrl: normalized,
            activeTarget: normalized,
            proxyUrl: buildProxyUrl(normalized),
            title: "Loading…",
            loading: true,
            error: null,
            history: newHistory,
            historyIndex: newIndex,
          };
        }),
      );
    },
    [activeId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(activeTab.inputUrl);
  };

  const handleBack = () => {
    const t = activeTab;
    if (t.historyIndex <= 0) return;
    const ni = t.historyIndex - 1;
    const url = t.history[ni];
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === t.id
          ? { ...tab, inputUrl: url, activeTarget: url, proxyUrl: buildProxyUrl(url), historyIndex: ni, loading: true, error: null }
          : tab,
      ),
    );
  };

  const handleForward = () => {
    const t = activeTab;
    if (t.historyIndex >= t.history.length - 1) return;
    const ni = t.historyIndex + 1;
    const url = t.history[ni];
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === t.id
          ? { ...tab, inputUrl: url, activeTarget: url, proxyUrl: buildProxyUrl(url), historyIndex: ni, loading: true, error: null }
          : tab,
      ),
    );
  };

  const handleRefresh = () => {
    const t = activeTab;
    if (!t.proxyUrl) return;
    const cur = t.proxyUrl;
    updateTab(t.id, { proxyUrl: "", loading: true, error: null });
    setTimeout(() => updateTab(t.id, { proxyUrl: cur }), 50);
  };

  const handleClear = () => {
    updateTab(activeTab.id, {
      inputUrl: "", activeTarget: "", proxyUrl: "",
      loading: false, error: null, title: "New Tab",
      history: [], historyIndex: -1,
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleIframeLoad = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    const hostname = tab?.activeTarget ? (() => { try { return new URL(tab.activeTarget).hostname.replace("www.", ""); } catch { return tab.activeTarget; } })() : "New Tab";
    updateTab(id, { loading: false, error: null, title: hostname });
  };
  const handleIframeError = (id: string) => {
    updateTab(id, { loading: false, error: "Could not load the page." });
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-slate-950">

      {/* ── Tab bar ── */}
      <div className="flex-none flex items-end gap-0 px-2 pt-2 bg-black/30 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className={`group relative flex items-center gap-2 min-w-0 max-w-[180px] flex-shrink-0 px-3 py-2 rounded-t-lg cursor-pointer select-none transition-all ${
              tab.id === activeId
                ? "bg-slate-900 text-white"
                : "bg-black/20 text-white/50 hover:bg-white/10 hover:text-white/80"
            }`}
          >
            <Globe className="w-3 h-3 flex-none opacity-60" />
            <span className="text-xs truncate flex-1 min-w-0">{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className="flex-none w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-white/20 transition-all"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <button
          onClick={addTab}
          className="flex-none mb-0 ml-1 w-8 h-8 flex items-center justify-center rounded-t-lg text-white/40 hover:text-white hover:bg-white/10 transition-all"
          title="New tab"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* ── Navigation bar ── */}
      <div className="flex-none border-b border-white/10 bg-slate-900">
        <div className="px-3 py-2 flex items-center gap-2">
          {/* Logo */}
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/30 flex-none">
            <Globe className="w-3.5 h-3.5 text-white" />
          </div>

          {/* Back / Forward / Refresh */}
          <div className="flex items-center gap-0.5 flex-none">
            <button onClick={handleBack} disabled={activeTab.historyIndex <= 0}
              className="w-7 h-7 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-all">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={handleForward} disabled={activeTab.historyIndex >= activeTab.history.length - 1}
              className="w-7 h-7 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-all">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button onClick={handleRefresh} disabled={!activeTab.proxyUrl}
              className="w-7 h-7 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-all">
              <RefreshCw className={`w-3.5 h-3.5 ${activeTab.loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* URL bar */}
          <form onSubmit={handleSubmit} className="flex-1">
            <div className="flex items-center bg-black/30 hover:bg-black/40 border border-white/10 rounded-lg overflow-hidden transition-all focus-within:border-violet-500/50 focus-within:shadow-md focus-within:shadow-violet-500/10">
              <div className="pl-3 flex-none">
                <Lock className="w-3 h-3 text-emerald-400/70" />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={activeTab.inputUrl}
                onChange={(e) => updateTab(activeTab.id, { inputUrl: e.target.value })}
                placeholder="Enter a URL to browse anonymously…"
                className="flex-1 bg-transparent text-white/90 placeholder-white/25 text-sm px-2.5 py-2 outline-none min-w-0"
              />
              {activeTab.inputUrl && (
                <button type="button" onClick={handleClear}
                  className="pr-2 flex-none text-white/25 hover:text-white/60 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button type="submit"
                className="flex-none m-1 px-3 py-1 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium rounded-md flex items-center gap-1 transition-all shadow-violet-500/20">
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* ── Tab content panels ── */}
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? "flex" : "none", flexDirection: "column" }}
          >
            {/* Start screen */}
            {!tab.proxyUrl && !tab.error && (
              <div className="flex-1 flex flex-col items-center justify-center p-6 gap-8 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
                <div className="text-center max-w-lg">
                  <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-xl shadow-violet-500/30">
                    <Shield className="w-7 h-7 text-white" />
                  </div>
                  <h1 className="text-2xl font-bold text-white mb-2">Browse Privately</h1>
                  <p className="text-white/40 text-sm leading-relaxed">
                    Every request routes through our server-side proxy.
                  </p>
                </div>

                <div className="w-full max-w-xl">
                  <p className="text-white/30 text-xs font-medium uppercase tracking-widest mb-3 text-center">Quick Access</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {QUICK_LINKS.map((link) => (
                      <button key={link.url} onClick={() => navigate(link.url, tab.id)}
                        className="group flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/8 hover:border-violet-500/40 text-white/50 hover:text-white text-sm transition-all">
                        <span>{link.label}</span>
                        <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap justify-center gap-4 text-xs text-white/20">
                  <span className="flex items-center gap-1.5"><Lock className="w-3 h-3" />Server-side proxy</span>
                  <span className="flex items-center gap-1.5"><Shield className="w-3 h-3" />Anonymous</span>
                  <span className="flex items-center gap-1.5"><Globe className="w-3 h-3" />Link rewriting</span>
                </div>
              </div>
            )}

            {/* Error screen */}
            {tab.error && (
              <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
                <div className="text-center max-w-md">
                  <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-400" />
                  </div>
                  <h2 className="text-lg font-semibold text-white mb-2">Unable to Load</h2>
                  <p className="text-white/40 text-sm mb-5">{tab.error}</p>
                  <div className="flex gap-2 justify-center">
                    <button onClick={handleRefresh}
                      className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm flex items-center gap-2 transition-all">
                      <RefreshCw className="w-3.5 h-3.5" /> Retry
                    </button>
                    <button onClick={handleClear}
                      className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm transition-all">
                      New Page
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Proxy iframe */}
            {tab.proxyUrl && (
              <div className="flex-1 relative">
                {tab.loading && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-7 h-7 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                      <p className="text-white/50 text-xs">Fetching through proxy…</p>
                    </div>
                  </div>
                )}
                <ProxyIframe tab={tab} onLoad={handleIframeLoad} onError={handleIframeError} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div className="flex-none border-t border-white/8 bg-black/20 px-4 py-1.5 flex items-center justify-between">
        <span className="text-white/20 text-xs">ProxyWeb</span>
        {activeTab.activeTarget && (
          <span className="text-white/15 text-xs truncate max-w-sm hidden sm:block">{activeTab.activeTarget}</span>
        )}
        <div className="flex items-center gap-1 text-white/25 text-xs">
          <Lock className="w-3 h-3" /><span>Proxied</span>
        </div>
      </div>
    </div>
  );
}

// ── Per-tab iframe ─────────────────────────────────────────────────────────────
function ProxyIframe({
  tab,
  onLoad,
  onError,
}: {
  tab: Tab;
  onLoad: (id: string) => void;
  onError: (id: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);

  return (
    <iframe
      key={tab.proxyUrl}
      ref={ref}
      src={tab.proxyUrl}
      className="w-full h-full border-none block bg-white"
      onLoad={() => onLoad(tab.id)}
      onError={() => onError(tab.id)}
      title={tab.title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
    />
  );
}
