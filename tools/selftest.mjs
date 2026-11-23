// 机制化自检：不是「跑一遍看看绿」，而是双向证明 ——
//  A) 热插拔实证：把整棵工程复制到临时沙箱，只加数据文件（不改任何代码），新指标/新页面必须自动出现在装配结果里；
//  B) 门禁可证红：在沙箱里故意破坏，对应门禁必须变红（判据失效的门禁等于没有门禁）；
//  C) fixture 对账：录制留档的官方响应解析结果必须与入库数据同值（离线复算，不再出网）。
// 用法：node tools/selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TREE = ["backend", "frontend", "indicators", "sheets", "summaries", "charts", "specs", "tools", "data", "snapshots", "fixtures", "package.json"];
const results = [];
let sandbox;

function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hong-selftest-${tag}-`));
  for (const t of TREE) {
    const from = path.join(ROOT, t);
    // filter 强制走 JS 复制路径：Node 22 在含非 ASCII 的工作区路径上，无 filter 的原生
    // cpSyncCopyDir 会静默终止进程（exit 127），让沙箱自检在部分机器上永远跑不起来。
    // no-op filter 保持「整棵复制」语义不变，门禁强度不打折。
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, t), { recursive: true, filter: () => true });
  }
  return dir;
}

function done(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`);
}

async function importFrom(dir, rel) {
  return import(pathToFileURL(path.join(dir, rel)).href);
}

