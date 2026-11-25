import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { FRONTEND_DIR } from "./lib/paths.js";
import { loadIndicators } from "./lib/indicators.js";
import { loadSheets } from "./lib/sheets.js";
import { loadSummaries } from "./lib/summaries.js";
import * as store from "./lib/store.js";
import { buildPage, loadCharts, loadPresets, loadRegions, pagesOf, normalizeGranularity } from "./lib/panels.js";
import { aggregate } from "./lib/aggregate.js";
import { isUpdating, updateAll } from "./lib/pipeline.js";
import { startScheduler } from "./lib/scheduler.js";

const PORT = Number(process.env.PORT || 3000);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

function summary(cfg) {
  const d = store.read(cfg.id);
  if (!d || !d.points.length) return { ready: false };
  return {
    ready: true,
    updatedAt: d.updatedAt,
    latest: d.points[d.points.length - 1],
    tail: d.points.slice(-30).map((p) => ({ d: p.d, v: p.v })),
    validation: d.validation,
    integrity: d.integrity
      ? {
          verdict: d.integrity.verdict,
          counts: d.integrity.counts,
          notes: d.integrity.notes,
          flagged: d.integrity.flagged.slice(0, 6),
        }
      : null,
  };
}

function sheetSummary(cfg) {
  const d = store.read(`sheet-${cfg.id}`);
  if (!d || !d.history?.length) return { ready: false };
  return { ready: true, updatedAt: d.updatedAt, asOf: d.asOf, total: d.total, totalWc: d.totalWc, validation: d.validation };
}

function summarySummary(cfg) {
  const d = store.read(`summary-${cfg.id}`);
  if (!d || !d.rows?.length) return { ready: false };
  return {
    ready: true,
    updatedAt: d.updatedAt,
    asOf: d.asOf,
    rowCount: d.rows.length,
    validation: d.validation,
    integrity: d.integrity ? { verdict: d.integrity.verdict, rows: d.integrity.rows, selfChecked: d.integrity.selfChecked, bad: d.integrity.bad.length } : null,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;
  const region = u.searchParams.get("region") || "us";
  try {
    if (p === "/api/charts" && req.method === "GET") {
      return json(res, 200, { specs: loadCharts(region), presets: loadPresets(), pages: pagesOf(region), regions: loadRegions() });
    }
    const pm = p.match(/^\/api\/page\/([\w-]+)$/);
    if (pm && req.method === "GET") {
      const page = buildPage(pm[1], {
        region,
        granularity: u.searchParams.get("granularity") || "day",
        view: u.searchParams.get("view") || undefined,
        preset: u.searchParams.get("preset") || undefined,
        primary: u.searchParams.get("primary") || undefined,
        overlay: u.searchParams.get("overlay") || "",
        sheet: u.searchParams.get("sheet") || undefined,
        selected: u.searchParams.get("selected") || "",
      });
      return json(res, 200, page);
    }
    if (p === "/api/indicators" && req.method === "GET") {
      return json(res, 200, loadIndicators(region).map((cfg) => ({ ...cfg, status: summary(cfg) })));
    }
    const m = p.match(/^\/api\/indicators\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const cfg = loadIndicators().find((c) => c.id === m[1]);
      if (!cfg) return json(res, 404, { error: "unknown indicator" });
      const d = store.read(cfg.id);
      if (!d) return json(res, 503, { error: "data not ready, retry shortly" });
      const g = normalizeGranularity(u.searchParams.get("granularity"));
      let points = d.points;
      const start = u.searchParams.get("start");
      const end = u.searchParams.get("end");
      if (start) points = points.filter((x) => x.d >= start);
      if (end) points = points.filter((x) => x.d <= end);
      return json(res, 200, {
        id: cfg.id,
        granularity: g,
        updatedAt: d.updatedAt,
        validation: d.validation,
        integrity: d.integrity
          ? { verdict: d.integrity.verdict, counts: d.integrity.counts, notes: d.integrity.notes, flagged: d.integrity.flagged.slice(0, 8), thresholds: d.integrity.thresholds }
          : null,
        points: aggregate(points, g),
      });
    }
    if (p === "/api/sheets" && req.method === "GET") {
      return json(res, 200, loadSheets(region).map((cfg) => ({ ...cfg, status: sheetSummary(cfg) })));
    }
    const sm = p.match(/^\/api\/sheets\/([\w-]+)$/);
    if (sm && req.method === "GET") {
      const cfg = loadSheets().find((c) => c.id === sm[1]);
      if (!cfg) return json(res, 404, { error: "unknown sheet" });
      const d = store.read(`sheet-${cfg.id}`);
      if (!d) return json(res, 503, { error: "data not ready, retry shortly" });
      return json(res, 200, { id: cfg.id, ...d });
    }
    if (p === "/api/summaries" && req.method === "GET") {
      return json(res, 200, loadSummaries(region).map((cfg) => ({ ...cfg, status: summarySummary(cfg) })));
    }
    const sum = p.match(/^\/api\/summaries\/([\w-]+)$/);
    if (sum && req.method === "GET") {
      const cfg = loadSummaries().find((c) => c.id === sum[1]);
      if (!cfg) return json(res, 404, { error: "unknown summary" });
      const d = store.read(`summary-${cfg.id}`);
      if (!d) return json(res, 503, { error: "data not ready, retry shortly" });
      return json(res, 200, { id: cfg.id, ...d });
    }
    if (p === "/api/refresh" && req.method === "POST") {
      // 手动更新与每日调度同一条路径：走水位线增量取数。全量重建是运维动作（node tools/run-update.mjs --force），
      // 不该由一个按钮每次点击就向官方源重拉全部历史。
      await updateAll(false);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/status" && req.method === "GET") {
      return json(res, 200, { updating: isUpdating(), indicators: loadIndicators().map((c) => ({ id: c.id, status: summary(c) })) });
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });

    const file = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(FRONTEND_DIR, file));
    if (!fp.startsWith(FRONTEND_DIR)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": [".html", ".js", ".css", ".json"].includes(ext) ? "no-cache" : "public, max-age=86400",
      });
      return fs.createReadStream(fp).pipe(res);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

startScheduler(updateAll);
server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));