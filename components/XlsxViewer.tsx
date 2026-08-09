"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type * as XLSX from "xlsx";
import { unzipSync } from "fflate";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
// Univer styles. Static imports keep them in this component's lazy chunk, so
// the ~60KB of design/sheets-ui CSS only loads when a spreadsheet is opened.
import "@univerjs/design/lib/index.css";
import "@univerjs/ui/lib/index.css";
import "@univerjs/sheets-ui/lib/index.css";
import "@univerjs/sheets-formula-ui/lib/index.css";
import "@univerjs/sheets-numfmt-ui/lib/index.css";
import "@univerjs/sheets-conditional-formatting-ui/lib/index.css";
import "@univerjs/sheets-data-validation-ui/lib/index.css";
import "@univerjs/sheets-filter-ui/lib/index.css";
import "@univerjs/sheets-sort-ui/lib/index.css";
import "@univerjs/sheets-table-ui/lib/index.css";
import "@univerjs/sheets-hyper-link-ui/lib/index.css";
import "@univerjs/sheets-note-ui/lib/index.css";
import "@univerjs/sheets-thread-comment-ui/lib/index.css";

interface Props {
  filePath: string;
  sourceSessionId?: string | null;
  /** Custom binary source (e.g. /api/univer/view for .univer files). Defaults to /api/files download. */
  binaryUrl?: string;
  /** Bump to force a reload (e.g. after the agent edits the file via the CLI). */
  refreshKey?: number;
  /**
   * Scope identity + revision for .univer files (e.g. `<file>::wt::<id>::<headCommit>`).
   * When provided, parsed workbook data is cached per scope and changes are
   * applied to the live grid in place instead of recreating the whole Univer
   * instance. Omit for plain .xlsx files (full reload per refreshKey).
   */
  scopeKey?: string;
  /** When set (a .univer worktree selected), enables "save edits to worktree". */
  worktreeId?: string | null;
  /** Called when the viewer auto-created a draft worktree for trunk-scope edits (worktree-only editing). */
  onWorktreeCreated?: (id: string) => void;
  /** Imperative handle: flush pending auto-save edits before external reads. */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  /** Set after each auto-save so the outer poll can skip its own reload. */
  ownSaveRef?: React.MutableRefObject<number | null>;
  /** Extra toolbar content (e.g. write-back button) rendered inside the header bar, before export buttons. */
  headerExtra?: React.ReactNode;
  /**
   * "AI 编辑" handler for plain .xlsx files: converts the file to a .univer,
   * opens it in the viewer and kicks off the sheet-edit skill. The returned
   * promise rejects with a user-facing message on failure.
   */
  onAiEdit?: (xlsxPath: string) => Promise<void> | void;
  /** Extra bar content (e.g. Univer worktree controls) rendered as a second row below the header. */
  children?: React.ReactNode;
}

function getDownloadUrl(filePath: string, sourceSessionId?: string | null): string {
  const params = new URLSearchParams({ type: "download" });
  if (sourceSessionId) params.set("sessionId", sourceSessionId);
  return `/api/files/${encodeFilePathForApi(filePath)}?${params.toString()}`;
}

const toolbarButtonStyle: CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 11,
  color: "var(--text)",
  cursor: "pointer",
  flexShrink: 0,
};

/* ------------------------------------------------------------------ */
/* xlsx → Univer IWorkbookData conversion                              */
/* ------------------------------------------------------------------ */

interface XlsxCellStyle {
  font?: { bold?: boolean; italic?: boolean; sz?: number; name?: string; color?: { rgb?: string } };
  fill?: { fgColor?: { rgb?: string } };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  numFmt?: string;
  z?: string;
  // xlsx@0.18.5 flattens fill onto the style: patternType / fgColor / bgColor.
  patternType?: string;
  fgColor?: { rgb?: string };
}

/** Map an xlsx CellStyle (0.18.5 embeds it inline on `cell.s`) to Univer IStyleData. */
function mapXlsxStyle(style: unknown): Record<string, unknown> | null {
  if (!style || typeof style !== "object") return null;
  const s = style as XlsxCellStyle;
  const out: Record<string, unknown> = {};

  const font = s.font;
  if (font) {
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (typeof font.sz === "number" && font.sz > 0) out.fs = font.sz;
    if (typeof font.name === "string" && font.name) out.ff = font.name;
    const rgb = font.color?.rgb;
    if (typeof rgb === "string" && rgb) {
      out.cl = { rgb: /^[0-9A-Fa-f]{6}$/.test(rgb) ? `#${rgb}` : rgb };
    }
  }

  const fill = s.fill;
  // xlsx@0.18.5 flattens fill to the top level: s.patternType / s.fgColor /
  // s.bgColor (not s.fill.fgColor). Read both shapes.
  let fgRgb: string | undefined = fill?.fgColor?.rgb;
  if (!fgRgb && s.fgColor?.rgb) fgRgb = s.fgColor.rgb;
  if (typeof fgRgb === "string" && fgRgb) {
    out.bg = { rgb: /^[0-9A-Fa-f]{6}$/.test(fgRgb) ? `#${fgRgb}` : fgRgb };
  }

  const align = s.alignment;
  if (align) {
    if (align.horizontal === "center") out.ht = 2;
    else if (align.horizontal === "right") out.ht = 3;
    else if (align.horizontal === "left") out.ht = 1;
    if (align.vertical === "top") out.vt = 1;
    else if (align.vertical === "middle") out.vt = 2;
    else if (align.vertical === "bottom") out.vt = 3;
    if (align.wrapText) out.tb = 1;
  }

  // Number format: either `style.numFmt` (from cellStyles) or the cell's `z`.
  const numFmt = s.numFmt ?? s.z;
  if (typeof numFmt === "string" && numFmt && numFmt !== "General") {
    out.n = { pattern: numFmt };
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** Excel date/time formats contain y/m/d/h/s letters (unlike "0.00" numeric formats). */
function isDateLikeFormat(fmt: string): boolean {
  return /[ymdhs]/.test(fmt) && !/^[0#.,?\s]+$/.test(fmt);
}

/** Excel serial date → epoch (Univer stores dates as numbers + a format). */
function excelSerialToNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return (v.getTime() / 86400000) + 25569; // days since 1899-12-30
  return 0;
}

/* ------------------------------------------------------------------ */
/* Advanced xlsx features (conditional formatting / data validation /  */
/* autoFilter) parsed from raw sheet XML — SheetJS CE does not expose   */
/* them, so we unzip the xlsx ourselves and translate the XML into     */
/* Univer's native workbook `resources` payloads.                      */
/* ------------------------------------------------------------------ */

interface XlsxAdvancedRange {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
  rangeType: number;
}

interface XlsxAdvancedSheetMeta {
  conditionalFormats?: unknown[];
  validations?: unknown[];
  filter?: { ref: XlsxAdvancedRange; filterColumns: unknown[]; cachedFilteredOut: unknown[] };
  /** A1-address → Univer alignment ({ ht, vt }) — SheetJS CE drops alignment
   *  from cell styles on read, so it is recovered from the raw sheet XML. */
  cellAlign?: Record<string, { ht?: number; vt?: number }>;
}

interface XlsxAdvancedMeta {
  sheets: Record<string, XlsxAdvancedSheetMeta>;
}

function parseXmlBytes(bytes: Uint8Array): Document {
  return new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
}

/** "A1", "$C$3", "B2:C8" → 0-based range. Single cell refs collapse to a 1x1 range. */
function a1ToRange(ref: string): { startRow: number; startColumn: number; endRow: number; endColumn: number } {
  const one = (p: string) => {
    const clean = p.replace(/\$/g, "");
    const m = clean.match(/^([A-Za-z]+)(\d+)$/);
    if (!m) throw new Error(`bad ref ${ref}`);
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]) - 1, col: col - 1 };
  };
  const parts = ref.split(":");
  const a = one(parts[0]);
  const b = parts.length > 1 ? one(parts[1]) : a;
  return { startRow: a.row, startColumn: a.col, endRow: b.row, endColumn: b.col };
}

