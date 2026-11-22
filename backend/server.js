import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { FRONTEND_DIR } from "./lib/paths.js";
import { loadIndicators, updateIndicator } from "./lib/indicators.js";
import { loadSheets, updateSheet } from "./lib/sheets.js";
import { loadSummaries, updateSummary } from "./lib/summaries.js";
import * as store from "./lib/store.js";
import { aggregate } from "./lib/aggregate.js";
import { startScheduler } from "./lib/scheduler.js";

const PORT = Number(process.env.PORT || 3000);
let updating = false;

async function updateAll(force = false) {
  if (updating) return "";
  updating = true;
  let minLatest = "";
  try {
    const pending = loadIndicators();
    const rerun = [];
    for (const cfg of pending) {
      try {
        let data = await updateIndicator(cfg, { force, prev: store.read(cfg.id) });
        // 自愈一：参照序列本轮还没入库（冷启动依赖顺序）⇒ 补跑一次，不静默降级。
        if (data.validation.checkErrors.some((e) => /尚未入库|无重叠日期/.test(e))) {
          rerun.push(cfg);
        }
        // 自愈二：自检 fail ⇒ 绕过缓存向官方源重取一次，区分「源端真异常」与「缓存/半途响应」。
        if (data.integrity.verdict === "fail") {
          console.log(`[update] ${cfg.id}: 自检 fail，绕过缓存重取一次`);
          const retry = await updateIndicator(cfg, { force: true, prev: store.read(cfg.id) });
          if (retry.integrity.counts.range + retry.integrity.counts.jump + retry.integrity.counts.mismatch <=
              data.integrity.counts.range + data.integrity.counts.jump + data.integrity.counts.mismatch) data = retry;
        }
        store.write(cfg.id, data);
        const ld = data.points[data.points.length - 1]?.d ?? "";
        if ((cfg.region || "us") === "us" && ld && (!minLatest || ld < minLatest)) minLatest = ld;
        const ic = data.integrity;
        const v = data.validation;
        const bad = ic.counts.range + ic.counts.jump + ic.counts.cross + ic.counts.mismatch;
        console.log(
          `[update] ${cfg.id}: ${data.points.length} days, 交叉验证 ${v.matched}/${v.checked}${v.corrected ? ` 改值${v.corrected}` : ""}${v.mismatched ? ` 不符${v.mismatched}` : ""}${v.checkErrors.length ? ` 校验腿故障${v.checkErrors.length}` : ""}, 自检 ${ic.verdict}${bad ? ` 存疑${bad}` : ""}${ic.counts.stale ? ` 滞后${ic.counts.stale}` : ""}${ic.counts.revised ? ` 修订${ic.counts.revised}` : ""}${ic.counts.coverage ? ` 覆盖${ic.counts.coverage}` : ""}`
        );
      } catch (e) {
        console.error(`[update] ${cfg.id} failed:`, e.message);
      }
    }
    // 依赖补跑：恒等式/带宽校验腿读取的是同批其他指标的入库结果，冷启动时第二轮才能对上。
    for (const cfg of rerun) {
      try {
        const data = await updateIndicator(cfg, { force, prev: store.read(cfg.id) });
        if (!data.validation.checkErrors.length) store.write(cfg.id, data);
        const v = data.validation;
        console.log(`[update] ${cfg.id} 依赖补跑: 交叉验证 ${v.matched}/${v.checked}, 自检 ${data.integrity.verdict}${v.checkErrors.length ? ` 仍有校验腿故障: ${v.checkErrors.join("; ")}` : ""}`);
      } catch (e) {
        console.error(`[update] ${cfg.id} 依赖补跑 failed:`, e.message);
      }
    }
    for (const cfg of loadSheets()) {
      try {
        const data = await updateSheet(cfg, { force });
        store.write(`sheet-${cfg.id}`, data);
        console.log(`[sheet] ${cfg.id}: asOf ${data.asOf}, ${data.history.length} weeks, validation ${data.validation.matched}/${data.validation.checked}`);
      } catch (e) {
        console.error(`[sheet] ${cfg.id} failed:`, e.message);
      }
    }
    for (const cfg of loadSummaries()) {
      try {
        const data = await updateSummary(cfg, { force });
        store.write(`summary-${cfg.id}`, data);
        console.log(`[summary] ${cfg.id}: asOf ${data.asOf}, ${data.rows.length} rows, validation ${data.validation.matched}/${data.validation.checked}`);
      } catch (e) {
        console.error(`[summary] ${cfg.id} failed:`, e.message);
      }
    }
  } finally {
    updating = false;
  }
  return minLatest;
}

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
    if (p === "/api/indicators" && req.method === "GET") {
      return json(res, 200, loadIndicators(region).map((cfg) => ({ ...cfg, status: summary(cfg) })));
    }
    const m = p.match(/^\/api\/indicators\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const cfg = loadIndicators().find((c) => c.id === m[1]);
      if (!cfg) return json(res, 404, { error: "unknown indicator" });
      const d = store.read(cfg.id);
      if (!d) return json(res, 503, { error: "data not ready, retry shortly" });
      const gParam = u.searchParams.get("granularity");
      const g = ["day", "week", "month"].includes(gParam) ? gParam : "day";
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
      await updateAll(true);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/status" && req.method === "GET") {
      return json(res, 200, { updating, indicators: loadIndicators().map((c) => ({ id: c.id, status: summary(c) })) });
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