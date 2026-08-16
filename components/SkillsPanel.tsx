"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  SkillInfo,
  SkillSearchResult,
  PluginPackageInfo,
  PluginsResponse,
  CatalogPackage,
} from "@/lib/api-types";

interface Props {
  cwd: string | null;
  onPluginsChanged?: () => void;
  /** Cross-panel jump from the dsh market: switch tab + prefill a search. */
  piSearchRequest?: { target: "plugins" | "skills"; query: string; nonce: number } | null;
}

type Tab = "skills" | "plugins";

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t("i18n.extensionShort") }) : "",
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t("i18n.skillShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t("i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t("i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function normalizePluginSourceInput(value: string): string {
  const match = value.trim().match(/^\$?\s*pi\s+install\s+(\S+)\s*$/);
  return match?.[1] ?? value;
}

/** Skill install scope: user/global vs project. */
function skillScopeOf(skill: SkillInfo): "global" | "project" {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "project" || src === "project") return "project";
  return "global";
}

/** Clamp description to a few lines; expand on demand. */
function SkillDescription({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitLineClamp: expanded ? undefined : 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {text}
      </div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          marginTop: 2,
          padding: 0,
          background: "none",
          border: "none",
          color: "var(--accent)",
          cursor: "pointer",
          fontSize: 10,
        }}
      >
        {expanded ? t("activity.collapseDetail") : t("activity.viewDetail")}
      </button>
    </div>
  );
}