/** "C3:C8 A1:B2" → array of ranges (sqref can contain multiple space-separated refs). */
function sqrefToRanges(sqref: string): XlsxAdvancedRange[] {
  return sqref.split(/\s+/).filter(Boolean).map((ref) => ({ ...a1ToRange(ref), rangeType: 0 }));
}

/** ARGB (#AARRGGBB or RRGGBB) → Univer rgb string "rgb(r,g,b)". */
function argbToRgb(argb: string | null | undefined): string | undefined {
  if (!argb) return undefined;
  const hex = argb.replace(/^#/, "");
  const rgb = hex.length === 8 ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return undefined;
  return `rgb(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)})`;
}

/** <dxf> → Univer conditional-format style ({ bg, cl, bl }). */
function parseDxfStyle(dxf: Element): Record<string, unknown> | undefined {
  const style: Record<string, unknown> = {};
  // Excel writes CF fills as <patternFill><bgColor rgb="..."/></patternFill>;
  // some writers use a solid fill with fgColor instead — accept both.
  const bgEl = dxf.getElementsByTagName("bgColor")[0];
  const fgEl = dxf.getElementsByTagName("fgColor")[0];
  const rgb = argbToRgb(bgEl?.getAttribute("rgb")) ?? argbToRgb(fgEl?.getAttribute("rgb"));
  if (rgb) style.bg = { rgb };
  const fontEl = dxf.getElementsByTagName("font")[0];
  const crgb = argbToRgb(fontEl?.getElementsByTagName("color")[0]?.getAttribute("rgb"));
  if (crgb) style.cl = { rgb: crgb };
  if (fontEl?.getElementsByTagName("b").length) style.bl = 1;
  return Object.keys(style).length > 0 ? style : undefined;
}

const CF_NUMBER_OPERATORS: Record<string, string> = {
  greaterThan: "greaterThan", lessThan: "lessThan", equal: "equal", notEqual: "notEqual",
  greaterThanOrEqual: "greaterThanOrEqual", lessThanOrEqual: "lessThanOrEqual",
  between: "between", notBetween: "notBetween",
};

function cfFormulaText(el: Element | null): string {
  return (el?.textContent ?? "").replace(/^=/, "").trim();
}

/**
 * Parse an Excel inline data-validation list (formula1) into items.
 * Excel writes an inline list as ONE quoted, comma-separated string
 * ("a,b,c") — items are always comma-separated inside a single outer pair
 * of quotes (Excel itself cannot create list items containing commas, and
 * Univer's exporter writes the same shape). Returns null when the text is
 * not an inline list (range references / formulas pass through untouched),
 * so callers fall back to the raw formula1.
 */
function parseInlineList(raw: string): string[] | null {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  const out = raw
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return out.length > 0 ? out : null;
}

/** xlsx <cfRule> → Univer rule body (without ranges/cfId). Unsupported → null. */
function mapCfRule(cfRule: Element, style: Record<string, unknown> | undefined): unknown | null {
  const type = cfRule.getAttribute("type");
  const formulas = Array.from(cfRule.getElementsByTagName("formula")).map(cfFormulaText);
  if (type === "cellIs") {
    const op = cfRule.getAttribute("operator") ?? "";
    const univerOp = CF_NUMBER_OPERATORS[op];
    if (!univerOp) return null;
    const n = (i: number) => Number(formulas[i] ?? "0");
    const value = op === "between" || op === "notBetween" ? [n(0), n(1)] : n(0);
    return { type: "highlightCell", subType: "number", operator: univerOp, value, ...(style ? { style } : {}) };
  }
  if (type === "containsText" || type === "notContainsText" || type === "beginsWith" || type === "endsWith") {
    const raw = cfFormulaText(cfRule.getElementsByTagName("formula")[0] ?? null);
    const text = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return { type: "highlightCell", subType: "text", operator: type, value: text, ...(style ? { style } : {}) };
  }
  return null;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Unzip an xlsx byte buffer and read conditionalFormatting / dataValidations /
 * autoFilter from the sheet XML plus dxfs from styles.xml. Returns null when
 * the buffer is not a usable zip or nothing advanced is present.
 */
export function parseXlsxAdvancedFeatures(bytes: Uint8Array): XlsxAdvancedMeta | null {
  let zip: Record<string, Uint8Array>;
  try { zip = unzipSync(bytes); } catch { return null; }

  // dxfs (indexed by dxfId on each cfRule) + cellXfs alignment (indexed by
  // each cell's s= attribute; SheetJS CE does not surface alignment).
  const dxfs: Array<Record<string, unknown> | undefined> = [];
  const xfAlign: Array<{ horizontal?: string; vertical?: string }> = [];
  const stylesBytes = zip["xl/styles.xml"];
  if (stylesBytes) {
    const stylesDoc = parseXmlBytes(stylesBytes);
    Array.from(stylesDoc.getElementsByTagName("dxf")).forEach((dxf) => dxfs.push(parseDxfStyle(dxf)));
    Array.from(stylesDoc.getElementsByTagName("cellXfs")).forEach((cxfs) => {
      Array.from(cxfs.getElementsByTagName("xf")).forEach((xf) => {
        const al = xf.getElementsByTagName("alignment")[0];
        const align: { horizontal?: string; vertical?: string } = {};
        if (al) {
          const h = al.getAttribute("horizontal");
          const v = al.getAttribute("vertical");
          if (h) align.horizontal = h;
          if (v) align.vertical = v;
        }
        xfAlign.push(align);
      });
    });
  }

  // map rId → worksheet target from workbook.xml + rels, preserving sheet order
  const relMap: Record<string, string> = {};
  const relsBytes = zip["xl/_rels/workbook.xml.rels"];
  if (relsBytes) {
    const relsDoc = parseXmlBytes(relsBytes);
    Array.from(relsDoc.getElementsByTagName("Relationship")).forEach((rel) => {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) relMap[id] = target.replace(/^\//, "");
    });
  }
  const sheetFiles: string[] = [];
  const wbBytes = zip["xl/workbook.xml"];
  if (wbBytes) {
    const wbDoc = parseXmlBytes(wbBytes);
    Array.from(wbDoc.getElementsByTagName("sheet")).forEach((sheet) => {
      const rid = sheet.getAttribute("r:id") ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const target = rid ? relMap[rid] : undefined;
      sheetFiles.push(target ? `xl/${target}` : "");
    });
  }

  const sheets: XlsxAdvancedMeta["sheets"] = {};
  sheetFiles.forEach((file, i) => {
    if (!file || !zip[file]) return;
    const doc = parseXmlBytes(zip[file]);
    const info: XlsxAdvancedSheetMeta = {};

    // Conditional formatting
    const cfOut: unknown[] = [];
    Array.from(doc.getElementsByTagName("conditionalFormatting")).forEach((cf) => {
      const ranges = sqrefToRanges(cf.getAttribute("sqref") ?? "");
      Array.from(cf.getElementsByTagName("cfRule")).forEach((ruleEl) => {
        const dxfId = Number(ruleEl.getAttribute("dxfId") ?? -1);
        const rule = mapCfRule(ruleEl, dxfs[dxfId]);
        if (!rule) return;
        cfOut.push({ rule, ranges, cfId: randomId(), stopIfTrue: false });
      });
    });
    if (cfOut.length > 0) info.conditionalFormats = cfOut;

    // Data validation
    const dvOut: unknown[] = [];
    Array.from(doc.getElementsByTagName("dataValidation")).forEach((dv) => {
      const rule: Record<string, unknown> = {
        uid: randomId(),
        ranges: sqrefToRanges(dv.getAttribute("sqref") ?? ""),
        type: (dv.getAttribute("type") ?? "any").toLowerCase(),
      };
      const op = dv.getAttribute("operator");
      if (op) rule.operator = op;
      const f1 = cfFormulaText(dv.getElementsByTagName("formula1")[0] ?? null);
      const f2 = cfFormulaText(dv.getElementsByTagName("formula2")[0] ?? null);
      if (rule.type === "list" && f1 !== "") {
        // Excel stores inline lists as a single quoted string ("是,否").
        // Univer's deserializeListOptions only accepts a JSON array or an
        // unquoted comma list — the raw quoted form would make the first and
        // last dropdown options carry a stray quote. Parse CSV-style and hand
        // Univer its native JSON-array serialization instead.
        const items = parseInlineList(f1);
        rule.formula1 = items ? JSON.stringify(items) : f1;
      } else {
        if (f1 !== "") rule.formula1 = f1;
        if (f2 !== "") rule.formula2 = f2;
      }
      for (const [attr, key] of [
        ["allowBlank", "allowBlank"], ["showErrorMessage", "showErrorMessage"], ["showInputMessage", "showInputMessage"],
        ["error", "error"], ["errorTitle", "errorTitle"], ["prompt", "prompt"], ["promptTitle", "promptTitle"], ["errorStyle", "errorStyle"],
      ] as const) {
        const v = dv.getAttribute(attr);
        if (v !== null) rule[key] = attr.startsWith("allow") || attr.startsWith("show") ? v === "1" || v === "true" : v;
      }
      dvOut.push(rule);
    });
    if (dvOut.length > 0) info.validations = dvOut;

    // AutoFilter
    const af = doc.getElementsByTagName("autoFilter")[0];
    const afRef = af?.getAttribute("ref");
    if (afRef) {
      info.filter = { ref: { ...a1ToRange(afRef), rangeType: 0 }, filterColumns: [], cachedFilteredOut: [] };
    }

    // Per-cell alignment (see xfAlign above). Empty <alignment/> and cells
    // without an s= attribute are skipped.
    const cellAlign: Record<string, { ht?: number; vt?: number }> = {};
    Array.from(doc.getElementsByTagName("c")).forEach((cEl) => {
      const sIdx = Number(cEl.getAttribute("s") ?? -1);
      const al = xfAlign[sIdx];
      if (!al || (!al.horizontal && !al.vertical)) return;
      const addr = cEl.getAttribute("r");
      if (!addr) return;
      const mapped: { ht?: number; vt?: number } = {};
      if (al.horizontal === "center") mapped.ht = 2;
      else if (al.horizontal === "right") mapped.ht = 3;
      else if (al.horizontal === "left") mapped.ht = 1;
      if (al.vertical === "center") mapped.vt = 2;
      else if (al.vertical === "top") mapped.vt = 1;
      else if (al.vertical === "bottom") mapped.vt = 3;
      if (mapped.ht || mapped.vt) cellAlign[addr] = mapped;
    });
    if (Object.keys(cellAlign).length > 0) info.cellAlign = cellAlign;

    sheets[String(i)] = info;
  });

  return Object.keys(sheets).length > 0 ? { sheets } : null;
}

/** Build Univer workbook `resources` (plugin payloads) from parsed xlsx meta. */
function buildAdvancedResources(meta: XlsxAdvancedMeta | null, unitId: string): Array<{ name: string; data: string }> {
  if (!meta) return [];
  const withIds = <T extends { ranges?: XlsxAdvancedRange[] }>(entry: T, sheetId: string): T => ({
    ...entry,
    ...(entry.ranges ? {
      ranges: entry.ranges.map((r) => ({ ...r, unitId, sheetId })),
    } : {}),
  });
  const cf: Record<string, unknown[]> = {};
  const dv: Record<string, unknown[]> = {};
  const fl: Record<string, unknown> = {};
  for (const [sheetId, info] of Object.entries(meta.sheets)) {
    if (info.conditionalFormats?.length) {
      cf[sheetId] = info.conditionalFormats.map((r) => withIds(r as { ranges?: XlsxAdvancedRange[] }, sheetId));
    }
    if (info.validations?.length) {
      dv[sheetId] = info.validations.map((r) => withIds(r as { ranges?: XlsxAdvancedRange[] }, sheetId));
    }
    if (info.filter) {
      fl[sheetId] = info.filter;
    }
  }
  const resources: Array<{ name: string; data: string }> = [];
  if (Object.keys(cf).length > 0) resources.push({ name: "SHEET_CONDITIONAL_FORMATTING_PLUGIN", data: JSON.stringify(cf) });
  if (Object.keys(dv).length > 0) resources.push({ name: "SHEET_DATA_VALIDATION_PLUGIN", data: JSON.stringify(dv) });
  if (Object.keys(fl).length > 0) resources.push({ name: "SHEET_FILTER_PLUGIN", data: JSON.stringify(fl) });
  return resources;
}

/* ------------------------------------------------------------------ */
/* Sheet data conversion                                               */
/* ------------------------------------------------------------------ */

interface WorktreeEditChange {
  r: number;
  c: number;
  clear?: boolean;
  cell?: { v?: unknown; t?: number; f?: string };
}

type NormCell = { v?: unknown; t?: number; f?: string };
type NormMap = Record<number, Record<number, NormCell>>;

/** Normalize a save() snapshot's first-sheet cellData into the diff baseline shape. */
function normalizeCellMap(snapshot: UniverWorkbookData): NormMap | null {
  const firstSheet = Object.values(snapshot.sheets ?? {})[0];
  const cellData = (firstSheet?.cellData ?? {}) as Record<string, Record<string, UniverCell>>;
  const out: NormMap = {};
  for (const [rStr, row] of Object.entries(cellData)) {
    const r = Number(rStr);
    const oRow: Record<number, NormCell> = {};
    for (const [cStr, cell] of Object.entries(row)) {
      oRow[Number(cStr)] = { v: cell.v, t: cell.t, f: cell.f };
    }
    out[r] = oRow;
  }
  return out;
}

/** Diff the first sheet's cells (v/t/f) between the loaded baseline and the current snapshot. */
function diffWorktreeCells(original: NormMap | null, current: NormMap | null): WorktreeEditChange[] {
  const changes: WorktreeEditChange[] = [];
  if (!original || !current) return changes;
  const rows = new Set<number>([...Object.keys(original).map(Number), ...Object.keys(current).map(Number)]);
  for (const r of rows) {
    const oRow = original[r] ?? {};
    const cRow = current[r] ?? {};
    const cols = new Set<number>([...Object.keys(oRow).map(Number), ...Object.keys(cRow).map(Number)]);
    for (const c of cols) {
      const o = oRow[c];
      const cur = cRow[c];
      if (!o && !cur) continue;
      if (!cur) { changes.push({ r, c, clear: true }); continue; }
      if (!o) { changes.push({ r, c, cell: { v: cur.v, t: cur.t, f: cur.f } }); continue; }
      const sameV = o.v === cur.v || (o.v != null && cur.v != null && String(o.v) === String(cur.v));
      const sameT = (o.t ?? 2) === (cur.t ?? 2);
      const sameF = (o.f ?? "") === (cur.f ?? "");
      if (!sameV || !sameT || !sameF) {
        changes.push({ r, c, cell: { v: cur.v, t: cur.t, f: cur.f } });
      }
    }
  }
  return changes;
}

/**
 * @param advancedMeta parsed conditional formatting / validation / filter
 *   payloads (see parseXlsxAdvancedFeatures); merged into `resources` so the
 *   corresponding Univer plugins restore them when the unit is created.
 */
export function convertWorkbook(
  wb: XLSX.WorkBook,
  utils: typeof XLSX.utils,
  advancedMeta: XlsxAdvancedMeta | null = null,
  sheetDims?: Array<{ name: string; maxRow: number; maxColumn: number }> | null,
): UniverWorkbookData {
  const sheets: Record<string, Record<string, unknown>> = {};
  const names: string[] = Array.isArray(wb?.SheetNames) ? wb.SheetNames : [];

  names.forEach((name, i) => {
    const ws: XLSX.WorkSheet | undefined = wb.Sheets?.[name];
    if (!ws) return;

    let range: XLSX.Range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    try {
      if (ws["!ref"] && utils?.decode_range) {
        range = utils.decode_range(ws["!ref"]);
      }
    } catch { /* keep empty range */ }

    const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Record<number, Record<string, unknown>> = {};
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = utils?.encode_cell ? utils.encode_cell({ r, c }) : `${String.fromCharCode(65 + c)}${r + 1}`;
        const cell: XLSX.CellObject | undefined = ws[addr];
        if (!cell || cell.t === "z") continue;
        const entry: Record<string, unknown> = {};
        const v = cell.v;
        switch (cell.t) {
          case "n": entry.t = 2; entry.v = typeof v === "number" ? v : 0; break;
          case "d": entry.t = 2; entry.v = excelSerialToNumber(v); break;
          case "b": entry.t = 3; entry.v = Boolean(v); break;
          case "e": entry.t = 1; entry.v = v == null ? "#ERROR!" : String(v); break;
          default: entry.t = 1; entry.v = v == null ? "" : String(v); break;
        }

        if (typeof cell.f === "string" && cell.f) {
          entry.f = cell.f.replace(/^=/, "");
          if (entry.v == null || entry.v === "") entry.v = null;
        }

        const fmt = cell.z;
        // Merge the number format (cell.z, e.g. 0% / #,##0.00 / date patterns)
        // into the cell style. SheetJS's cell.s only ever carries the fill, so
        // reading numFmt from it silently drops every non-date format; and
        // date-like formats must MERGE rather than replace so the background/
        // alignment on the cell isn't lost.
        const mappedFmt =
          typeof fmt === "string" && fmt && fmt !== "General"
            ? mapXlsxStyle({ numFmt: fmt })
            : null;
        const mappedCell = mapXlsxStyle(cell.s);
        if (mappedFmt || mappedCell) {
          entry.s = { ...(mappedCell ?? {}), ...(mappedFmt ?? {}) };
        }

        // Alignment comes from the raw sheet XML (SheetJS CE drops it).
        const align = advancedMeta?.sheets?.[String(i)]?.cellAlign?.[addr];
        if (align) {
          entry.s = entry.s ? { ...entry.s, ...align } : { ...align };
        }

        if (entry.v === null && entry.f == null && entry.s == null) continue;
        row[c] = entry;
      }
      if (Object.keys(row).length > 0) cellData[r] = row;
    }

    // Row heights / column widths (xlsx: hpt = points, wch = characters).
    const rowData: Record<number, { h: number }> = {};
    const rows: Array<{ hpt?: number }> | undefined = ws["!rows"];
    if (Array.isArray(rows)) {
      rows.forEach((rd, idx) => {
        const hpt = rd?.hpt;
        if (typeof hpt === "number" && hpt > 0) rowData[idx] = { h: Math.round(hpt * 4 / 3) };
      });
    }
    const columnData: Record<number, { w: number }> = {};
    const cols: Array<{ wch?: number }> | undefined = ws["!cols"];
    if (Array.isArray(cols)) {
      cols.forEach((cd, idx) => {
        const wch = cd?.wch;
        if (typeof wch === "number" && wch > 0) columnData[idx] = { w: Math.round(wch * 7 + 5) };
      });
    }

    const merges = Array.isArray(ws["!merges"])
      ? ws["!merges"].map((m: XLSX.Range) => ({
          startRow: m?.s?.r ?? 0,
          endRow: m?.e?.r ?? 0,
          startColumn: m?.s?.c ?? 0,
          endColumn: m?.e?.c ?? 0,
        }))
      : [];

    sheets[String(i)] = {
      id: String(i),
      name,
      rowCount: sheetDims?.find((d) => d.name === name)?.maxRow ?? range.e.r - range.s.r + 1,
      columnCount: sheetDims?.find((d) => d.name === name)?.maxColumn ?? range.e.c - range.s.c + 1,
      cellData,
      ...(Object.keys(rowData).length > 0 ? { rowData } : {}),
      ...(Object.keys(columnData).length > 0 ? { columnData } : {}),
      ...(merges.length > 0 ? { mergeData: merges } : {}),
    };
  });

  const workbookData: UniverWorkbookData = { id: "xlsx-viewer", name: "xlsx-viewer", sheets };
  const resources = buildAdvancedResources(advancedMeta, "xlsx-viewer");
  if (resources.length > 0) workbookData.resources = resources;
  return workbookData;
}

