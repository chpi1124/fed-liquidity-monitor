import fs from "node:fs";
import path from "node:path";
import { SUMMARIES_DIR } from "./paths.js";
import { getSeries } from "./cache.js";
import { loadIndicators, zoneOf } from "./indicators.js";
import { thresholdsFor } from "./integrity.js";
import * as store from "./store.js";

export function loadSummaries(region) {
  if (!fs.existsSync(SUMMARIES_DIR)) return [];
  let list = fs
    .readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SUMMARIES_DIR, f), "utf8")));
  if (region) list = list.filter((c) => (c.region || "us") === region);
  return list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const round = (v, p) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);
const worstOk = (oks) => {
  if (!oks.length) return null;
  if (oks.some((o) => o === false)) return false;
  if (oks.some((o) => o == null)) return null;
  return true;
};
function aggregate(entries, agg) {
  const vals = entries.map((e) => e.v).filter((v) => v != null);
  if (!vals.length) return null;
  if (agg === "max") return Math.max(...vals);
  if (agg === "min") return Math.min(...vals);
  if (agg === "sum") return vals.reduce((a, b) => a + b, 0);
  if (agg === "mean") return vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals[vals.length - 1];
}

export async function updateSummary(cfg, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const anchor = cfg.anchor || "h41";
  let board = null;
  let asOf;
  if (anchor === "h41") {
    board = await getSeries({ provider: "frb-h41" }, "2002-12-18", today, force);
    asOf = board.date;
  } else {
    asOf = today;
  }
  const thisWeek = { start: addDays(asOf, -6), end: asOf };
  const lastWeek = { start: addDays(asOf, -13), end: addDays(asOf, -7) };
  const fetchStart = lastWeek.start;
  const fetchEnd = today;
  const tolDefault = cfg.tolerance ?? 1;
  const indicators = loadIndicators();

  let checked = 0, matched = 0, mismatched = 0;
  const tally = (bv, fv, tol) => {
    if (bv == null || fv == null) return null;
    checked++;
    if (Math.abs(bv - fv) <= tol) { matched++; return true; }
    mismatched++;
    return false;
  };

  const factorsCache = { m: null };
  const getFactors = async () => {
    if (!factorsCache.m) factorsCache.m = await getSeries({ provider: "frb-h41-factors" }, fetchStart, fetchEnd, force);
    return factorsCache.m;
  };
  const fredCache = new Map();
  const getFred = async (series) => {
    const key = JSON.stringify(series);
    if (!fredCache.has(key)) fredCache.set(key, await getSeries({ provider: "fred", series }, fetchStart, fetchEnd, force));
    return fredCache.get(key);
  };

  const rows = [];
  for (const row of cfg.rows) {
    const scale = row.scale ?? 1;
    const precision = row.precision ?? 2;
    const tol = row.tolerance ?? tolDefault;
    const base = {
      id: row.id, zh: row.zh, en: row.en ?? "", unit: row.unit ?? "", precision, scale,
      op: row.agg ?? "level", note: row.note ?? "", sourceLabel: row.sourceLabel ?? "",
      checkLabel: row.checkLabel ?? "", highlight: !!row.highlight, evidence: row.evidence ?? null,
      thisWeek: null, lastWeek: null, delta: null, ok: null, zone: null, status: "ok",
      official: null, extra: null,
    };
    const zones = row.zones ?? indicators.find((c) => c.id === row.indicator)?.zones ?? null;
    const finish = (thisRaw, lastRaw, ok) => {
      base.thisWeek = round(thisRaw == null ? null : thisRaw * scale, precision);
      base.lastWeek = round(lastRaw == null ? null : lastRaw * scale, precision);
      base.delta = thisRaw == null || lastRaw == null ? null : round((thisRaw - lastRaw) * scale, precision);
      base.ok = ok;
      base.zone = zoneOf(zones, base.thisWeek);
      rows.push(base);
    };

    if (row.kind === "store") {
      const d = store.read(row.indicator);
      if (!d) throw new Error(`summary store row ${row.id}: indicator ${row.indicator} not ready`);
      const win = (w) => d.points.filter((p) => p.d >= w.start && p.d <= w.end && p.v != null);
      const te = win(thisWeek), le = win(lastWeek);
      finish(aggregate(te, row.agg), aggregate(le, row.agg), worstOk(te.map((p) => p.ok)));
      base.sourceLabel = row.sourceLabel ?? `${row.indicator} 已校验存储`;
      // 行级不再自称「唯一官方发布方」：底层指标若已带校验腿，就继承它真实的校验机制与结果，
      // 汇总表与指标页对同一数字只能有一个结论（SSOT）。
      const src = indicators.find((c) => c.id === row.indicator);
      if (d.validation?.checked) {
        checked += d.validation.checked;
        matched += d.validation.matched;
        mismatched += d.validation.mismatched;
        base.checkLabel = `${src?.checkKind || "底层指标逐点校验"} ${d.validation.matched}/${d.validation.checked}${d.validation.corrected ? ` · 已改值 ${d.validation.corrected}` : ""}`;
        base.verdict = d.integrity?.verdict ?? null;
      }
      if (row.aggExtra === "min") base.extra = { min: round(aggregate(te, "min") * scale, precision), minLast: round(aggregate(le, "min") * scale, precision) };
      continue;
    }

    if (row.kind === "series") {
      let primary;
      try {
        primary = await getSeries(row.primary, fetchStart, fetchEnd, force);
      } catch (e) {
        base.status = "no-source";
        base.note = row.noSourceNote || `${row.note}（缺源：${e.message}）`;
        rows.push(base);
        continue;
      }
      const checkSrc = row.check ? (typeof row.check === "string" ? { provider: "fred", series: row.check } : row.check) : null;
      let check = null;
      if (checkSrc) {
        try { check = await getSeries(checkSrc, fetchStart, fetchEnd, force); }
        catch { base.status = "single-source"; }
      }
      const offset = row.check?.offset ?? 0;
      const structured = [...primary.values()].some((e) => e && typeof e === "object");
      const entriesFor = (w) => {
        const out = [];
        for (const [d, e] of primary) {
          if (d < w.start || d > w.end) continue;
          const v = e == null ? null : typeof e === "object" ? e.v : e;
          if (v == null) continue;
          let ok = null;
          if (check) {
            if (structured) {
              const settles = [...(e.settle ?? [])];
              if (!settles.length) ok = null;
              else {
                const rs = settles.map(([sd, amt]) => tally(amt, check.get(sd) == null ? null : check.get(sd) + offset, tol));
                ok = worstOk(rs);
              }
            } else {
              const c0 = check.get(d);
              ok = tally(v, c0 == null ? null : c0 + offset, tol);
            }
          }
          out.push({ d, v, ok });
        }
        return out.sort((a, b) => (a.d < b.d ? -1 : 1));
      };
      const te = entriesFor(thisWeek), le = entriesFor(lastWeek);
      finish(aggregate(te, row.agg), aggregate(le, row.agg), worstOk(te.map((e) => e.ok)));
      if (row.proxy) base.status = "single-source";
      if (row.aggExtra === "min") base.extra = { min: round(aggregate(te, "min") * scale, precision), minLast: round(aggregate(le, "min") * scale, precision) };
      continue;
    }

    if (row.kind === "board") {
      const r = board.rows.get(row.board);
      if (!r) throw new Error(`summary board row ${row.id}: H.4.1 row not found ${row.board}`);
      const cm = await getFred(row.check);
      const thisRaw = r.v, lastRaw = r.wc == null ? null : r.v - r.wc;
      const ok = worstOk([tally(thisRaw, cm.get(asOf), tol), tally(lastRaw, cm.get(board.prevDate), tol)]);
      finish(thisRaw, lastRaw, ok);
      continue;
    }

    if (row.kind === "factors") {
      const factors = await getFactors();
      const r = factors.rows.get(row.factors);
      if (!r) throw new Error(`summary factors row ${row.id}: H.4.1 factors row not found ${row.factors}`);
      const cm = await getFred(row.check);
      const thisRaw = r.avg, lastRaw = r.wc == null ? null : r.avg - r.wc;
      const ok = worstOk([tally(thisRaw, cm.get(factors.date), tol), tally(lastRaw, cm.get(factors.prevDate), tol)]);
      finish(thisRaw, lastRaw, ok);
      continue;
    }

    if (row.kind === "factsheet") {
      const m = await getSeries(row.primary, fetchStart, fetchEnd, force);
      const entries = [...m.entries()];
      if (!entries.length) throw new Error(`summary factsheet row ${row.id}: no data`);
      const [fa, level] = entries[entries.length - 1];
      base.official = { asOf: fa, level: round(level * scale, precision) };
      base.status = "monthly-only";
      base.zone = zoneOf(zones, base.official.level);
      rows.push(base);
      continue;
    }

    if (row.kind === "static") {
      base.status = row.pending ? "pending-source" : "no-source";
      base.note = row.noSourceNote || row.note || "";
      rows.push(base);
      continue;
    }

    throw new Error(`summary row ${row.id}: unknown kind ${row.kind}`);
  }

  // 行级不变量：直接取数的行（series/board/factors/factsheet）不经过指标管线，这里用与指标
  // 完全同一把尺子（thresholdsFor）复核区间与单期跳变，使汇总页不出现「未经自检的数字」。
  // 只对利率型行（%、bp）套用阈值——其区间与跳变上限由十年实测分布定标；金额型行（百万/十亿美元）
  // 的合理量级取决于单位与政府收支节奏，未经逐行定标就套用通用带只会制造误报，故这类行的正确性
  // 由其双源逐点比对（H.4.1 ↔ FRED）负责，本处标记为「未设阈值」而非判 ok。
  // 存疑只标记并说明，不删行、不改值。
  const rowChecks = [];
  let unthresholded = 0;
  for (const r of rows) {
    const u = (r.unit || "").trim();
    if (r.verdict) continue;
    if (u !== "%" && u !== "bp") {
      if (r.thisWeek != null) unthresholded++;
      continue;
    }
    const th = thresholdsFor({ unit: r.unit, publication: cfg.publication || "W", freq: "week" });
    const v = r.thisWeek;
    if (v == null || r.verdict) continue;
    const codes = [];
    if (th.range && (v < th.range[0] || v > th.range[1])) codes.push(`超出合理区间 ${th.range[0]} ~ ${th.range[1]}${r.unit}`);
    if (r.lastWeek != null && th.maxAbsJump != null && Math.abs(v - r.lastWeek) > th.maxAbsJump)
      codes.push(`单周变动 ${(v - r.lastWeek).toFixed(2)} 超过上限 ${th.maxAbsJump}`);
    r.verdict = codes.length ? "fail" : "ok";
    if (codes.length) rowChecks.push({ id: r.id, zh: r.zh, codes });
  }
  const integrity = {
    verdict: rowChecks.length ? "fail" : rows.some((r) => r.verdict === "fail") ? "fail" : "ok",
    rows: rows.length,
    selfChecked: rows.filter((r) => r.verdict).length,
    unthresholded,
    bad: rowChecks,
  };

  return {
    updatedAt: new Date().toISOString(),
    name: cfg.name,
    columns: cfg.columns,
    asOf,
    thisWeek,
    lastWeek,
    rows,
    validation: { checked, matched, mismatched },
    integrity,
  };
}