"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DshCatalogItem, DshCategory } from "@/lib/dsh-catalog";
import { dshRepoOf, dshNpmUrlOf } from "@/lib/dsh-catalog";
import type { DshAdaptationReport } from "@/lib/plugins/adapters/dsh/dsh-detect";

interface LoadedPlugin {
  id: string;
  package: string;
  version: string;
  compat: { score: number; verified: boolean; unmapped: string[] };
  toolCount: number;
  skillCount: number;
}

interface PluginsResponse {
  installed: string[];
  loaded: LoadedPlugin[];
}

interface StoreItem {
  name: string;
  author: string;
  description: string;
  category: string;
  type: string;
  topics: string[];
  stars: number;
  forks: number;
  issues: number;
  updatedLabel: string;
  repo: string;
  githubUrl: string;
  detailUrl: string;
}

interface CatalogResponse {
  items: StoreItem[];
  page: number;
  categories: Record<string, string>;
}

interface MarketResponse {
  items: DshCatalogItem[];
  counts: Record<DshCategory, number>;
}

type PiTarget = "plugins" | "skills";
type PanelTab = "catalog" | "featured";

function categoryBadge(cat: DshCategory, t: (k: string) => string): { label: string; bg: string; fg: string } {
  if (cat === "A") return { label: t("dsh.catA"), bg: "rgba(34,197,94,0.12)", fg: "#16a34a" };
  if (cat === "B") return { label: t("dsh.catB"), bg: "rgba(99,102,241,0.12)", fg: "rgba(99,102,241,0.9)" };
  return { label: t("dsh.catC"), bg: "rgba(120,120,120,0.14)", fg: "var(--text-dim)" };
}

function fmtCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function DshMarketPanel({
  onOpenPiSearch,
}: {
  onOpenPiSearch: (target: PiTarget, query: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanelTab>("catalog");

  // 已安装插件
  const [plugins, setPlugins] = useState<PluginsResponse | null>(null);
  // 手工精选
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [filter, setFilter] = useState<"all" | DshCategory>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // 生态目录
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const catalogReqRef = useRef(0);
  // monorepo 探测到的候选 npm 包 + 各自适配检测结果
  const [pendingCandidates, setPendingCandidates] = useState<{
    repo: string;
    candidates: Array<{ package: string; report?: DshAdaptationReport }>;
  } | null>(null);
  // 精选插件的适配检测结果
  const [reports, setReports] = useState<Record<string, DshAdaptationReport>>({});
  const [detecting, setDetecting] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh/plugins");
      const d = (await res.json().catch(() => ({}))) as PluginsResponse;
      if (d.installed) setPlugins(d);
    } catch {
      // keep last known state
    }
  }, []);

  const loadMarket = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh/market");
      const d = (await res.json().catch(() => ({}))) as MarketResponse;
      if (d.items) setMarket(d);
    } catch {
      // ignore
    }
  }, []);

  const loadCatalog = useCallback(async (q: string, cat: string, page: number, append: boolean) => {
    const id = ++catalogReqRef.current;
    setCatalogLoading(true);
    setCatalogErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cat) params.set("category", cat);
      if (page > 1) params.set("page", String(page));
      const res = await fetch(`/api/dsh/catalog?${params.toString()}`);
      const d = (await res.json().catch(() => ({}))) as CatalogResponse;
      if (id !== catalogReqRef.current) return;
      if (d.items) {
        setCatalog((prev) =>
          append && prev ? { ...d, items: [...prev.items, ...d.items] } : d,
        );
      } else if ((d as { error?: string }).error) {
        setCatalogErr((d as unknown as { error: string }).error);
      }
    } catch (e) {
      if (id === catalogReqRef.current) setCatalogErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === catalogReqRef.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
    void loadMarket();
    void loadCatalog("", "", 1, false);
  }, [loadPlugins, loadMarket, loadCatalog]);

  const mutate = useCallback(
    async (action: "install" | "remove", pkg: string) => {
      setBusy(pkg);
      setActionMsg(null);
      setActionErr(null);
      try {
        const res = await fetch("/api/dsh/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, package: pkg }),
        });
        const d = (await res.json()) as {
          success?: boolean;
          error?: string;
          report?: DshAdaptationReport;
        };
        if (!res.ok || d.error) {
          const rejectReport = d.report;
          if (rejectReport) {
            setReports((prev) => ({ ...prev, [pkg]: rejectReport as DshAdaptationReport }));
          }
          setActionErr(rejectReport?.reason ?? d.error ?? `HTTP ${res.status}`);
        } else {
          setActionMsg(action === "install" ? t("dsh.installedBridged") : t("dsh.removed"));
          void loadPlugins();
        }
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [t, loadPlugins],
  );

  /** 对 npm 包做适配检测，结果缓存到本地 state。 */
  const detectPackage = useCallback(
    async (pkg: string): Promise<DshAdaptationReport | null> => {
      if (reports[pkg]) return reports[pkg];
      setDetecting(pkg);
      setActionErr(null);
      try {
        const res = await fetch("/api/dsh/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg }),
        });
        const d = (await res.json().catch(() => ({}))) as DshAdaptationReport & { error?: string };
        if (d.error && !d.package) {
          setActionErr(d.error);
          return null;
        }
        setReports((prev) => ({ ...prev, [pkg]: d as DshAdaptationReport }));
        return d;
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setDetecting(null);
      }
    },
    [reports],
  );

  /** 从生态目录的一个 GitHub 仓库一键安装：探测 → npm 包名 → 安装 + 桥接。 */
  const installFromRepo = useCallback(
    async (repo: string) => {
      setBusy(repo);
      setActionMsg(null);
      setActionErr(null);
      try {
        const inspRes = await fetch("/api/dsh/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo }),
        });
        const insp = (await inspRes.json()) as {
          installable?: boolean;
          npmPackage?: string | null;
          npmCandidates?: string[];
          skill?: { branch: string; path: string } | null;
          reason?: string;
          error?: string;
        };
        if (!insp.installable) {
          setActionErr(`${repo}: ${insp.reason ?? insp.error ?? "not installable"}`);
          return;
        }
        // monorepo：多个候选，交给用户逐个做适配检测
        if (insp.npmCandidates && insp.npmCandidates.length > 0) {
          setPendingCandidates({ repo, candidates: insp.npmCandidates.map((packageName) => ({ package: packageName })) });
          setActionErr(null);
          return;
        }
        if (insp.skill) {
          // skill 安装：下载 SKILL.md 到全局 skills 目录
          const skRes = await fetch("/api/dsh/skill-install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo, branch: insp.skill.branch, path: insp.skill.path }),
          });
          const sk = (await skRes.json()) as { success?: boolean; skillName?: string; error?: string };
          if (!skRes.ok || sk.error) {
            setActionErr(sk.error ?? `HTTP ${skRes.status}`);
          } else {
            setActionMsg(`${repo} → skill ${sk.skillName} · ${t("dsh.skillInstalled")}`);
          }
          return;
        }
        if (!insp.npmPackage) {
          setActionErr(`${repo}: ${insp.reason ?? "not installable"}`);
          return;
        }
        const report = await detectPackage(insp.npmPackage);
        if (!report) return;
        if (!report.adaptable) {
          setActionErr(`${insp.npmPackage}: ${report.reason}`);
          return;
        }
        const res = await fetch("/api/dsh/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "install", package: insp.npmPackage }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setActionErr(d.error ?? `HTTP ${res.status}`);
        } else {
          setActionMsg(`${repo} → ${insp.npmPackage} · ${t("dsh.installedBridged")}`);
          void loadPlugins();
        }
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [t, loadPlugins, detectPackage],
  );

  /** 批量检测 monorepo 候选，并把结果渲染进候选列表。 */
  const detectCandidates = useCallback(
    async (repo: string, packages: string[]) => {
      setBusy(`candidates:${repo}`);
      setActionErr(null);
      try {
        const results = await Promise.all(
          packages.map(async (pkg) => {
            const report = await detectPackage(pkg);
            return { package: pkg, report: report ?? undefined };
          }),
        );
        setPendingCandidates((prev) =>
          prev && prev.repo === repo ? { ...prev, candidates: results } : prev,
        );
      } finally {
        setBusy(null);
      }
    },
    [detectPackage],
  );

  const installedSet = useMemo(() => new Set(plugins?.installed ?? []), [plugins?.installed]);
  const loadedByPackage = useMemo(() => {
    const map = new Map<string, LoadedPlugin>();
    for (const p of plugins?.loaded ?? []) map.set(p.package, p);
    return map;
  }, [plugins?.loaded]);

  const visibleItems = useMemo(() => {
    const items = market?.items ?? [];
    return filter === "all" ? items : items.filter((i) => i.category === filter);
  }, [market, filter]);

  const runSearch = useCallback(() => {
    setSearch(searchInput.trim());
    setCatalog(null);
    void loadCatalog(searchInput.trim(), category, 1, false);
  }, [searchInput, category, loadCatalog]);

  const selectCategory = useCallback(
    (cat: string) => {
      setCategory(cat);
      setCatalog(null);
      void loadCatalog(search, cat, 1, false);
    },
    [search, loadCatalog],
  );

  const loadMore = useCallback(() => {
    if (!catalog || catalogLoading) return;
    void loadCatalog(search, category, catalog.page + 1, true);
  }, [catalog, catalogLoading, search, category, loadCatalog]);

  const categoryOptions = useMemo(() => {
    const labels = catalog?.categories ?? {};
    return [["", t("dsh.all")], ...Object.entries(labels)] as Array<[string, string]>;
  }, [catalog?.categories, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              {t("activity.dshMarket")}
            </span>
            <a
              href="https://dsh.deepseek404.com/index.php"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              DSH 商店 ↗
            </a>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={() => { void loadPlugins(); void loadMarket(); void loadCatalog(search, category, 1, false); }}
              title={t("i18n.refresh")}
              style={{
                width: 26, height: 26, padding: 0,
                background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
                color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Tab 切换 ── */}
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", height: 28, marginTop: 8 }}>
          {([
            ["catalog", t("dsh.ecosystemCatalog")],
            ["featured", t("dsh.featured")],
          ] as Array<[PanelTab, string]>).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                flex: 1, border: "none",
                borderRight: id === "catalog" ? "1px solid var(--border)" : "none",
                background: tab === id ? "var(--bg-selected)" : "none",
                color: tab === id ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", fontSize: 11, fontWeight: tab === id ? 600 : 450,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {actionErr && <div style={{ margin: "0 4px 8px", fontSize: 10, color: "#ef4444", overflowWrap: "anywhere" }}>{actionErr}</div>}
        {actionMsg && <div style={{ margin: "0 4px 8px", fontSize: 10, color: "#16a34a" }}>{actionMsg}</div>}

        {/* ── monorepo 候选选择 ── */}
        {pendingCandidates && (
          <div style={{ margin: "0 4px 10px", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 11px", background: "var(--bg-panel)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 7 }}>
              {t("dsh.monorepoCandidates", { n: String(pendingCandidates.candidates.length) })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {pendingCandidates.candidates.map(({ package: pkg, report }) => {
                const isDetecting = busy === `candidates:${pendingCandidates.repo}` && !report;
                return (
                  <div
                    key={pkg}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 10px", fontSize: 11, borderRadius: 5,
                      border: "1px solid var(--border)", background: "var(--bg-hover)",
                      fontFamily: "var(--font-mono)", flexWrap: "wrap",
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pkg}</span>
                    {!report && (
                      <button
                        type="button"
                        onClick={() => void detectCandidates(pendingCandidates.repo, pendingCandidates.candidates.map((c) => c.package))}
                        disabled={isDetecting}
                        style={{ fontSize: 10, color: "var(--accent)", background: "none", border: "none", cursor: isDetecting ? "default" : "pointer" }}
                      >
                        {isDetecting ? t("dsh.detecting") : t("dsh.detect")}
                      </button>
                    )}
                    {report && (
                      <span style={{ fontSize: 10, color: report.adaptable ? "#16a34a" : "#ef4444", flexShrink: 0 }}>
                        {report.adaptable ? t("dsh.adaptable") : t("dsh.notAdaptable")} · {t("dsh.adaptScore", { score: String(report.score) })}
                      </span>
                    )}
                    {report?.adaptable && (
                      <button
                        type="button"
                        onClick={() => { setPendingCandidates(null); void mutate("install", pkg); }}
                        disabled={busy === pkg}
                        style={{ fontSize: 10, color: "#fff", background: "var(--accent)", border: "none", borderRadius: 4, padding: "2px 8px", cursor: busy === pkg ? "default" : "pointer" }}
                      >
                        {busy === pkg ? t("i18n.installing") : t("i18n.install")}
                      </button>
                    )}
                    {report && !report.adaptable && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)", flexBasis: "100%", lineHeight: 1.4, overflowWrap: "anywhere" }}>
                        {report.reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setPendingCandidates(null)} style={{ ...btnStyle(), marginTop: 7, fontSize: 10 }}>
              {t("dsh.cancel")}
            </button>
          </div>
        )}

        {/* ── 已安装插件（两个 tab 都可见）── */}
        {plugins && plugins.installed.length > 0 && (
          <div style={{ margin: "0 4px 10px", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 11px", background: "var(--bg-panel)" }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginBottom: 7 }}>
              {t("dsh.installedPlugins", { n: String(plugins.installed.length) })}
            </div>
            {plugins.installed.map((pkg) => {
              const loaded = loadedByPackage.get(pkg);
              const isBusy = busy === pkg;
              return (
                <div key={pkg} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pkg}>
                    {pkg}
                  </span>
                  {loaded ? (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      {t("dsh.bridgedSummary", { tools: String(loaded.toolCount), skills: String(loaded.skillCount) })}
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: "#f59e0b", whiteSpace: "nowrap" }}>{t("dsh.loadFailed")}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => { if (!isBusy) void mutate("remove", pkg); }}
                    disabled={isBusy}
                    style={{ ...btnStyle(), fontSize: 10, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {isBusy ? t("i18n.removing") : t("dsh.remove")}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {tab === "catalog" && (
          <>
            {/* ── 搜索框 ── */}
            <div style={{ display: "flex", gap: 6, padding: "0 4px 8px" }}>
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                placeholder={t("dsh.searchPlaceholder")}
                style={{
                  flex: 1, height: 28, padding: "0 10px", fontSize: 12,
                  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text)", outline: "none",
                }}
              />
              <button type="button" onClick={runSearch} style={{ ...btnStyle(), background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}>
                {t("dsh.search")}
              </button>
            </div>

            {/* ── 分类 tab ── */}
            <div style={{ display: "flex", gap: 5, padding: "0 4px 10px", flexWrap: "wrap" }}>
              {categoryOptions.map(([slug, label]) => (
                <button
                  key={slug}
                  type="button"
                  onClick={() => selectCategory(slug)}
                  style={{
                    padding: "2px 9px", fontSize: 10, fontWeight: 500, borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: category === slug ? "var(--bg-selected)" : "none",
                    color: category === slug ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {catalogErr && <div style={{ margin: "0 4px 8px", fontSize: 10, color: "#ef4444", overflowWrap: "anywhere" }}>{catalogErr}</div>}

            {/* ── 生态目录列表 ── */}
            {(catalog?.items ?? []).map((item) => (
              <div key={item.repo} style={{ margin: "0 4px 8px", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 11px", background: "var(--bg-panel)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <a
                    href={item.githubUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}
                    title={item.repo}
                  >
                    {item.author}/{item.name}
                  </a>
                  {item.type && (
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.9)" }}>
                      {item.type}
                    </span>
                  )}
                </div>
                {item.description && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {item.description}
                  </div>
                )}
                {item.topics.length > 0 && (
                  <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                    {item.topics.slice(0, 5).map((tp) => (
                      <span key={tp} style={{ fontSize: 9, color: "var(--text-dim)", background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>
                        {tp}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontSize: 10, color: "var(--text-dim)" }}>
                  <span>⭐ {fmtCount(item.stars)}</span>
                  <span>⑂ {fmtCount(item.forks)}</span>
                  <span style={{ marginLeft: "auto" }}>{item.updatedLabel}</span>
                  <a href={item.detailUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>
                    {t("dsh.viewDetail")} ↗
                  </a>
                  <button
                    type="button"
                    onClick={() => { if (busy !== item.repo) void installFromRepo(item.repo); }}
                    disabled={busy === item.repo}
                    title={t("dsh.installHint")}
                    style={{
                      padding: "2px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4, border: "none",
                      background: "var(--accent)", color: "#fff", cursor: busy === item.repo ? "default" : "pointer",
                      opacity: busy === item.repo ? 0.6 : 1,
                    }}
                  >
                    {busy === item.repo ? t("dsh.detecting") : t("dsh.detect")}
                  </button>
                </div>
              </div>
            ))}

            {catalogLoading && <div style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("i18n.loading")}</div>}
            {!catalogLoading && (catalog?.items.length ?? 0) > 0 && (
              <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 10px" }}>
                <button type="button" onClick={loadMore} style={{ ...btnStyle() }}>
                  {t("dsh.loadMore")}
                </button>
              </div>
            )}
            {!catalogLoading && !catalogErr && (catalog?.items.length ?? 0) === 0 && (
              <div style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("dsh.emptyResult")}</div>
            )}
          </>
        )}

        {tab === "featured" && (
          <>
            {/* ── 手工精选过滤 ── */}
            <div style={{ padding: "0 4px 8px" }}>
              <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", height: 28 }}>
                {(["all", "A", "B", "C"] as const).map((f) => {
                  const active = filter === f;
                  const label = f === "all" ? t("dsh.all") : f === "A" ? t("dsh.catA") : f === "B" ? t("dsh.catB") : t("dsh.catC");
                  const count = f === "all" ? (market?.items.length ?? 0) : (market?.counts?.[f] ?? 0);
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      style={{
                        flex: 1, border: "none",
                        borderRight: f !== "C" ? "1px solid var(--border)" : "none",
                        background: active ? "var(--bg-selected)" : "none",
                        color: active ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 11, fontWeight: active ? 600 : 450,
                      }}
                    >
                      {label}
                      <span style={{ marginLeft: 4, fontSize: 9, color: "var(--text-dim)" }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── 手工精选目录 ── */}
            {visibleItems.map((item) => {
              const badge = categoryBadge(item.category, t);
              const isInstalled = item.category === "B" && installedSet.has(item.package);
              const isBundled = item.category === "B" && Boolean(item.includedIn && installedSet.has(item.includedIn));
              const isBusy = busy === item.package;
              const isDetecting = detecting === item.package;
              const report = reports[item.package];
              return (
                <div key={item.package} style={{ margin: "0 4px 8px", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 11px", background: "var(--bg-panel)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.package}>
                      {item.name}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: badge.bg, color: badge.fg }}>
                      {badge.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.45 }}>{item.description}</div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>{item.reason}</div>
                  {item.seams && item.seams.length > 0 && (
                    <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                      {item.seams.map((seam) => (
                        <span key={seam} style={{ fontSize: 9, color: "var(--text-dim)", background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>
                          {seam}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                    {dshRepoOf(item.package) && (
                      <a href={dshRepoOf(item.package)!} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none" }}>
                        {t("activity.officialSite")} ↗
                      </a>
                    )}
                    <a href={dshNpmUrlOf(item.package)} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--text-muted)", textDecoration: "none" }}>
                      npm ↗
                    </a>
                  </div>

                  {report && (
                    <div style={{ marginTop: 7, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span
                          style={{
                            fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 4,
                            background: report.adaptable ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.1)",
                            color: report.adaptable ? "#16a34a" : "#ef4444",
                          }}
                        >
                          {report.adaptable ? t("dsh.adaptable") : t("dsh.notAdaptable")}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                          {t("dsh.adaptScore", { score: String(report.score) })}
                        </span>
                        {report.capabilities.length > 0 && (
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                            {t("dsh.capsLabel")}: {report.capabilities.join(", ")}
                          </span>
                        )}
                      </div>
                      {!report.adaptable && (
                        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                          {report.reason}
                        </div>
                      )}
                      {report.seams.length > 0 && (
                        <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 9, color: "var(--text-dim)", alignSelf: "center" }}>{t("dsh.seamsLabel")}:</span>
                          {report.seams.map((s) => {
                            const stColor =
                              s.status === "mapped" ? "#16a34a"
                              : s.status === "pending" ? "#f59e0b"
                              : s.status === "blocked" ? "#ef4444" : "var(--text-dim)";
                            return (
                              <span
                                key={s.seam}
                                title={`${s.seam} → ${s.pi}`}
                                style={{ fontSize: 9, color: stColor, background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 3, fontFamily: "var(--font-mono)" }}
                              >
                                {s.seam} · {s.status === "mapped" ? t("dsh.seamMapped") : s.status === "pending" ? t("dsh.seamPending") : s.status === "blocked" ? t("dsh.seamBlocked") : s.pi}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {item.category === "A" && item.piRecommend && (
                    <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {t("dsh.recommendPi")}: <b style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{item.piRecommend.label}</b>
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenPiSearch(item.piRecommend!.target, item.piRecommend!.query)}
                        style={{ ...btnStyle(), fontSize: 10, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}
                      >
                        {t("dsh.goPiMarket")}
                      </button>
                    </div>
                  )}

                  {item.category === "B" && (
                    <div style={{ marginTop: 7, borderTop: "1px solid var(--border)", paddingTop: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {isBundled ? (
                        <span style={{ fontSize: 10, color: "#16a34a" }}>✓ {t("dsh.includedInBundle", { pkg: item.includedIn ?? "" })}</span>
                      ) : isInstalled ? (
                        <span style={{ fontSize: 10, color: "#16a34a" }}>✓ {t("i18n.installed")}</span>
                      ) : !report ? (
                        <button
                          type="button"
                          onClick={() => { if (!isDetecting) void detectPackage(item.package); }}
                          disabled={isDetecting}
                          style={{
                            padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 5,
                            border: "1px solid var(--border)", background: "none", color: "var(--text-muted)",
                            cursor: isDetecting ? "default" : "pointer", opacity: isDetecting ? 0.6 : 1,
                          }}
                        >
                          {isDetecting ? t("dsh.detecting") : t("dsh.detect")}
                        </button>
                      ) : report.adaptable ? (
                        <button
                          type="button"
                          onClick={() => { if (!isBusy) void mutate("install", item.package); }}
                          disabled={isBusy}
                          title={t("dsh.adaptableHint")}
                          style={{
                            padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 5, border: "none",
                            background: "var(--accent)", color: "#fff",
                            cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1,
                          }}
                        >
                          {isBusy ? t("i18n.installing") : t("i18n.install")}
                        </button>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("dsh.notAdaptable")}</span>
                      )}
                    </div>
                  )}

                  {item.category === "C" && (
                    <div style={{ marginTop: 7, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                      <button
                        type="button"
                        disabled
                        title={t("dsh.incompatible")}
                        style={{
                          padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 5, border: "1px solid var(--border)",
                          background: "none", color: "var(--text-dim)", cursor: "not-allowed", opacity: 0.55,
                        }}
                      >
                        {t("dsh.incompatible")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {!market && <div style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("i18n.loading")}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
  };
}