/* ------------------------------------------------------------------ */
/* Parsed-scope cache + in-place workbook diff                         */
/* ------------------------------------------------------------------ */

const MAX_SCOPE_CACHE_ENTRIES = 64;
// Bump whenever the xlsx→Univer parsing pipeline changes (parseXlsxAdvancedFeatures /
// convertWorkbook / fetchAndParseScope). It prefixes every cache key, so browsers
// holding parses from older code re-fetch + re-parse instead of serving pre-fix data
// for the same scope+headCommit (user-visible as "stale until I click refresh").
const SCOPE_PARSER_VERSION = 2;
const scopeDataCache = new Map<string, Promise<ScopeData>>();

function scopedCacheKey(scopeKey: string): string {
  return `v${SCOPE_PARSER_VERSION}::${scopeKey}`;
}

function cacheScopeData(key: string, p: Promise<ScopeData>): Promise<ScopeData> {
  scopeDataCache.set(key, p);
  // LRU-ish cap: drop the oldest entry when the map grows too large.
  if (scopeDataCache.size > MAX_SCOPE_CACHE_ENTRIES) {
    const oldest = scopeDataCache.keys().next().value;
    if (oldest !== undefined) scopeDataCache.delete(oldest);
  }
  return p;
}

async function fetchAndParseScope(binaryUrl: string): Promise<ScopeData> {
  const [xlsx] = await Promise.all([import("xlsx")]);
  const response = await fetch(binaryUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // SheetJS CE drops conditional formatting / data validation / filters on
  // read, so parse the raw xlsx XML for those and hand them to the Univer
  // plugins via workbook resources (native format, read back from the CLI).
  const advancedMeta = parseXlsxAdvancedFeatures(bytes);
  const wb = xlsx.read(bytes, { type: "array", cellStyles: true });
  // xlsx has no fixed grid size — the view route sends the .univer sheet's
  // configured maxRow/maxColumn in this header; apply them on top of the
  // parsed data extent so the grid renders at its full size.
  let dims: ScopeData["dims"] = null;
  try {
    const raw = response.headers.get("X-Univer-Sheet-Dims");
    if (raw) dims = JSON.parse(decodeURIComponent(raw)) as ScopeData["dims"];
  } catch { /* ignore malformed header */ }
  const data = convertWorkbook(wb, xlsx.utils, advancedMeta, dims);
  return { data, dims };
}

/**
 * Load (and cache) the parsed workbook for a .univer scope. `scopeKey` must
 * encode the scope identity AND its revision (worktree headCommit / trunk
 * mtime) so a new commit produces a new key → cache miss → fresh fetch.
 * Concurrent callers share the in-flight promise; `force` bypasses the cache
 * (manual refresh).
 */
export async function loadScopeData(scopeKey: string, binaryUrl: string, force = false): Promise<ScopeData> {
  const key = scopedCacheKey(scopeKey);
  if (!force) {
    const cached = scopeDataCache.get(key);
    if (cached) return cached;
  }
  // A freshly-committed worktree can transiently 500 the export (the commit
  // and the view request race inside the daemon) — retry once after a pause
  // before surfacing the error to the user.
  const fetchWithRetry = async (attempt: number): Promise<ScopeData> => {
    try {
      return await fetchAndParseScope(binaryUrl);
    } catch (error) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        return fetchWithRetry(1);
      }
      throw error;
    }
  };
  const p = fetchWithRetry(0).catch((error) => {
    // A failed load must not poison the cache for later retries.
    if (scopeDataCache.get(key) === p) scopeDataCache.delete(key);
    throw error;
  });
  cacheScopeData(key, p);
  return p;
}

