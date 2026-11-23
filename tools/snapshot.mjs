// 视觉回归基线：在「冻结的数据集输入」上无头跑完 panels 装配 + chart-option，把 option 固化成快照。
// 用法：
//   node tools/snapshot.mjs --bless    ⇒ 从当前库取一份输入快照，写成 snapshots/fixture.json（显式动作）
//   node tools/snapshot.mjs --write    ⇒ 用 fixture 生成/更新各组合的 option 基线
//   node tools/snapshot.mjs --check    ⇒ 用 fixture 复算并与基线比对（有差异即退出非零）
// 为什么冻结输入：官方序列每天多一个观测点，若基线绑在实时数据上，G24 会把「数据前进了」判成「渲染回归」。
// 视觉回归要盯的是代码与 spec 的改动，因此输入必须确定；换数据属于一次显式的 --bless 行为，可审计。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bless = process.argv.includes("--bless");
const write = process.argv.includes("--write");
const check = process.argv.includes("--check");

const panels = await import(pathToFileURL(path.join(ROOT, "backend/lib/panels.js")).href);
const store = await import(pathToFileURL(path.join(ROOT, "backend/lib/store.js")).href);
const policy = await import(pathToFileURL(path.join(ROOT, "backend/lib/policy.js")).href);
const theme = await import(pathToFileURL(path.join(ROOT, "frontend/js/core/theme.js")).href);
const { buildOption } = await import(pathToFileURL(path.join(ROOT, "frontend/js/core/chart-option.js")).href);

// 无头 token 源：与浏览器读同一张 tokens.css；theme.setSource 收到的是完整变量名（形如 "--line"）
const cssTokens = fs.readFileSync(path.join(ROOT, "frontend/css/tokens.css"), "utf8");
const tokens = {};
for (const m of cssTokens.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
theme.setSource((name) => tokens[name] ?? "");
theme.reset();

const FIXTURE = path.join(ROOT, "snapshots", "fixture.json");
const normalize = (v, seen = new Set()) => {
  if (typeof v === "function") return "[fn]";
  if (Array.isArray(v)) return v.map((x) => normalize(x, seen));
  if (v && typeof v === "object") {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k], seen);
    return out;
  }
  return typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v;
};

// 期望组合 = 市场 × 有 panel 视图的 spec × 粒度（与 G24 用同一份推导规则）
const regions = JSON.parse(fs.readFileSync(path.join(ROOT, "specs/regions.json"), "utf8")).map((r) => r.id);
const granularities = ["day", "week", "month"];
const expected = [];
for (const region of regions) {
  for (const spec of panels.loadCharts(region)) {
    if (!(spec.views || []).some((v) => v.projection === "panel")) continue;
    for (const granularity of granularities) expected.push({ region, page: spec.page || "monitor", specId: spec.id, granularity });
  }
}

// 录制器：bless 时记录「装配问过哪些 id、库各自答了什么」，之后据此复现同一输入
let recorded = null;
function recordingReader(id) {
  if (recorded && !(id in recorded)) recorded[id] = store.read(id);
  return recorded ? recorded[id] : store.read(id);
}
function fixtureReader(map) {
  return (id) => (id in map ? map[id] : null);
}

let fixture = null;
if (!bless) {
  if (!fs.existsSync(FIXTURE)) {
    console.log("缺 snapshots/fixture.json：先执行 node tools/snapshot.mjs --bless（把当前库输入冻结下来）");
    process.exit(1);
  }
  fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  // 政策事件也必须冻结：否则 CI 重建库后事件条数/标签变了，G24 会把数据前进误判成渲染回归。
  if (!Array.isArray(fixture.policy)) {
    console.log("fixture 缺 policy 字段：先执行 node tools/snapshot.mjs --bless（重新冻结输入）");
    process.exit(1);
  }
  policy.setSource(() => fixture.policy);
}
if (bless) {
  recorded = {};
  policy.setSource(() => dbPolicyEvents());
}
function dbPolicyEvents() {
  // 走 policy 自身的默认读库路径：先清空 override 再取，然后恢复 override
  const restore = policy.setSource(null);
  const rows = policy.chartList().map(({ label, kind, ...r }) => r);
  restore();
  return rows;
}

fs.mkdirSync(path.join(ROOT, "snapshots"), { recursive: true });
const generated = [];
const skipped = [];
let diffs = 0;

for (const e of expected) {
  const key = `${e.region}.${e.page}.${e.specId}.${e.granularity}`;
  const read = bless ? recordingReader : fixtureReader(fixture.reads);
  const payload = panels.buildPage(e.page, { region: e.region, granularity: e.granularity }, read);
  const view = (payload.views || []).find((v) => v.projection === "panel" && v.specId === e.specId);
  if (!view) {
    skipped.push({ key, reason: `spec ${e.specId} 在页面 ${e.page} 未派生出 panel 视图（该市场无对应序列）` });
    continue;
  }
  if (!view.ds?.layers?.length) {
    skipped.push({ key, reason: view.ds?.error || "无可用序列（须有明确原因，不允许静默跳过）" });
    continue;
  }
  const option = buildOption({ spec: view.spec, ds: view.ds, preset: view.ds.defaultPreset, selected: {}, theme: theme.palette() });
  const snap = {
    key,
    layers: option.series.length,
    axes: option.yAxis.length,
    grid: option.grid,
    xCount: option.xAxis.data.length,
    policyLines: (option.series[0]?.markLine?.data || []).filter((d) => d.xAxis !== undefined).length,
    window: option.dataZoom.map((d) => [d.startValue, d.endValue]),
    option: normalize(option),
  };
  const file = path.join(ROOT, "snapshots", `${key}.json`);
  generated.push(key);
  const text = JSON.stringify(snap, null, 2) + "\n";
  if (write || bless) fs.writeFileSync(file, text);
  else if (check) {
    if (!fs.existsSync(file)) {
      console.log(`缺基线 ${key}`);
      diffs++;
      continue;
    }
    if (fs.readFileSync(file, "utf8") !== text) {
      const a = JSON.parse(fs.readFileSync(file, "utf8"));
      const changed = Object.keys(snap).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(snap[k]));
      console.log(`差异 ${key}：字段 ${changed.join(", ")}`);
      diffs++;
    }
  }
}

let blessed = null;
if (bless) {
  const out = {
    blessedAt: new Date().toISOString(),
    note: "视觉回归的冻结输入：装配过程中问过的每个数据 id 及其库内返回值。换数据 = 重新 --bless（显式动作）。",
    combos: expected.length,
    reads: recorded,
    policy: dbPolicyEvents(),
  };
  fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + "\n");
  blessed = out;
  console.log(`已冻结输入：${Object.keys(recorded).length} 个数据 id，覆盖 ${generated.length} 组快照`);
}

// bless 轮没有读旧 fixture，清单必须记下「刚冻结的这一份」——否则下一轮 G24 会看到 fixture:null
const fx = fixture || blessed;
const manifest = {
  expected: expected.length,
  generated,
  skipped,
  granularities,
  fixture: fx ? { blessedAt: fx.blessedAt, reads: Object.keys(fx.reads).length, policy: (fx.policy || []).length } : null,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, "snapshots", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${bless ? "已冻结并写出" : write ? "已写入" : "比对"} ${generated.length} 份快照（清单 ${expected.length} 组合，跳过 ${skipped.length}），${check ? `差异 ${diffs} 份` : ""}`);
process.exit(check && diffs ? 1 : 0);
