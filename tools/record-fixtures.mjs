// provider 留档器：给 backend/providers/ 每个官方源录一份「窄窗真实响应 + 解析结果」。
// 用法：node tools/record-fixtures.mjs [providerId ...]
// 原则：只录真实响应，不合成不美化；取不到就如实记 FAIL（G17 会把它算缺留档，除非已在降级/拒绝清单登记）。
// 窗口按源的发布节奏选：近 12 天 / 近 4 个月 / 有会议的月份 / Comtrade 预览滞后的更早区间。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures");
fs.mkdirSync(OUT, { recursive: true });

const { list } = await import(pathToFileURL(path.join(ROOT, "backend/providers/registry.js")).href);
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const want = list().filter((p) => !only.length || only.includes(p.id));

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);

// 每源：src 参数 + 取数窗口（都用真实指标配置里的字段，不自造参数）
const PLAN = {
  "frb-h41": { src: {}, win: [day(10), TODAY] },
  "frb-h41-factors": { src: {}, win: [day(10), TODAY] },
  "cfets-shibor": { src: { tenor: "ON" }, win: [day(10), TODAY] },
  "cfets-rmb": { src: { pair: "USD/CNY" }, win: [day(10), TODAY] },
  "cfets-lpr": { src: { tenor: "1Y" }, win: [day(10), TODAY] },
  "cfets-repo": { src: { tenor: "FDR007" }, win: [day(10), TODAY] },
  nyfed: { src: { series: "sofr" }, win: [day(10), TODAY] },
  "nyfed-repo": { src: { series: "srf" }, win: [day(30), TODAY] },
  "nyfed-rp-rate": { src: { series: "srf" }, win: [day(30), TODAY] },
  fred: { src: { series: "WALCL" }, win: [day(40), TODAY] },
  "treasury-real": { src: { tenor: "10 YR" }, win: [day(40), TODAY] },
  nasdaq: { src: { symbol: "GLD" }, win: [day(12), TODAY] },
  thetrading: { src: { file: "move-index", valueCol: "move_value" }, win: [day(12), TODAY] },
  "uk-trade": { src: { measure: "net" }, win: [day(120), day(60)] },
  worldbank: { src: { column: "Gold" }, win: [day(120), day(60)] },
  uncomtrade: { src: { maxMonths: 1, paceMs: 0 }, win: [day(450), day(300)] },
  "fed-policy": { src: {}, win: ["2024-09-01", "2024-09-30"] },
  "pbc-statement": { src: { item: "总资产", fmt: "htm" }, win: ["2026-01-01", TODAY] },
};

// 样本一律取「最近」若干条：取最老的 40 条会让留档日期与入库序列尾部永不相交，对账变成假失败
function sample(data) {
  if (data instanceof Map) return [...data.entries()].slice(-40);
  if (Array.isArray(data?.events)) return { ...data, events: data.events.slice(-20) };
  if (Array.isArray(data?.rows) && typeof data.rows !== "object") return data;
  if (data && typeof data === "object") {
    const out = { ...data };
    if (out.rows instanceof Map) out.rows = [...out.rows.entries()].slice(-40);
    return out;
  }
  return data;
}

const results = [];
for (const p of want) {
  const plan = PLAN[p.id] || { src: {}, win: [day(10), TODAY] };
  const [start, end] = plan.win;
  const t0 = Date.now();
  try {
    const data = await p.fetch(plan.src, start, end);
    const rows = data instanceof Map ? data.size : Array.isArray(data?.events) ? data.events.length : data?.rows instanceof Map ? data.rows.size : Array.isArray(data?.rows) ? data.rows.length : Object.keys(data?.rows || {}).length;
    const payload = JSON.parse(
      JSON.stringify(sample(data), (k, v) => (v instanceof Map ? [...v.entries()].slice(-40) : typeof v === "function" ? undefined : v))
    );
    const file = path.join(OUT, `${p.id}.fixture.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: p.id,
        org: p.org,
        cadence: p.cadence,
        incremental: p.incremental,
        requested: { src: plan.src, start, end },
        rows,
        bytes: JSON.stringify(payload).length,
        at: new Date().toISOString(),
        payload,
      }, null, 2) + "\n"
    );
    results.push({ id: p.id, ok: true, rows, ms: Date.now() - t0 });
    console.log(`${p.id.padEnd(18)} OK   行/键 ${String(rows).padStart(5)}  样本 ${String(JSON.stringify(payload).length).padStart(7)} 字节  ${Date.now() - t0}ms`);
  } catch (e) {
    results.push({ id: p.id, ok: false, error: String(e.message).slice(0, 200) });
    console.log(`${p.id.padEnd(18)} FAIL ${String(e.message).slice(0, 120)}`);
  }
}
// 部分录制（只跑一两个源）不得抹掉其它源的留档记录：与既有 _record 合并，本轮结果覆盖同名项。
// 早先整份覆盖过，结果单独重录一个源就让 17 个源的留档对账集体变红（G12/selftest C）。
let prev = [];
try {
  prev = JSON.parse(fs.readFileSync(path.join(OUT, "_record.json"), "utf8")).results || [];
} catch {}
const merged = [...prev.filter((r) => !results.some((n) => n.id === r.id)), ...results].sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(OUT, "_record.json"), JSON.stringify({ at: new Date().toISOString(), results: merged }, null, 2) + "\n");
const bad = results.filter((r) => !r.ok);
console.log(`\n录制 ${results.length} 个 provider，失败 ${bad.length} 个${bad.length ? "：" + bad.map((b) => b.id).join(",") : ""}`);
console.log("失败项必须在 specs/degraded-sources.json 或 rejected-sources.json 里登记原因，否则 G17 判红。");
process.exit(0);