/** Background warm: pre-parse a scope so switching to it is instant. */
export async function warmScopeData(scopeKey: string, binaryUrl: string): Promise<void> {
  try {
    await loadScopeData(scopeKey, binaryUrl);
  } catch {
    // warm is best-effort
  }
}

interface MergeRect {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

interface DiffCellChange {
  r: number;
  c: number;
  clear?: boolean;
  cell?: Record<string, unknown>;
  /** true when the target style differs from the last-applied style — the
   *  live cell must be cleared with s:null first (setValue deep-merges style
   *  fields, so a subset style would leave removed fields lingering). */
  styleChanged?: boolean;
  /** The target style to re-apply after clearing (null = no style). */
  style?: Record<string, unknown> | null;
}

interface WorkbookDiffPlan {
  recreate: boolean;
  order: string[];
  cells: Record<string, DiffCellChange[]>;
  addedMerges: Record<string, MergeRect[]>;
  removedMerges: Record<string, MergeRect[]>;
}

const MAX_DIFF_CELLS = 8000;

function mergeRectKey(m: MergeRect): string {
  return `${m.startRow},${m.startColumn},${m.endRow},${m.endColumn}`;
}

function mergeRectMap(list: UniverSheet["mergeData"]): Map<string, MergeRect> {
  const map = new Map<string, MergeRect>();
  for (const m of list ?? []) {
    if (typeof m?.startRow !== "number" || typeof m?.endRow !== "number" || typeof m?.startColumn !== "number" || typeof m?.endColumn !== "number") continue;
    map.set(mergeRectKey(m), { startRow: m.startRow, endRow: m.endRow, startColumn: m.startColumn, endColumn: m.endColumn });
  }
  return map;
}

function cellsEqual(a: UniverCell | undefined, b: UniverCell | undefined): boolean {
  if (!a || !b) return a === b;
  const sameV = a.v === b.v || (a.v != null && b.v != null && String(a.v) === String(b.v));
  const sameT = (a.t ?? 2) === (b.t ?? 2);
  const sameF = (a.f ?? "") === (b.f ?? "");
  const sameS = JSON.stringify(a.s ?? null) === JSON.stringify(b.s ?? null);
  return sameV && sameT && sameF && sameS;
}

/** CF/DV rules carry per-parse random ids (cfId/uid) — normalize them away so
 *  unchanged resources compare equal across separate exports. */
function stripVolatileIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileIds);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "cfId" || k === "uid") { out[k] = "X"; continue; }
      out[k] = stripVolatileIds(v);
    }
    return out;
  }
  return value;
}