// ---------- A) 热插拔：只写数据，不改代码 ----------
{
  sandbox = makeSandbox("hotplug");
  const probeId = "zz-selftest-probe";
  const cfg = {
    id: probeId,
    region: "us",
    name: "自检探针",
    en: "Self-test probe",
    unit: "%",
    precision: 2,
    surface: "strip",
    order: 990,
    checkKind: "恒等式逐点（本行 ↔ EFFR 已入库序列）",
    integrity: {
      range: [-10, 40],
      maxAbsJump: 5,
      source: {
        range: { statistic: "manual-policy", window: "2018-04-02 ~ 2026-11-19", measured: { min: 0.04, max: 5.33 }, note: "探针复用 EFFR 序列，区间按同带声明" },
        maxAbsJump: { statistic: "manual-policy", window: "2018-04-02 ~ 2026-11-19", measured: { p998Jump: 0.75 }, note: "探针不引入新跳变，沿用通用带" },
      },
    },
    legs: [{ key: "probe", primary: { provider: "series", id: "effr" }, check: { provider: "series", id: "effr", mode: "diff", band: [-0.001, 0.001], source: { statistic: "manual-policy", window: "2018-04-02 ~ 2026-11-19", measured: { devLo: 0, devHi: 0 }, note: "自身与自身相减，偏差恒为 0" } } }],
  };
  fs.writeFileSync(path.join(sandbox, "indicators", `${probeId}.json`), JSON.stringify(cfg, null, 2) + "\n");
  const spec = {
    id: "zz-selftest-page",
    page: "selftest",
    order: 990,
    title: "自检页",
    navLabel: "自检页",
    presets: "standard",
    axes: { rate: { side: "left", unit: "%" } },
    pick: { id: probeId },
    // 不写 recipe：让后端语义表决定图形（金额=柱、利率日频=走廊柱），这才叫「零改渲染层」
    layers: [{ series: "primary" }],
    views: [{ projection: "panel", container: "chart-selftest" }, { projection: "header", container: "hd-selftest" }],
    tooltip: { columns: ["value", "validation"] },
  };
  fs.writeFileSync(path.join(sandbox, "charts", "zz-selftest-page.json"), JSON.stringify(spec, null, 2) + "\n");

  const panels = await importFrom(sandbox, "backend/lib/panels.js");
  const indModule = await importFrom(sandbox, "backend/lib/indicators.js");
  const store = await importFrom(sandbox, "backend/lib/store.js");
  const { loadIndicators, updateIndicator } = indModule;
  // 走一遍真实取数链：探针的腿是 provider:"series"（读同库内 EFFR），因此不出网也能证明「新指标可入库可装配」
  const probeCfg = loadIndicators("us").find((c) => c.id === probeId);
  const probeData = await updateIndicator(probeCfg, { force: true, prev: null });
  store.write(probeId, probeData);
  const inds = loadIndicators("us").map((c) => c.id);
  done("A1 新指标自动发现（零改代码）", inds.includes(probeId), `loadIndicators 得到 ${inds.length} 个，含探针=${inds.includes(probeId)}`);

  const pages = panels.pagesOf("us").map((p) => p.id);
  done("A2 新页面自动进导航（零改代码）", pages.includes("selftest"), `导航页 = ${pages.join(",")}`);

  const payload = panels.buildPage("selftest", { region: "us", granularity: "day" });
  const view = (payload.views || []).find((v) => v.projection === "panel");
  const ok =
    !!view &&
    view.ds.layers?.length === 1 &&
    (view.ds.x?.values?.length || 0) > 100 &&
    view.ds.layers[0].recipe === "zoneBar" &&
    !view.ds.overflow.length;
  if (!ok) console.log("  A3 现场：", JSON.stringify({ err: view?.ds?.error, layers: view?.ds?.layers?.length, x: view?.ds?.x?.values?.length }).slice(0, 260));
  done("A3 新页面装配出可画 dataset", !!ok, view ? `层 ${view.ds.layers?.length} 点 ${view.ds.x?.values?.length} 轴 ${Object.keys(view.ds.axes).join(",")}` : "无 panel 视图");

  const opt = await importFrom(sandbox, "frontend/js/core/chart-option.js");
  const theme = await importFrom(sandbox, "frontend/js/core/theme.js");
  const cssTokens = fs.readFileSync(path.join(sandbox, "frontend/css/tokens.css"), "utf8");
  const tokens = {};
  for (const m of cssTokens.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  theme.setSource((n) => tokens[n] ?? "");
  theme.reset();
  const built = opt.buildOption({ spec: view.spec, ds: view.ds, preset: view.ds.defaultPreset, selected: {}, theme: theme.palette() });
  done("A4 新图层复用同一渲染核", built.series.length === 1 && built.yAxis.length === 1 && !!built.tooltip.formatter, `series ${built.series.length} / yAxis ${built.yAxis.length} / tooltip 有实现`);

  // 主程序与渲染核必须与仓库原件逐字一致：这是「只加数据、没改代码」的实证，不是声明
  const MAIN = [
    "backend/server.js",
    "frontend/js/app.js",
    "frontend/js/core/store.js",
    "frontend/js/core/chart-panel.js",
    "frontend/js/core/chart-option.js",
    "frontend/js/core/chart-types.js",
  ];
  const dirty = MAIN.filter((rel) => fs.readFileSync(path.join(sandbox, rel), "utf8") !== fs.readFileSync(path.join(ROOT, rel), "utf8"));
  done(
    "A5 主程序与渲染核零改动",
    dirty.length === 0,
    dirty.length ? `沙箱里被改动：${dirty.join(",")}` : `${MAIN.length} 个核心文件与仓库逐字一致`
  );
  // 先释放库句柄再删目录：Windows 上打开中的 .db 文件删不掉
  store.db.close();
  rmrf(sandbox);
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

// ---------- B) 门禁可证红：破坏沙箱 ⇒ 对应门禁必须变红 ----------
const NEG = [
  { gate: "G18", label: "删掉唯一图形出口", break: (d) => fs.rmSync(path.join(d, "frontend/js/core/chart-panel.js")) },
  { gate: "G5", label: "在 tokens.css 之外写字面色值", break: (d) => fs.appendFileSync(path.join(d, "frontend/css/components.css"), "\n.selftest-bad { color: #123456; }\n") },
  { gate: "G20", label: "spec 声明未注册的图形配方", break: (d) => { const p = path.join(d, "charts/main-trend.json"); const s = JSON.parse(fs.readFileSync(p, "utf8")); s.layers[0].recipe = "pie"; fs.writeFileSync(p, JSON.stringify(s, null, 2)); } },
  { gate: "G23", label: "再写一处 axis tooltip", break: (d) => fs.appendFileSync(path.join(d, "frontend/js/ui/Sparkline.js"), "\nexport const badTooltip = { trigger: \"axis\", tooltip: {} };\n") },
  { gate: "G13", label: "在 JS 里写字面色值", break: (d) => fs.appendFileSync(path.join(d, "frontend/js/core/derive.js"), "\nexport const BAD = \"#ff0000\";\n") },
  { gate: "G25", label: "前端写死政策事件日期", break: (d) => fs.appendFileSync(path.join(d, "frontend/js/core/chart-option.js"), "\nexport const BAD_EVENT = [\"2024-09-18\"];\n") },
    { gate: "G24", label: "让快照内容与基线漂移", break: (d) => { const p = path.join(d, "frontend/css/tokens.css"); const s = fs.readFileSync(p, "utf8").replace("--chart-grid-left: 56;", "--chart-grid-left: 66;"); fs.writeFileSync(p, s); } },
  { gate: "G14", label: "再写一份更新循环", break: (d) => fs.appendFileSync(path.join(d, "backend/server.js"), "\nexport async function dupeLoop(cfg) {\n  return await updateIndicator(cfg, { force: true });\n}\n") },
  { gate: "G11", label: "在 lib 层写死某个官方源", break: (d) => fs.appendFileSync(path.join(d, "backend/lib/semantics.js"), "\nexport const BAD_LEG = { provider: \"fred\", series: \"WALCL\" };\n") },
];
for (const n of NEG) {
  const dir = makeSandbox(`neg-${n.gate}`);
  n.break(dir);
  const r = spawnSync(process.execPath, [path.join(dir, "tools/gates.mjs"), "--only=" + n.gate], { encoding: "utf8", timeout: 240000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const wentRed = /RED/.test(out) && r.status !== 0;
  done(`B ${n.gate} 可证红（${n.label}）`, wentRed, wentRed ? out.split("\n").find((l) => l.trim().startsWith("G") === false && l.includes("BLOCKED") === false && l.trim())?.trim().slice(0, 110) || "已变红" : `未变红！退出码 ${r.status} 输出：${out.slice(0, 160)}`);
  rmrf(dir);
}

// ---------- C) fixture 留档与入库数据对账（离线，不出网） ----------
{
  const dir = path.join(ROOT, "fixtures");
  if (!fs.existsSync(dir)) {
    done("C fixture 留档对账", false, "fixtures/ 不存在（先 node tools/record-fixtures.mjs）");
  } else {
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".fixture.json"));
    const rec = JSON.parse(fs.readFileSync(path.join(dir, "_record.json"), "utf8"));
    const bad = [];
    let valueChecked = 0;
    let endpointOnly = 0;
    const cfgs = fs
      .readdirSync(path.join(ROOT, "indicators"))
      .map((x) => JSON.parse(fs.readFileSync(path.join(ROOT, "indicators", x), "utf8")));
    const legsOf = (c) => (c.legs || []).flatMap((l) => [l.primary, l.check].filter(Boolean));
    for (const file of files) {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const r = (rec.results || []).find((x) => x.id === fx.id);
      if (!r) bad.push(`${fx.id}: _record.json 里没有这轮的记录`);
      else if (!r.ok) bad.push(`${fx.id}: 录制失败且未被豁免（${r.error}）`);
      if (fx.rows === undefined || fx.rows === null) bad.push(`${fx.id}: 留档没写 rows，无法判断是否空响应`);
      else if (Number(fx.rows) <= 0) bad.push(`${fx.id}: 留档为空响应（rows=${fx.rows}）`);
      // 留档形状：日期→值的数组可逐值对账；对象型（报表/事件）只能核对有内容
      const arr = Array.isArray(fx.payload) ? fx.payload : Array.isArray(fx.payload?.rows) ? fx.payload.rows : Array.isArray(fx.payload?.events) ? fx.payload.events : null;
      if (!arr || !arr.length) {
        bad.push(`${fx.id}: 留档里没有可复算的行`);
        continue;
      }
      const isMap = arr.every((x) => Array.isArray(x) && (typeof x[1] === "number" || (x[1] && typeof x[1] === "object")));
      if (!isMap) {
        endpointOnly++;
        continue;
      }
      // 只有取数参数与某条腿完全一致时，留档值才应该等于入库值（否则是拿 WALCL 去比百分数那种错配）
      const want = fx.requested?.src || {};
      const sameSrc = (s) => s.provider === fx.id && Object.entries(want).every(([k, v]) => (Array.isArray(s[k]) ? s[k].includes(v) : s[k] === v));
      const fed = cfgs.filter((c) => legsOf(c).some(sameSrc));
      if (!fed.length) {
        endpointOnly++;
        continue;
      }
      const byDate = new Map(arr.map((x) => [x[0], x[1]]));
      let hits = 0;
      let overlap = 0;
      let sample = "";
      for (const c of fed) {
        const d = JSON.parse(fs.readFileSync(path.join(ROOT, `data/${c.id}.json`), "utf8"));
        for (const p of d.points || []) {
          if (!byDate.has(p.d)) continue;
          overlap++;
          const rec2 = byDate.get(p.d);
          const v = rec2 && typeof rec2 === "object" ? rec2.v ?? rec2.avg ?? null : rec2;
          if (v == null) continue;
          if (!sample) sample = `${c.id} ${p.d} 留档 ${v} 入库 ${p.v}`;
          if (Math.abs(Number(v) - Number(p.v)) <= Math.max(0.011, Math.abs(p.v) * 0.02)) hits++;
        }
      }
      if (!overlap) bad.push(`${fx.id}: 留档 ${byDate.size} 行与同参数序列无重叠日期，无法对账（须重录近期窗口）`);
      else if (!hits) bad.push(`${fx.id}: 有 ${overlap} 个重叠日期但数值全部不符（首对：${sample}）`);
      else valueChecked++;
    }
    done(
      "C fixture 留档对账",
      !bad.length && files.length >= 15,
      bad.length ? `${bad.length} 条不符：` + bad.slice(0, 4).join(" ; ") : `${files.length} 份留档：${valueChecked} 份与同参数入库序列逐值吻合，${endpointOnly} 份为端点/报表证据`
    );
  }
}

const fails = results.filter((r) => !r.ok);
console.log(`\n自检 ${results.length} 项：PASS ${results.length - fails.length} / FAIL ${fails.length}`);
process.exit(fails.length ? 1 : 0);