export function SkillsPanel({ cwd, onPluginsChanged, piSearchRequest }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("skills");

  // ── Skills state ──
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [expandedSkill, setExpandedSkill] = useState<Set<string>>(new Set());
  const skillsReqRef = useRef(0);

  // ── Skill search (hub) state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [skillScope, setSkillScope] = useState<"global" | "project">("global");
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(true);

  // ── Popular skills (skills.sh leaderboard) state ──
  const [popularSkills, setPopularSkills] = useState<SkillSearchResult[]>([]);
  const [popularLoading, setPopularLoading] = useState(false);
  const [popularError, setPopularError] = useState<string | null>(null);
  const popularReqRef = useRef(0);

  // ── Plugins state ──
  const [packages, setPackages] = useState<PluginPackageInfo[]>([]);
  const [totals, setTotals] = useState<PluginsResponse["totals"] | null>(null);
  const [diagnostics, setDiagnostics] = useState<PluginsResponse["diagnostics"]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // ── Marketplace (pi.dev catalog) state ──
  const [catalogPackages, setCatalogPackages] = useState<CatalogPackage[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [marketQuery, setMarketQuery] = useState("");
  const [installingCatalog, setInstallingCatalog] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const catalogReqRef = useRef(0);

  const loadSkills = useCallback(async () => {
    if (!cwd) return;
    const id = ++skillsReqRef.current;
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json().catch(() => ({}))) as { skills?: SkillInfo[]; error?: string; projectResourcesLoaded?: boolean };
      if (id !== skillsReqRef.current) return;
      if (data.error || !data.skills) {
        setSkillsError(data.error ?? "load failed");
        return;
      }
      setSkills(data.skills);
      setProjectResourcesLoaded(data.projectResourcesLoaded ?? true);
    } catch (e) {
      if (id !== skillsReqRef.current) return;
      setSkillsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === skillsReqRef.current) setSkillsLoading(false);
    }
  }, [cwd]);

  const loadPlugins = useCallback(async () => {
    if (!cwd) return;
    setPluginsLoading(true);
    setPluginsError(null);
    try {
      const res = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json().catch(() => ({}))) as PluginsResponse & { error?: string };
      if (data.error || !data.packages) {
        setPluginsError(data.error ?? "load failed");
        return;
      }
      setPackages(data.packages);
      setTotals(data.totals);
      setDiagnostics(data.diagnostics ?? []);
      setProjectResourcesLoaded(data.projectResourcesLoaded ?? true);
    } catch (e) {
      setPluginsError(e instanceof Error ? e.message : String(e));
    } finally {
      setPluginsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadSkills();
    void loadPlugins();
  }, [loadSkills, loadPlugins]);

  // ── Skill search (hub) ──
  const runSearch = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) { setSearchResults([]); return; }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const d = (await res.json().catch(() => ({}))) as { results?: SkillSearchResult[]; error?: string };
      if (d.error) { setSearchError(d.error); setSearchResults([]); return; }
      setSearchResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError(t("i18n.noResults"));
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [t]);

  const installSkill = useCallback(async (pkg: string) => {
    if (!cwd) return;
    setInstallingSkill(pkg);
    setInstallError(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: pkg, scope: skillScope, cwd }),
      });
      const d = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || d.error) { setInstallError(d.error ?? `HTTP ${res.status}`); return; }
      await loadSkills();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingSkill(null);
    }
  }, [cwd, skillScope, loadSkills]);

  // ── Popular skills (skills.sh leaderboard) ──
  const loadPopularSkills = useCallback(async () => {
    const id = ++popularReqRef.current;
    setPopularLoading(true);
    setPopularError(null);
    try {
      const res = await fetch("/api/skills/popular?limit=12");
      const d = (await res.json().catch(() => ({}))) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (id !== popularReqRef.current) return;
      if (!res.ok || d.error || !d.results) {
        setPopularError(d.error ?? `HTTP ${res.status}`);
        setPopularSkills([]);
        return;
      }
      setPopularSkills(d.results);
    } catch (e) {
      if (id !== popularReqRef.current) return;
      setPopularError(e instanceof Error ? e.message : String(e));
      setPopularSkills([]);
    } finally {
      if (id === popularReqRef.current) setPopularLoading(false);
    }
  }, []);

  // Load popular skills once when the skills tab is opened.
  useEffect(() => {
    if (tab === "skills" && cwd && popularSkills.length === 0 && !popularLoading && !popularError) {
      void loadPopularSkills();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cwd]);

  // Cross-panel jump from the dsh market: switch tab + prefill + search.
  useEffect(() => {
    if (!piSearchRequest) return;
    if (piSearchRequest.target === "plugins") {
      setTab("plugins");
      setMarketQuery(piSearchRequest.query);
      void loadCatalog(piSearchRequest.query);
    } else {
      setTab("skills");
      setSearchQuery(piSearchRequest.query);
      if (piSearchRequest.query.trim()) void runSearch(piSearchRequest.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piSearchRequest?.nonce]);

  const toggleSkill = useCallback(async (skill: SkillInfo) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: skill.filePath, disableModelInvocation: next }),
      });
      const d = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || d.error) { setSkillsError(d.error ?? `HTTP ${res.status}`); return; }
      setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, disableModelInvocation: next } : s));
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling((s) => { const n = new Set(s); n.delete(skill.filePath); return n; });
    }
  }, []);

  // ── Plugin actions ──
  const runPluginAction = useCallback(async (action: string, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
      });
      const next = (await res.json().catch(() => ({}))) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setPackages(next.packages);
      setTotals(next.totals);
      setDiagnostics(next.diagnostics ?? []);
      setActionMessage(t(`i18n.${action}Done`));
      onPluginsChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, onPluginsChanged, t]);

  const installPlugin = useCallback(async () => {
    const source = normalizePluginSourceInput(installSource).trim();
    if (!source) return;
    setInstallSource(source);
    setBusyKey(`install:${source}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope: "global", cwd }),
      });
      const next = (await res.json().catch(() => ({}))) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setPackages(next.packages);
      setTotals(next.totals);
      setDiagnostics(next.diagnostics ?? []);
      setInstallSource("");
      setActionMessage(t("i18n.installDone"));
      onPluginsChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, installSource, onPluginsChanged, t]);

  const installedSkillPackages = useMemo(() => {
    const set = new Set<string>();
    for (const s of skills) if (s.install?.package) set.add(s.install.package);
    return set;
  }, [skills]);

  // ── Marketplace (pi.dev catalog) ──
  const loadCatalog = useCallback(async (q: string) => {
    const id = ++catalogReqRef.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const params = new URLSearchParams();
      const trimmed = q.trim();
      if (trimmed) params.set("q", trimmed);
      params.set("sort", "downloads");
      const res = await fetch(`/api/packages/catalog?${params.toString()}`);
      const d = (await res.json().catch(() => ({}))) as {
        packages?: CatalogPackage[];
        error?: string;
      };
      if (id !== catalogReqRef.current) return;
      if (!res.ok || d.error || !d.packages) {
        setCatalogError(d.error ?? `HTTP ${res.status}`);
        setCatalogPackages([]);
        return;
      }
      setCatalogPackages(d.packages);
    } catch (e) {
      if (id !== catalogReqRef.current) return;
      setCatalogError(e instanceof Error ? e.message : String(e));
      setCatalogPackages([]);
    } finally {
      if (id === catalogReqRef.current) setCatalogLoading(false);
    }
  }, []);

  // Load popular catalog once when the plugins tab is opened.
  useEffect(() => {
    if (tab === "plugins" && cwd && catalogPackages.length === 0 && !catalogLoading && !catalogError) {
      void loadCatalog("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cwd]);

  const isCatalogInstalled = useCallback(
    (pkg: CatalogPackage) => {
      const source = pkg.installSource || `npm:${pkg.name}`;
      return packages.some(
        (p) =>
          p.source === source ||
          p.source === `npm:${pkg.name}` ||
          p.source.endsWith(`/${pkg.name}`),
      );
    },
    [packages],
  );

  const installCatalogPackage = useCallback(
    async (pkg: CatalogPackage) => {
      const source = pkg.installSource || `npm:${pkg.name}`;
      setInstallingCatalog(source);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await fetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "install", source, scope: "global", cwd }),
        });
        const next = (await res.json().catch(() => ({}))) as PluginsResponse & { error?: string };
        if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
        setPackages(next.packages);
        setTotals(next.totals);
        setDiagnostics(next.diagnostics ?? []);
        setActionMessage(t("i18n.installDone"));
        onPluginsChanged?.();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstallingCatalog(null);
      }
    },
    [cwd, onPluginsChanged, t],
  );

  const visibleSkills = useMemo(
    () => skills.filter((s) => skillScopeOf(s) === skillScope),
    [skills, skillScope],
  );

  // Shared card renderer for online skills (popular + search results).
  const renderOnlineCard = (r: SkillSearchResult) => {
    const isInstalled = installedSkillPackages.has(r.package);
    const isInstalling = installingSkill === r.package;
    const atIdx = r.package.indexOf("@");
    const repoPart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
    const skillPart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
    return (
      <div
        key={r.package}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 9px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {skillPart ?? repoPart}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, minWidth: 0, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {repoPart}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500, flexShrink: 0 }}>⭐ {r.installs}</span>
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none", flexShrink: 0 }}>
                {t("activity.officialSite")} ↗
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { if (!isInstalled && !isInstalling) void installSkill(r.package); }}
          disabled={isInstalled || isInstalling}
          style={{
            flexShrink: 0, height: 24, padding: "0 10px",
            background: isInstalled ? "rgba(34,197,94,0.1)" : "var(--accent)",
            border: "none", borderRadius: 5,
            color: isInstalled ? "#16a34a" : "#fff",
            cursor: isInstalled || isInstalling ? "default" : "pointer",
            fontSize: 11, fontWeight: 600,
            opacity: isInstalling ? 0.6 : 1,
          }}
        >
          {isInstalled ? `✓ ${t("i18n.installed")}` : isInstalling ? t("i18n.installing") : t("i18n.install")}
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
            {t("activity.skills")}
          </span>
          <button
            type="button"
            onClick={() => { void loadSkills(); void loadPlugins(); }}
            title={t("i18n.refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
              color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: "0 12px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", height: 30 }}>
          {(["skills", "plugins"] as Tab[]).map((id) => {
            const active = tab === id;
            const count = id === "skills" ? skills.length : packages.length;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                style={{
                  flex: 1, border: "none",
                  borderRight: id === "skills" ? "1px solid var(--border)" : "none",
                  background: active ? "var(--bg-selected)" : "none",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 450,
                }}
              >
                {t(id === "skills" ? "activity.skillsTab" : "activity.pluginsTab")}
                <span style={{ marginLeft: 5, fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {!cwd && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("workspace.selectProject")}</div>}

        {/* ═══ Skills tab ═══ */}
        {cwd && tab === "skills" && (
          <>
            {/* Search box: queries the skills.sh hub */}
            <div style={{ padding: "0 4px 8px", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runSearch(searchQuery); }}
                  placeholder={t("i18n.skillSearchPlaceholder")}
                  style={{
                    flex: 1, minWidth: 0, boxSizing: "border-box",
                    fontSize: 12, fontFamily: "inherit", padding: "6px 9px",
                    border: "1px solid var(--border)", borderRadius: 6,
                    outline: "none", background: "var(--bg)", color: "var(--text)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void runSearch(searchQuery)}
                  disabled={searching || !searchQuery.trim()}
                  style={{
                    flexShrink: 0, height: 29, padding: "0 10px",
                    background: "var(--accent)", border: "none", borderRadius: 6,
                    color: "#fff", cursor: searching || !searchQuery.trim() ? "default" : "pointer",
                    fontSize: 11, fontWeight: 600, opacity: searching || !searchQuery.trim() ? 0.5 : 1,
                  }}
                >
                  {searching ? t("i18n.searching") : t("i18n.search")}
                </button>
              </div>
              {/* errors */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                {searchError && <span style={{ flex: 1, fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{searchError}</span>}
                {installError && <span style={{ flex: 1, fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{installError}</span>}
              </div>
            </div>

            {/* ── Popular / online results (marketplace style, above local list) ── */}
            {!searchQuery.trim() ? (
              popularLoading ? (
                <div style={{ padding: "10px 4px", fontSize: 11, color: "var(--text-muted)" }}>{t("activity.marketplaceLoading")}</div>
              ) : popularError ? (
                <div style={{ padding: "10px 4px", fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{popularError}</div>
              ) : popularSkills.length > 0 ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                    {t("activity.popularSkills")}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", paddingRight: 2 }}>
                    {popularSkills.map(renderOnlineCard)}
                  </div>
                </div>
              ) : null
            ) : searchResults.length > 0 ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                  {t("activity.onlineResults")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", paddingRight: 2 }}>
                  {searchResults.map(renderOnlineCard)}
                </div>
              </div>
            ) : null}

            {/* scope tabs */}
            <div style={{ padding: "0 4px 8px", flexShrink: 0 }}>
              <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", height: 28 }}>
                {(["global", "project"] as const).map((scope) => {
                  const active = skillScope === scope;
                  const disabled = scope === "project" && !projectResourcesLoaded;
                  const count = scope === "global"
                    ? skills.filter((s) => skillScopeOf(s) === "global").length
                    : skills.filter((s) => skillScopeOf(s) === "project").length;
                  return (
                    <button
                      key={scope}
                      type="button"
                      disabled={disabled}
                      onClick={() => { if (!disabled) setSkillScope(scope); }}
                      title={disabled ? t("trust.projectScopeUnavailable") : undefined}
                      style={{
                        flex: 1, border: "none",
                        borderRight: scope === "global" ? "1px solid var(--border)" : "none",
                        background: active ? "var(--bg-selected)" : "none",
                        color: active ? "var(--text)" : "var(--text-muted)",
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.45 : 1,
                        fontSize: 12, fontWeight: active ? 600 : 450,
                      }}
                    >
                      {scope}
                      <span style={{ marginLeft: 5, fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Local skills */}
            {skillsLoading && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("i18n.loading")}</div>}
            {skillsError && <div style={{ padding: "12px 10px", color: "#f87171", fontSize: 12 }}>{skillsError}</div>}
            {!skillsLoading && !skillsError && visibleSkills.length === 0 && (
              <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>
                {t("i18n.noSkills")}
              </div>
            )}
            {visibleSkills.map((s) => {
              const enabled = !s.disableModelInvocation;
              const isToggling = toggling.has(s.filePath);
              const expanded = expandedSkill.has(s.filePath);
              return (
                <div key={s.filePath || s.name} style={{ padding: "8px 6px", borderRadius: 8, borderBottom: "1px solid var(--hairline)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={enabled ? "var(--accent)" : "var(--text-dim)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: enabled ? "var(--text)" : "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {s.name}
                    </span>
                    {s.disableModelInvocation && (
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
                        {t("activity.modelDisabled")}
                      </span>
                    )}
                    {/* enable/disable toggle */}
                    <button
                      type="button"
                      onClick={() => void toggleSkill(s)}
                      disabled={isToggling}
                      title={enabled ? t("i18n.hiddenFromPrompt") : t("i18n.visibleInPrompt")}
                      style={{
                        flexShrink: 0, width: 36, height: 20, borderRadius: 10,
                        border: "none", padding: 0, cursor: isToggling ? "wait" : "pointer",
                        background: enabled ? "var(--accent)" : "var(--border)",
                        position: "relative", transition: "background 0.18s", opacity: isToggling ? 0.6 : 1,
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 2, left: enabled ? 18 : 2,
                        width: 16, height: 16, borderRadius: "50%",
                        background: "var(--bg)", boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
                        transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
                      }} />
                    </button>
                  </div>
                  <SkillDescription
                    text={s.description}
                    expanded={expanded}
                    onToggle={() => setExpandedSkill((prev) => {
                      const n = new Set(prev);
                      if (n.has(s.filePath)) n.delete(s.filePath); else n.add(s.filePath);
                      return n;
                    })}
                  />
                  {s.sourceInfo?.source && (
                    <div style={{ marginTop: 3, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                      {s.sourceInfo.source}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ═══ Plugins tab ═══ */}
        {cwd && tab === "plugins" && (
          <>
            {pluginsLoading && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("i18n.loading")}</div>}
            {pluginsError && <div style={{ padding: "12px 10px", color: "#f87171", fontSize: 12 }}>{pluginsError}</div>}

            {!projectResourcesLoaded && (
              <div style={{ padding: "8px 10px", margin: "4px 0", fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
                {t("trust.pluginsNotLoaded")}
              </div>
            )}

            {!pluginsLoading && !pluginsError && (
              <div style={{ padding: "4px 2px 8px" }}>
                {/* ── Marketplace header ── */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>
                    {t("activity.marketplace")}
                  </span>
                  <a
                    href="https://pi.dev/packages"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}
                  >
                    pi.dev/packages ↗
                  </a>
                </div>

                {/* ── Marketplace search (pi.dev catalog) ── */}
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={marketQuery}
                    onChange={(e) => setMarketQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void loadCatalog(marketQuery); }}
                    placeholder={t("activity.searchPackagesPlaceholder")}
                    style={{
                      flex: 1, minWidth: 0, boxSizing: "border-box",
                      fontSize: 12, fontFamily: "inherit", padding: "6px 9px",
                      border: "1px solid var(--border)", borderRadius: 6,
                      outline: "none", background: "var(--bg)", color: "var(--text)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void loadCatalog(marketQuery)}
                    disabled={catalogLoading}
                    style={{
                      flexShrink: 0, height: 29, padding: "0 10px",
                      background: "var(--accent)", border: "none", borderRadius: 6,
                      color: "#fff", cursor: catalogLoading ? "default" : "pointer",
                      fontSize: 11, fontWeight: 600, opacity: catalogLoading ? 0.5 : 1,
                    }}
                  >
                    {catalogLoading ? t("i18n.searching") : t("activity.searchPiDev")}
                  </button>
                </div>

                {catalogError && (
                  <div style={{ fontSize: 10, color: "#f87171", marginTop: 6, overflowWrap: "anywhere" }}>
                    {catalogError}
                  </div>
                )}

                {/* ── Catalog: popular (default) or search results ── */}
                {!catalogLoading && catalogPackages.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                      {marketQuery.trim() ? t("activity.onlineResults") : t("activity.popularPackages")}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto", paddingRight: 2 }}>
                      {catalogPackages.map((pkg) => {
                        const source = pkg.installSource || `npm:${pkg.name}`;
                        const installed = isCatalogInstalled(pkg);
                        const installing = installingCatalog === source;
                        return (
                          <div key={pkg.name} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 9px", background: "var(--bg-panel)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                              <span
                                title={pkg.name}
                                style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              >
                                {pkg.name}
                              </span>
                              <button
                                type="button"
                                onClick={() => { if (!installed && !installing) void installCatalogPackage(pkg); }}
                                disabled={installed || installing || installingCatalog !== null}
                                style={{
                                  flexShrink: 0, height: 24, padding: "0 10px",
                                  background: installed ? "rgba(34,197,94,0.1)" : "var(--accent)",
                                  border: "none", borderRadius: 5,
                                  color: installed ? "#16a34a" : "#fff",
                                  cursor: installed || installing || installingCatalog !== null ? "default" : "pointer",
                                  fontSize: 11, fontWeight: 600,
                                  opacity: installed ? 1 : installing ? 0.6 : 1,
                                }}
                              >
                                {installed ? `✓ ${t("i18n.installed")}` : installing ? t("i18n.installing") : t("i18n.install")}
                              </button>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                              {pkg.types.map((type) => (
                                <span key={type} style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.85)" }}>
                                  {type}
                                </span>
                              ))}
                              {pkg.downloadsLabel && (
                                <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500 }} title={`${pkg.downloads} /mo`}>
                                  ⭐ {pkg.downloadsLabel}
                                </span>
                              )}
                              {pkg.author && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{pkg.author}</span>}
                              {pkg.updatedLabel && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>· {pkg.updatedLabel}</span>}
                            </div>
                            {pkg.description && (
                              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                {pkg.description}
                              </div>
                            )}
                            {(pkg.url || pkg.npmUrl || pkg.repoUrl) && (
                              <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                                {pkg.url && (
                                  <a href={pkg.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none" }}>
                                    {t("activity.officialSite")} ↗
                                  </a>
                                )}
                                {pkg.npmUrl && (
                                  <a href={pkg.npmUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--text-muted)", textDecoration: "none" }}>
                                    npm ↗
                                  </a>
                                )}
                                {pkg.repoUrl && (
                                  <a href={pkg.repoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--text-muted)", textDecoration: "none" }}>
                                    GitHub ↗
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {catalogLoading && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, padding: "8px 4px" }}>
                    {t("activity.marketplaceLoading")}
                  </div>
                )}
                {!catalogLoading && !catalogError && catalogPackages.length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, padding: "8px 4px" }}>
                    {t("activity.noMarketplacePackages")}
                  </div>
                )}

                {/* ── Advanced: install by source ── */}
                <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((v) => !v)}
                    style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 0" }}
                  >
                    {advancedOpen ? "▾ " : "▸ "}{t("activity.advancedSourceInstall")}
                  </button>
                  {advancedOpen && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <input
                        value={installSource}
                        onChange={(e) => setInstallSource(e.target.value)}
                        onBlur={(e) => setInstallSource(normalizePluginSourceInput(e.currentTarget.value))}
                        onKeyDown={(e) => { if (e.key === "Enter" && installSource.trim()) void installPlugin(); }}
                        placeholder={t("activity.sourceInstallHint")}
                        style={{
                          flex: 1, minWidth: 0, boxSizing: "border-box",
                          fontSize: 11, fontFamily: "var(--font-mono)", padding: "6px 9px",
                          border: "1px solid var(--border)", borderRadius: 6,
                          outline: "none", background: "var(--bg)", color: "var(--text)",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void installPlugin()}
                        disabled={!installSource.trim() || busyKey?.startsWith("install:")}
                        style={{
                          flexShrink: 0, height: 29, padding: "0 10px",
                          background: "var(--accent)", border: "none", borderRadius: 6,
                          color: "#fff", cursor: installSource.trim() ? "pointer" : "default",
                          fontSize: 11, fontWeight: 600, opacity: installSource.trim() ? 1 : 0.5,
                        }}
                      >
                        {busyKey?.startsWith("install:") ? t("i18n.installing") : t("i18n.install")}
                      </button>
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    {actionError && <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{actionError}</span>}
                    {actionMessage && <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#16a34a", overflowWrap: "anywhere" }}>{actionMessage}</span>}
                  </div>
                </div>

                {/* ── Installed packages ── */}
                {packages.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                      {t("activity.installedSection")} ({packages.length})
                    </div>
                    {packages.map((pkg) => {
                      const key = packageKey(pkg);
                      const busy = busyKey?.endsWith(key) ?? false;
                      const enabled = !pkg.disabled;
                      return (
                        <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px", borderRadius: 6, borderBottom: "1px solid var(--hairline)" }}>
                          <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: statusColor(pkg.status) }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                              <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pkg.source}>
                                {pkg.source}
                              </span>
                              <span
                                style={{
                                  flexShrink: 0, fontSize: 9, padding: "1px 4px", borderRadius: 3,
                                  background: pkg.scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
                                  color: pkg.scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
                                }}
                              >
                                {pkg.scope}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                              {resourceSummary(pkg, t)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void runPluginAction(pkg.disabled ? "enable" : "disable", pkg)}
                            disabled={busy}
                            title={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
                            style={{
                              flexShrink: 0, width: 36, height: 20, borderRadius: 10,
                              border: "none", padding: 0, cursor: busy ? "wait" : "pointer",
                              background: enabled ? "var(--accent)" : "var(--border)",
                              position: "relative", transition: "background 0.18s", opacity: busy ? 0.6 : 1,
                            }}
                          >
                            <span style={{
                              position: "absolute", top: 2, left: enabled ? 18 : 2,
                              width: 16, height: 16, borderRadius: "50%",
                              background: "var(--bg)", boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
                              transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
                            }} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void runPluginAction("remove", pkg)}
                            disabled={busy}
                            title={t("i18n.remove")}
                            style={{
                              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                              width: 22, height: 22, padding: 0, background: "none", border: "none",
                              borderRadius: 4, color: "var(--text-dim)", cursor: "pointer", opacity: busy ? 0.5 : 1,
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = "#f87171"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!pluginsLoading && !pluginsError && (
              <div style={{ padding: "6px 8px", fontSize: 10, color: "var(--text-dim)", borderTop: "1px solid var(--border)", marginTop: 4 }}>
                {diagnostics.length > 0 && (
                  <div style={{ color: diagnostics.some((d) => d.type === "error") ? "#f87171" : "#d97706", marginBottom: 4 }}>
                    {diagnostics.map((d, i) => (
                      <div key={i} style={{ overflowWrap: "anywhere" }}>
                        {d.type}: {d.source ? `${d.source}: ` : ""}{d.message}
                      </div>
                    ))}
                  </div>
                )}
                {totals && (
                  <div>
                    {totals.extensions} ext · {totals.skills} skills · {totals.prompts} prompts · {totals.themes} themes
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