function resourcesEqual(a: UniverWorkbookData["resources"], b: UniverWorkbookData["resources"]): boolean {
  const norm = (res: UniverWorkbookData["resources"] | undefined): unknown =>
    (res ?? []).map((r) => {
      let data: unknown = r.data;
      try {
        data = JSON.parse(r.data);
      } catch {
        // not JSON — compare the raw string
      }
      return { name: r.name, data: stripVolatileIds(data) };
    });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * Diff two parsed workbooks (last-applied vs target) into a plan that can be
 * applied to the live Univer instance in place. Structural changes (sheet
 * set/names/dimensions or CF/validation/filter resources) or a very large cell
 * diff fall back to a full recreate.
 */
function diffWorkbooks(last: UniverWorkbookData, next: UniverWorkbookData): WorkbookDiffPlan {
  const plan: WorkbookDiffPlan = { recreate: false, order: [], cells: {}, addedMerges: {}, removedMerges: {} };
  const lastSheets = last.sheets ?? {};
  const nextSheets = next.sheets ?? {};
  const lastKeys = Object.keys(lastSheets);
  const nextKeys = Object.keys(nextSheets);
  if (lastKeys.length !== nextKeys.length) { plan.recreate = true; return plan; }
  if (!resourcesEqual(last.resources, next.resources)) { plan.recreate = true; return plan; }
  for (const key of nextKeys) {
    const a = lastSheets[key];
    const b = nextSheets[key];
    if (!a || !b || a.name !== b.name || (a.rowCount ?? 1) !== (b.rowCount ?? 1) || (a.columnCount ?? 1) !== (b.columnCount ?? 1)) {
      plan.recreate = true;
      return plan;
    }
  }
  plan.order = nextKeys;
  let total = 0;
  for (const key of nextKeys) {
    const a = lastSheets[key].cellData ?? {};
    const b = nextSheets[key].cellData ?? {};
    const changes: DiffCellChange[] = [];
    const rows = new Set<number>([...Object.keys(a).map(Number), ...Object.keys(b).map(Number)]);
    for (const r of rows) {
      const ar = a[r] ?? {};
      const br = b[r] ?? {};
      const cols = new Set<number>([...Object.keys(ar).map(Number), ...Object.keys(br).map(Number)]);
      for (const c of cols) {
        const ac = ar[c];
        const bc = br[c];
        if (cellsEqual(ac, bc)) continue;
        if (!bc) changes.push({ r, c, clear: true });
        else {
          const styleChanged = JSON.stringify(ac?.s ?? null) !== JSON.stringify(bc.s ?? null);
          const cell = structuredClone(bc) as Record<string, unknown>;
          if (styleChanged) {
            // setValue merges cell data: dropping s keeps the old style, and a
            // partial s deep-merges its fields. Handle the style separately.
            delete cell.s;
            changes.push({
              r,
              c,
              cell,
              styleChanged,
              style: bc.s ? structuredClone(bc.s) as Record<string, unknown> : null,
            });
          } else {
            changes.push({ r, c, cell });
          }
        }
      }
    }
    plan.cells[key] = changes;
    total += changes.length;
    if (total > MAX_DIFF_CELLS) { plan.recreate = true; return plan; }

    const aMerges = mergeRectMap(lastSheets[key].mergeData);
    const bMerges = mergeRectMap(nextSheets[key].mergeData);
    plan.removedMerges[key] = [...aMerges.values()].filter((m) => !bMerges.has(mergeRectKey(m)));
    plan.addedMerges[key] = [...bMerges.values()].filter((m) => !aMerges.has(mergeRectKey(m)));
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface UniverCell {
  v?: unknown;
  t?: number;
  f?: string;
  s?: Record<string, unknown>;
}

interface UniverSheet {
  name?: string;
  rowCount?: number;
  columnCount?: number;
  cellData?: Record<string, Record<string, UniverCell>>;
  mergeData?: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
}

interface UniverWorkbookData {
  id?: string;
  name?: string;
  sheets?: Record<string, UniverSheet>;
  resources?: Array<{ name: string; data: string }>;
}

/** Minimal facade surface we use from the FUniver API (structural — the real
 *  FUniver is created inside the component and cast onto this shape). */
interface UniverRangeLike {
  setValue(value: unknown): void;
  merge(options?: { isForceMerge?: boolean }): void;
  getUnitId(): string;
}

interface UniverSheetLike {
  getRange(row: number, col: number, numRows: number, numCols: number): UniverRangeLike;
  getSheetId(): string;
  getSheetName(): string;
}

interface UniverWorkbookLike {
  save(): UniverWorkbookData;
  setEditable(editable: boolean): void;
  getActiveSheet(): UniverSheetLike;
  getSheetByName(name: string): UniverSheetLike | null;
}

interface UniverApiLike {
  getActiveWorkbook(): UniverWorkbookLike | null;
  executeCommand?<P extends object = object, R = boolean>(id: string, params?: P, options?: unknown): Promise<R>;
}

/** A parsed .univer scope (workbook data + embedded plugin resources). */
export interface ScopeData {
  data: UniverWorkbookData;
  /** Per-sheet grid dims from the view route header (name → maxRow/maxColumn),
   *  recovered because xlsx exports drop the sheet's configured grid size. */
  dims?: Array<{ name: string; maxRow: number; maxColumn: number }> | null;
}

function triggerDownload(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Convert an edited Univer IWorkbookData back into an xlsx workbook (in-memory). */
export function univerToXlsx(data: UniverWorkbookData, utils: typeof XLSX.utils): XLSX.WorkBook {
  const wb = utils.book_new();
  const sheets: Record<string, UniverSheet> = data?.sheets ?? {};
  for (const sheet of Object.values(sheets)) {
    const ws: Record<string, unknown> = {};
    const cellData: Record<string, Record<string, UniverCell>> = sheet?.cellData ?? {};
    for (const [rStr, row] of Object.entries(cellData)) {
      for (const [cStr, cell] of Object.entries(row)) {
        const addr = utils.encode_cell({ r: Number(rStr), c: Number(cStr) });
        const out: Record<string, unknown> = {};
        const nPattern = (cell?.s as { n?: { pattern?: string } } | undefined)?.n?.pattern;
        if (cell?.f) out.f = String(cell.f).replace(/^=/, "");
        const v = cell?.v;
        if (typeof v === "boolean" || cell?.t === 3) { out.t = "b"; out.v = Boolean(v); }
        else if (cell?.t === 2) { out.t = "n"; out.v = typeof v === "number" ? v : 0; }
        else { out.t = "s"; out.v = v == null ? "" : String(v); }
        if (nPattern && out.t === "n" && isDateLikeFormat(nPattern)) out.t = "d";
        if (nPattern) out.z = nPattern;
        ws[addr] = out;
      }
    }
    const merges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }> = sheet?.mergeData ?? [];
    if (Array.isArray(merges) && merges.length > 0) {
      ws["!merges"] = merges.map((m) => ({
        s: { r: m.startRow, c: m.startColumn },
        e: { r: m.endRow, c: m.endColumn },
      }));
    }
    const rowCount = Math.max(sheet?.rowCount ?? 1, 1);
    const columnCount = Math.max(sheet?.columnCount ?? 1, 1);
    ws["!ref"] = utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rowCount - 1, c: columnCount - 1 } });
    utils.book_append_sheet(wb, ws as XLSX.WorkSheet, sheet?.name ?? "Sheet1");
  }
  return wb;
}

export function XlsxViewer({ filePath, sourceSessionId, binaryUrl, refreshKey = 0, worktreeId, onWorktreeCreated, flushRef, ownSaveRef, scopeKey, children, headerExtra, onAiEdit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const univerRef = useRef<{ dispose: () => void } | null>(null);
  const apiRef = useRef<UniverApiLike | null>(null);
  const xlsxUtilsRef = useRef<typeof XLSX.utils | null>(null);
  // Original cell data as loaded — baseline for the online-edit diff.
  const originalDataRef = useRef<NormMap | null>(null);
  // Trunk auto-save bookkeeping.
  const inFlightSaveRef = useRef(false);
  const lastSaveRef = useRef(0);
  const autoWorktreeRef = useRef<string | null>(null);
  const lastFailedAtRef = useRef(0);
  const xlsxWriteRef = useRef<((wb: XLSX.WorkBook, opts: Record<string, unknown>) => unknown) | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  // "AI 编辑" button state (plain .xlsx sources only).
  const [aiEditBusy, setAiEditBusy] = useState(false);
  const [aiEditError, setAiEditError] = useState("");
  // In-place sync indicator: shown while external data is applied to the live
  // grid (the grid stays interactive — no full reload).
  const [syncing, setSyncing] = useState(false);
  // The Univer instance persists across scope switches within the same file;
  // only recreated when filePath changes or a structural diff forces it.
  const instanceReadyRef = useRef(false);
  const filePathRef = useRef(filePath);
  const lastAppliedRef = useRef<ScopeData | null>(null);
  const lastRefreshKeyRef = useRef(refreshKey);
  const { t } = useI18n();

  /** Tear down the Univer instance (file switch / structural recreate / unmount). */
  const disposeInstance = (): void => {
    try { univerRef.current?.dispose(); } catch { /* ignore */ }
    univerRef.current = null;
    apiRef.current = null;
    xlsxUtilsRef.current = null;
    xlsxWriteRef.current = null;
    instanceReadyRef.current = false;
    lastAppliedRef.current = null;
  };

  /** Create the Univer instance + unit for a scope. The parsed data is deep-
   *  cloned because Univer's createUnit reuses the passed-in cellData objects
   *  in place — mutating the cached scope data would corrupt later diffs. */
  const createInstance = async (target: ScopeData): Promise<void> => {
    const [presets, corePreset, cfPreset, dvPreset, filterPreset, frPreset, sortPreset, tablePreset, hlPreset, notePreset, tcPreset, xlsx, zhCN, cfZhCN, dvZhCN, filterZhCN, frZhCN, sortZhCN, tableZhCN, hlZhCN, noteZhCN, tcZhCN] = await Promise.all([
      import("@univerjs/presets"),
      import("@univerjs/preset-sheets-core"),
      import("@univerjs/preset-sheets-conditional-formatting"),
      import("@univerjs/preset-sheets-data-validation"),
      import("@univerjs/preset-sheets-filter"),
      import("@univerjs/preset-sheets-find-replace"),
      import("@univerjs/preset-sheets-sort"),
      import("@univerjs/preset-sheets-table"),
      import("@univerjs/preset-sheets-hyper-link"),
      import("@univerjs/preset-sheets-note"),
      import("@univerjs/preset-sheets-thread-comment"),
      import("xlsx"),
      import("@univerjs/preset-sheets-core/locales/zh-CN"),
      import("@univerjs/preset-sheets-conditional-formatting/locales/zh-CN"),
      import("@univerjs/preset-sheets-data-validation/locales/zh-CN"),
      import("@univerjs/preset-sheets-filter/locales/zh-CN"),
      import("@univerjs/preset-sheets-find-replace/locales/zh-CN"),
      import("@univerjs/preset-sheets-sort/locales/zh-CN"),
      import("@univerjs/preset-sheets-table/locales/zh-CN"),
      import("@univerjs/preset-sheets-hyper-link/locales/zh-CN"),
      import("@univerjs/preset-sheets-note/locales/zh-CN"),
      import("@univerjs/preset-sheets-thread-comment/locales/zh-CN"),
    ]);
    if (!containerRef.current) throw new Error("container not ready");

    // Formula worker runs recalculation off the main thread (bundled by
    // Next from ./univer-worker.ts). Locale + theme are required — the UI
    // renders a full Ribbon/status bar and throws without them.
    const worker = new Worker(new URL("./univer-worker.ts", import.meta.url), { type: "module" });
    const { univer, univerAPI } = presets.createUniver({
      locale: presets.LocaleType.ZH_CN,
      locales: {
        zhCN: {
          ...zhCN.default, ...cfZhCN.default, ...dvZhCN.default, ...filterZhCN.default,
          ...frZhCN.default, ...sortZhCN.default, ...tableZhCN.default, ...hlZhCN.default,
          ...noteZhCN.default, ...tcZhCN.default,
          // esm 版 core zh-CN locale 是旧子集，缺 sheets-numfmt-ui.info 键
          // （“以文本形式存储的数字”绿色三角提示）——这里补齐。
          "sheets-numfmt-ui": {
            ...(zhCN.default["sheets-numfmt-ui"] ?? {}),
            info: { error: "错误", forceStringInfo: "以文本形式存储的数字" },
          },
        },
      },
      theme: presets.defaultTheme,
      presets: [
        corePreset.UniverSheetsCorePreset({ container: containerRef.current, workerURL: worker }),
        // Conditional formatting: toolbar 数据 → 条件格式 entry + rendering.
        cfPreset.UniverSheetsConditionalFormattingPreset(),
        // Data validation (数据验证), filter (筛选), find/replace (查找),
        // sort (排序), table (表格), hyperlink (超链接), note (批注),
        // thread comment (评论) — all open-source presets.
        dvPreset.UniverSheetsDataValidationPreset(),
        filterPreset.UniverSheetsFilterPreset(),
        frPreset.UniverSheetsFindReplacePreset(),
        sortPreset.UniverSheetsSortPreset(),
        tablePreset.UniverSheetsTablePreset(),
        hlPreset.UniverSheetsHyperLinkPreset(),
        notePreset.UniverSheetsNotePreset(),
        tcPreset.UniverSheetsThreadCommentPreset(),
      ],
    });
    univerRef.current = univer;
    apiRef.current = univerAPI as UniverApiLike;
    xlsxUtilsRef.current = xlsx.utils;
    xlsxWriteRef.current = xlsx.write;
    univer.createUnit(presets.UniverInstanceType.UNIVER_SHEET, structuredClone(target.data) as unknown as Record<string, unknown>);
    // Univer defaults to read-only; enable in-viewer editing so the user can
    // interact freely. For .xlsx sources edits save back through
    // /api/files/save; for .univer (CLI) sources the toolbar shows export
    // instead, and agent edits flow through `univer execute`.
    try { univerAPI.getActiveWorkbook()?.setEditable(true); } catch { /* ignore */ }
    // Debug hook for headless/CDP verification of the online-edit pipeline.
    try { (window as unknown as Record<string, unknown>)["__piUniver"] = univerAPI; } catch { /* ignore */ }
    instanceReadyRef.current = true;
  };

  /** Apply a parsed scope onto the live instance in place; returns "recreated"
   *  when the change is structural and the caller must rebuild the instance. */
  const applyScopeData = async (target: ScopeData): Promise<"diff" | "recreated"> => {
    const api = apiRef.current;
    const last = lastAppliedRef.current;
    if (!api || !last) return "recreated";
    const plan = diffWorkbooks(last.data, target.data);
    if (plan.recreate) return "recreated";
    const wb = api.getActiveWorkbook();
    if (!wb) return "recreated";
    const sheets = target.data.sheets ?? {};
    let unitId = "";
    for (const sheetId of plan.order) {
      const info = sheets[sheetId];
      if (!info || !info.name) return "recreated";
      const sheet = wb.getSheetByName(info.name);
      if (!sheet) return "recreated";
      if (!unitId) {
        try { unitId = sheet.getRange(0, 0, 1, 1).getUnitId(); } catch { /* keep default */ }
      }
      const changes = plan.cells[sheetId] ?? [];
      for (const ch of changes) {
        try {
          if (ch.clear) {
            sheet.getRange(ch.r, ch.c, 1, 1).setValue({ v: null, f: null, p: null, si: null, custom: null, s: null });
          } else if (ch.cell) {
            const range = sheet.getRange(ch.r, ch.c, 1, 1);
            if (ch.styleChanged) {
              // setValue deep-merges style fields — clear the style first, then
              // re-apply the target style so removed fields don't linger.
              range.setValue({ ...ch.cell, s: null });
              if (ch.style) range.setValue({ s: ch.style });
            } else {
              range.setValue(ch.cell);
            }
          }
        } catch (error) {
          console.warn("[XlsxViewer] applying cell failed", ch, error);
        }
      }
      for (const m of plan.removedMerges[sheetId] ?? []) {
        try {
          await api.executeCommand?.("sheet.command.remove-worksheet-merge", {
            unitId: unitId || "xlsx-viewer",
            subUnitId: sheetId,
            ranges: [m],
          });
        } catch (error) {
          console.warn("[XlsxViewer] removing merge failed", m, error);
        }
      }
      for (const m of plan.addedMerges[sheetId] ?? []) {
        try {
          sheet.getRange(m.startRow, m.startColumn, m.endRow - m.startRow + 1, m.endColumn - m.startColumn + 1).merge();
        } catch (error) {
          console.warn("[XlsxViewer] adding merge failed", m, error);
        }
      }
    }
    return "diff";
  };

  const getSnapshotWorkbook = async (): Promise<{ wb: XLSX.WorkBook; fileName: string } | null> => {
    const api = apiRef.current;
    const utils = xlsxUtilsRef.current;
    if (!api || !utils) return null;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return null;
    const snapshot = workbook.save();
    const wb = univerToXlsx(snapshot, utils);
    const fileName = filePath.split(/[\\/]/).pop() || "sheet.xlsx";
    return { wb, fileName };
  };

  const handleSave = async (): Promise<void> => {
    const current = await getSnapshotWorkbook();
    if (!current) return;
    setSaving(true);
    setSavedMsg("");
    try {
      const { wb, fileName } = current;
      const writeFn = xlsxWriteRef.current;
      if (!writeFn) return;
      const bin = writeFn(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
      const response = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, base64: bytesToBase64(bin) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setSavedMsg(t("files.savedSpreadsheet", { name: fileName, time: new Date().toLocaleTimeString() }));
    } catch (error) {
      setSavedMsg(t("files.saveSpreadsheetFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };

  const commitChanges = useCallback(async (changes: WorktreeEditChange[]): Promise<number | null> => {
    if (changes.length === 0) return null;
    // Worktree-only editing (user rule 2026-08-08): editing on the trunk scope
    // auto-creates a draft worktree and switches the viewer into it, so no
    // request ever writes into trunk. Reuse the same auto-created worktree for
    // subsequent saves within this session.
    let wt = worktreeId ?? autoWorktreeRef.current;
    if (!wt) {
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false }).replace(/:/g, "-");
      const res = await fetch("/api/univer/worktree-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, name: `编辑-${stamp}` }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; worktree?: { id?: string }; error?: string } | null;
      if (!res.ok || !data?.ok || !data.worktree?.id) {
        throw new Error(data?.error || t("files.univerWorktreeCreateFailed"));
      }
      wt = data.worktree.id;
      autoWorktreeRef.current = wt;
      onWorktreeCreated?.(wt);
      setSavedMsg(t("files.univerAutoEnterWorktree"));
    }
    const response = await fetch("/api/univer/edit-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filePath, worktree: wt, changes }),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; seq?: number; error?: string } | null;
    if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    setSavedMsg(t("files.univerSaveEditDone", { seq: data.seq ?? "" }));
    // The outer poll uses this signature to update badges without re-syncing
    // the viewer mid-edit (worktree → the new headCommit seq).
    if (ownSaveRef) ownSaveRef.current = data.seq ?? null;
    return data.seq ?? null;
  }, [filePath, worktreeId, t, ownSaveRef, onWorktreeCreated]);

  // Auto-save: commits pending cell diffs to the selected scope — the worktree
  // (if one is selected) or trunk via the server's hidden staging worktree —
  // then rebases the local baseline so the next diff starts clean.
  const flushPending = useCallback(async (): Promise<void> => {
    if (!binaryUrl || inFlightSaveRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return;
    const current = normalizeCellMap(workbook.save());
    const changes = diffWorktreeCells(originalDataRef.current, current);
    if (changes.length === 0) return;
    inFlightSaveRef.current = true;
    setSaving(true);
    try {
      await commitChanges(changes);
      if (current) originalDataRef.current = current;
      lastSaveRef.current = Date.now();
    } catch (error) {
      lastFailedAtRef.current = Date.now();
      setSavedMsg(t("files.saveSpreadsheetFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      inFlightSaveRef.current = false;
      setSaving(false);
    }
  }, [binaryUrl, t, commitChanges]);

  // Poll for pending edits and auto-save them (idle-ish debounce + backoff
  // after failures). Runs for both trunk and worktree scopes.
  useEffect(() => {
    if (!binaryUrl) return;
    const timer = setInterval(() => {
      if (inFlightSaveRef.current) return;
      if (Date.now() - lastFailedAtRef.current < 10_000) return; // backoff after failure
      if (Date.now() - lastSaveRef.current < 2_000) return; // min interval between saves
      void flushPending();
    }, 1_000);
    return () => clearInterval(timer);
  }, [binaryUrl, flushPending]);

  // Expose an imperative flush so the outer bar can persist pending edits
  // before 写回原件 / exports read trunk.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flushPending;
    return () => { flushRef.current = null; };
  }, [flushPending, flushRef]);

  // Load the current scope (cache-backed) and apply it to the live grid.
  // - First load for a file: create the Univer instance.
  // - Scope switch (branch) / external commit (agent edit): diff-apply in
  //   place so the grid updates without a full reload; fall back to a full
  //   recreate only for structural changes.
  useEffect(() => {
    let cancelled = false;

    // A different file opened in the same tab: reset the whole instance.
    if (filePathRef.current !== filePath) {
      disposeInstance();
      filePathRef.current = filePath;
    }
    if (!instanceReadyRef.current) {
      setStatus("loading");
    } else {
      setSyncing(true);
    }
    setErrorMsg("");

    (async () => {
      try {
        const url = binaryUrl ?? getDownloadUrl(filePath, sourceSessionId);
        const key = scopeKey ?? `plain::${filePath}::${refreshKey}`;
        const force = !scopeKey || refreshKey !== lastRefreshKeyRef.current;
        const target = await loadScopeData(key, url, force);
        if (cancelled) return;

        // Commit any pending in-viewer edits to their scope before applying
        // external data, so user changes are never clobbered by a sync.
        if (instanceReadyRef.current) await flushPending();
        if (cancelled) return;

        if (!instanceReadyRef.current) {
          await createInstance(target);
        } else if (await applyScopeData(target) === "recreated") {
          disposeInstance();
          await createInstance(target);
        }
        if (cancelled) return;

        lastAppliedRef.current = target;
        lastRefreshKeyRef.current = refreshKey;
        originalDataRef.current = target.data.sheets ? structuredClone(normalizeCellMap(target.data)) : null;
        setStatus("ready");
        setSyncing(false);
      } catch (error) {
        console.error("[XlsxViewer]", error);
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(error instanceof Error ? error.message : String(error));
          setSyncing(false);
        }
      }
    })();

    return () => { cancelled = true; };
    // createInstance/disposeInstance/applyScopeData/flushPending are stable
    // per (filePath, binaryUrl, worktreeId) — all already covered by deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sourceSessionId, binaryUrl, refreshKey, scopeKey]);

  // Full teardown on unmount (instance persists across scope switches).
  useEffect(() => () => { disposeInstance(); }, []);

  const handleExport = (bookType: "xlsx" | "csv"): void => {
    void (async () => {
      const current = await getSnapshotWorkbook();
      if (!current) return;
      const { wb, fileName } = current;
      const base = fileName.replace(/\.(xlsx|xls|csv)$/i, "");
      const writeFn = xlsxWriteRef.current;
      if (!writeFn) return;
      const bin = writeFn(wb, { type: "array", bookType }) as Uint8Array;
      triggerDownload(bin, `${base}.${bookType}`, bookType === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    })();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" }}>
      {status === "ready" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
              background: "var(--bg-panel)",
              flexShrink: 0,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>
              {filePath.split(/[\\/]/).pop()}
            </span>
            <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{savedMsg}</span>
            {aiEditError && (
              <span style={{ color: "#f87171", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
                {aiEditError}
              </span>
            )}
            <span style={{ marginLeft: "auto" }} />
            {onAiEdit && !binaryUrl && (
              <button
                type="button"
                onClick={() => {
                  setAiEditError("");
                  setAiEditBusy(true);
                  Promise.resolve(onAiEdit(filePath))
                    .catch((error) => setAiEditError(error instanceof Error ? error.message : String(error)))
                    .finally(() => setAiEditBusy(false));
                }}
                disabled={aiEditBusy}
                title={t("files.aiEditTitle")}
                style={{ ...toolbarButtonStyle, color: aiEditBusy ? "var(--text-dim)" : "var(--accent)", fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}
              >
                {aiEditBusy ? (
                  <span
                    style={{ width: 11, height: 11, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite", display: "inline-block" }}
                  />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                )}
                {aiEditBusy ? t("files.aiEditBusy") : t("files.aiEdit")}
              </button>
            )}
            {headerExtra}
            <button type="button" onClick={() => handleExport("csv")} style={toolbarButtonStyle}>
              {t("files.exportCsv")}
            </button>
            <button type="button" onClick={() => handleExport("xlsx")} style={toolbarButtonStyle}>
              {t("files.exportXlsx")}
            </button>
            {!binaryUrl && (
              <button type="button" onClick={handleSave} disabled={saving} style={{ ...toolbarButtonStyle, color: "var(--accent)", fontWeight: 600 }}>
                {saving ? t("files.saving") : t("files.saveSpreadsheet")}
              </button>
            )}
          </div>
          {children && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 10px",
                borderBottom: "1px solid var(--border)",
                fontSize: 12,
                background: "var(--bg-panel)",
                flexShrink: 0,
              }}
            >
              {children}
            </div>
          )}
        </>
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {syncing && status === "ready" && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              zIndex: 10,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "2px 10px",
              fontSize: 11,
              color: "var(--text-muted)",
              pointerEvents: "none",
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
            }}
          >
            {t("files.univerSyncing")}
          </div>
        )}
        {status !== "ready" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: status === "error" ? "#f87171" : "var(--text-muted)",
              fontSize: 13,
              padding: 20,
              textAlign: "center",
              background: "var(--bg-panel)",
              pointerEvents: "none",
            }}
          >
            {status === "error" ? t("files.xlsxLoadFailed", { error: errorMsg }) : t("i18n.loading")}
          </div>
        )}
      </div>
    </div>
  );
}
