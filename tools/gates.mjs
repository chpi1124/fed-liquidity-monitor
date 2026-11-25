// 机检门禁 runner · 零依赖（只用 Node 自身）
// 用法：node tools/gates.mjs [--only=G18,G21] [--json] [--record] [--net]
// 原则：fail-closed —— 目标文件/目录缺失即红；基线棘轮只降不升；每条门禁必须可证红（见 gate-selftest.mjs）。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const P = (...a) => path.join(ROOT, ...a);
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const asJson = args.includes("--json");
const record = args.includes("--record");
const wantNet = args.includes("--net");

const read = (rel) => {
  try {
    return fs.readFileSync(P(rel), "utf8");
  } catch {
    return null;
  }
};
const exists = (rel) => fs.existsSync(P(rel));
const walk = (rel, filter) => {
  const out = [];
  const dir = P(rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(r, filter));
    else if (filter.test(e.name)) out.push(r);
  }
  return out;
};
const JS_SRC = () => [...walk("backend", /\.js$/), ...walk("frontend/js", /\.js$/)].filter((f) => !f.includes("vendor"));
const uniq = (arr) => [...new Set(arr)];
const COUNT = (s, re) => (s && (s.match(re) || []).length) || 0;

// 文案类判据只看字符串字面量（注释里重复一句「存疑」不构成第二个 owner，代码注释不是产物）
function stringsOf(src) {
  const out = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3]);
  return out.join("\n");
}
// 算术类判据须先剥注释，否则注释里的 1e6 会冒充代码
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// 注册表键集：直接 import 真实模块读取，不用正则猜（正则曾把 itemStyle: 当成配方）
const REG = { recipes: null, columns: null, error: null };
try {
  const types = await import(pathToFileURL(P("frontend/js/core/chart-types.js")).href);
  const option = await import(pathToFileURL(P("frontend/js/core/chart-option.js")).href);
  REG.recipes = Object.keys(types.RECIPES);
  REG.columns = Object.keys(option.TOOLTIP_COLUMNS);
} catch (e) {
  REG.error = e.message;
}
const contract = await import(pathToFileURL(P("tools/contract.mjs")).href);
const thresholds = await import(pathToFileURL(P("tools/thresholds.mjs")).href);
const publish = await import(pathToFileURL(P("tools/publish.mjs")).href);
let providerList = [];
try {
  providerList = (await import(pathToFileURL(P("backend/providers/registry.js")).href)).list();
} catch (e) {
  console.log("provider 注册表加载失败：" + e.message);
}

// ---------- 基线棘轮（只能变小） ----------
const BASELINE_FILE = "tools/baselines.json";
const baselines = JSON.parse(read(BASELINE_FILE) || "{}");
const ratchets = {};
function ratchet(key, value, limit) {
  const cap = limit != null ? limit : baselines[key];
  const base = cap == null ? value : Math.min(cap, value);
  ratchets[key] = { observed: value, baseline: cap == null ? null : cap, effective: base };
  if (limit != null) return { ok: true, detail: `${key} 新建基线 ${value}` };
  if (cap == null) return { ok: false, detail: `${key} 无基线（fail-closed：先 --record 固化再改）` };
  if (value > cap) return { ok: false, detail: `${key} ${value} > 基线 ${cap}（棘轮只降不升）` };
  return { ok: value === cap, detail: value < cap ? `${key} ${value} < 基线 ${cap} ⇒ 请 --record 收紧` : `${key} = 基线 ${cap}` };
}

// ---------- 零依赖语法检查：.js 复制为 .mjs 后 node --check ----------
function syntaxCheck(files) {
  const bad = [];
  const tmp = P("tools", ".syntax-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of files) {
    const t = path.join(tmp, f.replace(/[\\/]/g, "_") + ".mjs");
    fs.copyFileSync(P(f), t);
    const r = spawnSync(process.execPath, ["--check", t], { stdio: "pipe" });
    if (r.status !== 0) bad.push(`${f}: ${String(r.stderr).split("\n")[1] || r.stderr}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return bad;
}

// ---------- 结构骨架指纹（G19 去重） ----------
const KW = new Set(["if", "else", "for", "while", "return", "function", "const", "let", "var", "new", "class", "of", "in", "try", "catch", "switch", "case", "await", "async", "export", "import", "throw", "typeof", "null", "true", "false"]);
function skeleton(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out += "S";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 2;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9a-fA-FxX]/.test(src[i])) i++;
      out += "N";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      out += KW.has(w) ? w : "ID";
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
function blocks(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(openIdx, i + 1);
    }
  }
  return "";
}
function functionsOf(src) {
  const out = [];
  const re = /(?:export\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[2];
    const brace = src.indexOf("{", re.lastIndex - 1);
    if (brace < 0) continue;
    const body = blocks(src, brace);
    if (!body) continue;
    const sk = skeleton(body);
    out.push({ name, sk, len: sk.length });
  }
  return out.filter((f) => f.len >= 260);
}
function objectLiteralDupes(src) {
  // 键集相同且重合 ≥0.8 的对象字面量 ⇒ 判重（slider 样式、tooltip 配置这类）
  const objs = [];
  const re = /\{\s*[A-Za-z_$][\w$]*\s*:/g;
  let m;
  while ((m = re.exec(src))) {
    const body = blocks(src, src.indexOf("{", m.index));
    if (body.length < 220 || body.length > 2400) continue;
    const keys = new Set([...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]));
    if (keys.size >= 5) objs.push({ keys, line: src.slice(0, m.index).split("\n").length, head: body.replace(/\s+/g, " ").slice(0, 34) });
  }
  const groups = new Map();
  for (let a = 0; a < objs.length; a++)
    for (let b = a + 1; b < objs.length; b++) {
      const inter = [...objs[a].keys].filter((k) => objs[b].keys.has(k)).length;
      const union = new Set([...objs[a].keys, ...objs[b].keys]).size;
      if (inter / union < 0.8) continue;
      const sig = [...objs[a].keys].sort().join(",");
      if (!groups.has(sig)) groups.set(sig, { keys: objs[a].keys.size, sites: [] });
      groups.get(sig).sites.push(objs[a].line, objs[b].line);
    }
  return [...groups.entries()].map(
    ([sig, g]) => `重复对象字面量（${g.keys} 键：${sig.split(",").slice(0, 4).join("/")}…）出现于行 ${[...new Set(g.sites)].sort((x, y) => x - y).join(",")}`
  );
}

// ---------- WCAG 对比度（G6） ----------
function tokenMap(css) {
  const map = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
function lum(hex) {
  const h = hex.replace("#", "");
  const v = (h.length === 3 ? h.split("").map((c) => c + c).join("") : h)
    .slice(0, 6)
    .match(/../g)
    .map((x) => parseInt(x, 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------- 门禁表 ----------
const GRAPHICS = ["frontend/js/chart.js", "frontend/js/core/chart-panel.js", "frontend/js/core/chart-option.js", "frontend/js/core/chart-types.js", "frontend/js/core/theme.js", "frontend/js/core/dataset.js", "frontend/js/ui/Sparkline.js", "frontend/js/ui/CompositionBar.js", "frontend/js/ui/RateTile.js", "frontend/js/ui/Legend.js", "frontend/js/ui/Ecg.js"];
const present = (rel) => (exists(rel) ? [rel] : []);
const graphicsFiles = () => GRAPHICS.filter((f) => exists(f));
// 颜色字面量：前置不是 & （排除 &#160; 这类 HTML 数字实体），长度 3 或 6 位（排除 #160 这种误报）
const HEX = /(?<!&)#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

const gates = [];
function gate(id, name, fn) {
  gates.push({ id, name, fn });
}

gate("G0", "静态：可解析·零依赖·无残件", () => {
  const pkg = JSON.parse(read("package.json") || "{}");
  const deps = Object.keys(pkg.dependencies || {}).length;
  const bad = syntaxCheck([...JS_SRC(), ...walk("tools", /\.mjs$/).filter((f) => !f.includes("fixtures"))]);
  const leftovers = fs
    .readdirSync(ROOT)
    .filter((f) => /^(probe[-_].*|.*\.tmp|scratch.*|_ignore.*)$/i.test(f))
    .concat(walk("data", /\.tmp$/));
  const fails = [];
  if (deps) fails.push(`dependencies=${deps}`);
  if (bad.length) fails.push(`语法失败 ${bad.length}: ${bad.slice(0, 2).join(" | ")}`);
  if (leftovers.length) fails.push(`残件 ${leftovers.slice(0, 4).join(", ")}`);
  return { ok: !fails.length, detail: fails.join("; ") || `全部 ${JS_SRC().length} 个源文件可解析；零依赖；无残件` };
});

gate("G1", "校验覆盖：19/19 指标有校验腿", () => {
  const inds = walk("indicators", /\.json$/);
  const noCheck = [], noKind = [], zero = [], unlabeledSingle = [];
  for (const f of inds) {
    const c = JSON.parse(read(f));
    const legs = c.legs || [];
    if (!legs.some((l) => l.check)) noCheck.push(c.id);
    if (!c.checkKind) noKind.push(c.id);
    const d = JSON.parse(read(`data/${c.id}.json`) || "null");
    if (d && !(d.validation?.checked > 0)) {
      zero.push(c.id);
      // 增量轮次里 validation.checked 只描述本轮窗口，覆盖与否必须看累计事实（lifetime）
      // 判据 = 累计已校验点数（增量轮次的 checked 只描述本轮窗口，不能拿来判断「有没有校验」）
      const checkedAll = d.validation?.lifetime?.checked ?? d.validation?.checked ?? 0;
      const explained = d.validation?.singleSource || c.singleSource || (d.validation?.checkErrors || []).length > 0 || d.validation?.degraded;
      if (!(checkedAll > 0) && !explained) unlabeledSingle.push(c.id);
    }
  }
  const sums = walk("summaries", /\.json$/).map((f) => JSON.parse(read(f)));
  const sumBad = [];
  for (const s of sums) {
    const d = JSON.parse(read(`data/summary-${s.id}.json`) || "null");
    if (!d) continue;
    for (const r of d.rows || []) {
      const v = r.validation || {};
      if (!(v.checked > 0) && !r.singleSource && !r.status) sumBad.push(`${s.id}/${r.id}`);
    }
  }
  const fails = [];
  if (noCheck.length) fails.push(`无校验腿 ${noCheck.length}: ${noCheck.slice(0, 3)}`);
  if (noKind.length) fails.push(`无 checkKind ${noKind.length}: ${noKind.slice(0, 3)}`);
  if (unlabeledSingle.length) fails.push(`checked=0 却既未标单源也未留失败原因 ${unlabeledSingle.length}: ${unlabeledSingle.slice(0, 3)}`);
  if (sumBad.length) fails.push(`汇总行既无校验也无单源声明 ${sumBad.length}: ${sumBad.slice(0, 3)}`);
  return { ok: !fails.length, detail: fails.join("; ") || `${inds.length} 个指标全部有 check 腿与 checkKind；汇总行全部有校验或单源声明` };
});

const STAT = new Set(["min", "max", "p0.2", "p99.8", "manual-policy"]);
gate("G2", "阈值溯源：每个阈值带 source 且可复算", () => {
  const bad = [];
  let n = 0;
  for (const f of walk("indicators", /.json$/)) {
    const cfg = JSON.parse(read(f));
    const d = JSON.parse(read("data/" + cfg.id + ".json") || "null");
    if (!d?.points?.length) {
      bad.push(cfg.id + ": 数据未入库，阈值无从复算");
      continue;
    }
    n++;
    bad.push(...thresholds.audit(cfg, d));
  }
  return { ok: !bad.length, detail: bad.length ? bad.length + " 条违例（前 3）：" + bad.slice(0, 3).join(" ; ") : n + " 个指标的每个阈值都带来源，且与今日实测同向（含校验带包含关系与 12 倍松紧上限）" };
});
gate("G3", "数据红线：不造数·改值留痕·不绕 WAF", () => {
  const fails = [];
  const fake = [];
  for (const f of walk("data", /\.json$/)) {
    const s = read(f);
    if (/"(filled|interpolated|estimate|placeholder)"/.test(s)) fake.push(f);
    const d = JSON.parse(s);
    for (const p of d.points || []) {
      if (p.corrected && !(p.corrected.from != null && p.corrected.to != null && p.corrected.by)) fake.push(`${f}:改值无留痕`);
      break;
    }
  }
  if (fake.length) fails.push(`造数/无痕改值 ${fake.length}: ${fake.slice(0, 3)}`);
  const fetchers = read("backend/lib/fetchers.js") || "";
  for (const re of [/user-?agent\s*(rotat|pool|cycle)/i, /captcha/i, /cloudflare.*(bypass|solve)/i, /puppeteer|playwright/i]) {
    if (re.test(fetchers)) fails.push(`疑似绕 WAF：${re}`);
  }
  const rejected = read("specs/rejected-sources.json");
  if (!rejected) fails.push("specs/rejected-sources.json 缺失（不可达官方源须登记，fail-closed）");
  else {
    const list = JSON.parse(rejected);
    const withBranch = (list || []).filter((r) => new RegExp(`"${r.slug}"`).test(fetchers));
    if (withBranch.length) fails.push(`已拒源仍有 provider 分支：${withBranch.map((x) => x.slug).join(",")}`);
  }
  const degraded = read("specs/degraded-sources.json");
  if (!degraded) fails.push("specs/degraded-sources.json 缺失（可达但受限的源须登记上限与处理口径，fail-closed）");
  else {
    const list = JSON.parse(degraded);
    const loose = list.filter((d) => !d.why || !d.decision || !(d.declaredIn || []).length);
    if (loose.length) fails.push(`降级源未写清上限或出处：${loose.map((m) => m.slug).join(",")}`);
    const dangling = list.flatMap((d) => d.declaredIn || []).filter((p) => !exists(p));
    if (dangling.length) fails.push(`降级源声明指向不存在的文件：${dangling.join(",")}`);
  }
  return { ok: !fails.length, detail: fails.join("; ") || "无造数字段；改值全部留痕；无绕 WAF 逻辑；被拒源已登记" };
});

gate("G4", "纠错有效性负向对照（需出网，--net 开启）", () => {
  if (!wantNet) return { ok: false, detail: "BLOCKED-NET：未开启 --net，本门禁不判绿（须显式跑 node tools/gates.mjs --net）" };
  const r = spawnSync(process.execPath, [P("tools", "negctl.mjs")], { encoding: "utf8", timeout: 240000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const hit = COUNT(out, /命中/);
  return { ok: r.status === 0 && hit > 0, detail: `negctl 退出码 ${r.status}；注入命中记录 ${hit} 条（必须 > 0，否则等于在测注入本身）` };
});

gate("G5", "前端结构唯一性", () => {
  const fe = walk("frontend/js", /\.js$/);
  const bad = [];
  const hitsOf = (needle) => fe.filter((f) => (read(f) || "").includes(needle));
  const api = "frontend/js/core/api.js";
  const panel = "frontend/js/core/chart-panel.js";
  for (const [needle, file, label] of [
    ["fetch(", api, "fetch("],
    ["echarts.init", panel, "echarts.init"],
    ["/api/indicators", api, "API 路径字面量"],
    ["/api/panel", api, "面板路径字面量"],
    ["/api/sheets", api, "报表路径字面量"],
    ["/api/summaries", api, "汇总路径字面量"],
  ]) {
    const outside = hitsOf(needle).filter((f) => f !== file && !(needle === "fetch(" && f === panel));
    if (outside.length) bad.push(`${label} 越界于 ${outside.join(",")}`);
  }
  const app = read("frontend/js/app.js") || "";
  const direct = [...app.matchAll(/from\s+"\.\/ui\/([A-Za-z]+)\.js"/g)].map((m) => m[1]).filter((n) => n !== "index");
  if (direct.length) bad.push(`app.js 绕过 ui/index.js 直接引组件：${direct.slice(0, 3)}`);
  const cssFiles = walk("frontend/css", /\.css$/);
  const owner = "frontend/css/tokens.css";
  if (!exists(owner)) return { ok: false, detail: `BLOCKED：${owner} 缺失，色板没有 owner` };
  const outside = cssFiles
    .filter((f) => f !== owner)
    .flatMap((f) => (read(f).match(HEX) || []).map((m) => `${f.split("/").pop()}:${m}`))
    .concat(cssFiles.filter((f) => f !== owner).flatMap((f) => (read(f).match(/rgba?\(/g) || []).map(() => `${f.split("/").pop()}:rgba 字面量`)));
  const paletteHex = COUNT(read(owner), HEX);
  const r = ratchet("palette_hex", paletteHex);
  const fails = [...bad, ...outside, r];
  return {
    ok: !fails.some((x) => (typeof x === "string" ? true : !x.ok)),
    detail: fails.map((x) => (typeof x === "string" ? x : x.ok ? "" : x.detail)).filter(Boolean).join("; ") ||
      `出口唯一（api.js fetch、${panel} echarts）；色值仅在 ${owner}（${paletteHex} 枚，rgba 0 处，半透明一律 color-mix）`,
  };
});

gate("G6", "美学与可达（WCAG 2.2 AA）", () => {
  const css = read("frontend/css/tokens.css") || "";
  const t = tokenMap(css);
  const fails = [];
  const need = [
    ["--ink", "--surface", 4.5],
    ["--muted", "--surface", 4.5],
    ["--faint", "--surface", 4.5],
    ["--accent", "--surface", 3],
    ["--ok", "--surface", 3],
    ["--warn", "--surface", 3],
    ["--danger", "--surface", 3],
    ["--info", "--surface", 3],
    ["--ink-strong", "--surface", 4.5],
    ["--on-accent", "--accent", 4.5],
  ];
  for (const [fg, bg, min] of need) {
    if (!t[fg] || !t[bg]) {
      fails.push(`令牌缺失 ${fg}/${bg}`);
      continue;
    }
    if (!/^#/.test(t[fg]) || !/^#/.test(t[bg])) continue;
    const r = ratio(t[fg], t[bg]);
    if (r < min) fails.push(`${fg}:${r.toFixed(2)} < ${min}`);
  }
  const dur = parseFloat(t["--dur"]);
  if (!(dur <= 0.45)) fails.push(`--dur ${dur}s 超 400ms 档`);
  if (t["--glow-accent"]) fails.push("存在 glow 令牌（Apple 克制原则禁用发光）");
  return { ok: !fails.length, detail: fails.join("; ") || "对比度全过 AA；动效与发光合规" };
});

gate("G8", "增量正确性（水位线与修订窗）", async () => {
  const dbm = await import(pathToFileURL(P("backend/lib/db.js")).href);
  const sem = await import(pathToFileURL(P("backend/lib/semantics.js")).href);
  const fails = [];
  const inds = walk("indicators", /\.json$/).map((f) => JSON.parse(read(f)));
  const wm = inds.map((c) => ({ c, w: dbm.getWatermark(c.id) })).filter((x) => x.w);
  if (wm.length < inds.length) fails.push(`${inds.length - wm.length} 个指标没有水位线行（增量无从推进）`);
  const noOverlap = wm.filter((x) => !(Number(x.w.overlap_days) > 0));
  if (noOverlap.length) fails.push(`水位线缺修订窗 ${noOverlap.length} 个：${noOverlap.slice(0, 3).map((x) => x.c.id).join(",")}`);
  const regressed = wm.filter((x) => x.w.last_observed && x.w.last_fetched_to && x.w.last_observed > x.w.last_fetched_to);
  if (regressed.length) fails.push(`水位线倒挂（观测晚于取数上限）${regressed.length} 个`);
  // 增量必须真的比全量窄：对 tail 策略的指标复算窗口，区间长度显著小于全历史跨度才算推进
  const today = new Date().toISOString().slice(0, 10);
  const wide = [];
  for (const { c, w } of wm) {
    const src = (c.legs || [])[0]?.primary || {};
    const plan = sem.fetchWindow(c, src.provider, today, c.start || "2015-01-01");
    if (plan.strategy === "tail" && plan.start <= (c.start || "2015-01-01")) wide.push(c.id);
  }
  if (wide.length) fails.push(`tail 策略仍按全区间取数：${wide.slice(0, 3).join(",")}`);
  return { ok: !fails.length, detail: fails.join("; ") || `水位线 ${wm.length} 行均有修订窗（overlap>0），tail 源窗口已收窄到水位线之后` };
});

gate("G9", "契约一致（schema 与 provider 能力矩阵）", async () => {
  const fails = [];
  for (const f of ["specs/indicator.schema.json", "specs/gates.md", "specs/capability.json"]) if (!exists(f)) fails.push(f + " 缺失（node tools/publish.mjs 生成）");
  if (fails.length) return { ok: false, detail: fails.join("; ") };
  const bad = contract.validateDir("indicators", contract.loadSchema());
  if (bad.length) fails.push("schema 违例 " + bad.length + " 份：" + bad[0].file + " → " + bad[0].errors[0]);
  const cap = JSON.parse(read("specs/capability.json"));
  const regIds = providerList.map((x) => x.id).sort();
  const capIds = Object.keys(cap).sort();
  if (JSON.stringify(regIds) !== JSON.stringify(capIds))
    fails.push("能力矩阵与 provider 注册表不一致：注册表 " + regIds.length + " 个，矩阵 " + capIds.length + " 个");
  if (JSON.stringify(cap) !== JSON.stringify(await publish.capability())) fails.push("specs/capability.json 已过期（重新 node tools/publish.mjs）");
  if (read("specs/gates.md") !== publish.gatesProjection()) fails.push("specs/gates.md 与 runner 漂移（重新发布）");
  return { ok: !fails.length, detail: fails.join("; ") || "schema 全过；能力矩阵与 gates.md 均与代码同源（provider " + capIds.length + " 个）" };
});
gate("G10", "存储可信（SQLite 断言）", async () => {
  const dbm = await import(pathToFileURL(P("backend/lib/db.js")).href);
  const fails = [];
  if (dbm.pragmaJournalMode() !== "wal") fails.push(`journal_mode 实测为 ${dbm.pragmaJournalMode()}（规范 D-1 要求 wal）`);
  if (Number(dbm.metaValue("schema_version")) !== dbm.SCHEMA_VERSION) fails.push(`schema_version ${dbm.metaValue("schema_version")} ≠ 代码要求 ${dbm.SCHEMA_VERSION}`);
  const fk = dbm.foreignKeyViolations();
  if (fk) fails.push(`外键违例 ${fk} 条`);
  const inds = walk("indicators", /\.json$/).map((f) => JSON.parse(read(f)));
  let mismatch = 0;
  let lostCorrect = 0;
  for (const c of inds) {
    const fromDb = dbm.readSeries(c.id);
    const file = JSON.parse(read("data/" + c.id + ".json") || "null");
    if (!fromDb || !file) {
      mismatch++;
      continue;
    }
    if (fromDb.points.length !== file.points.length) mismatch++;
    else {
      for (let i = 0; i < file.points.length; i += 1) {
        if (fromDb.points[i].d !== file.points[i].d || fromDb.points[i].v !== file.points[i].v) {
          mismatch++;
          break;
        }
      }
    }
    const flagged = file.points.filter((p) => p.corrected).length;
    const rows = dbm.correctionsOf(c.id).length;
    if (rows < flagged) lostCorrect++;
  }
  if (mismatch) fails.push(`库与导出快照不一致的序列 ${mismatch} 个`);
  if (lostCorrect) fails.push(`改值点数多于 correction 行的序列 ${lostCorrect} 个（留痕不完整）`);
  const cnt = dbm.counts();
  if (!cnt.points) fails.push("库里没有点值");
  return { ok: !fails.length, detail: fails.join("; ") || `wal + schema_version ${dbm.SCHEMA_VERSION} 一致、外键违例 0、${inds.length} 个序列库与导出逐值一致、改值留痕成表（点 ${cnt.points} / 修订 ${cnt.revisions} / 改值 ${cnt.corrections}）` };
});

gate("G11", "中心分派归零（注册表化）", () => {
  const files = [...JS_SRC()];
  // 只钉「拿代码字段去比字符串常量」这种中心分派；状态自比（page === state.page）不算
  const pats = [
    ["provider ===", /\.provider\s*===\s*"/g],
    ["render ===", /\.render\s*===\s*"/g],
    ["surface ===", /\.surface\s*===\s*"/g],
    ["page ===", /\bpage\s*===\s*"/g],
    ["kind switch", /case\s+"/g],
  ];
  const hits = [];
  let total = 0;
  for (const [label, re] of pats) {
    for (const f of files) {
      const n = COUNT(read(f), re);
      if (n) hits.push(`${label}@${f.replace("frontend/js/", "").replace("backend/lib/", "")}×${n}`);
      total += n;
    }
  }
  // lib 层不得认领具体官方源：sheets/summaries/policy 一度把 frb-h41 / fred / fed-policy 写死在代码里，
  // 于是「换一个市场做汇总表/政策事件」就得改主程序。源名单取自注册表（目录自动发现）⇒ 新增源自动进入判据。
  if (providerList.length) {
    const litRe = new RegExp(`provider:\\s*"(?:${providerList.map((p) => p.id).join("|")})"`, "g");
    for (const f of files.filter((x) => x.startsWith("backend/lib/"))) {
      const n = COUNT(stripComments(read(f)), litRe);
      if (n) hits.push(`写死源@${f.replace("backend/lib/", "")}×${n}`);
      total += n;
    }
  } else {
    hits.push("provider 注册表未加载（写死源判据失效，按红处理）");
    total += 1;
  }
  const registry = { providers: providerList.length };
  return { ok: total === 0 && registry.providers > 0, detail: total === 0 ? `分派 0 处；provider 注册表 ${registry.providers} 个（目录自动发现）` : `中心分派 ${total} 处：${hits.slice(0, 6).join(", ")}` };
});

gate("G12", "变更面：资产类变更不触及主程序", () => {
  if (!exists("specs/change-classes.json")) return { ok: false, detail: "BLOCKED：specs/change-classes.json 缺失（fail-closed）" };
  const cc = JSON.parse(read("specs/change-classes.json"));
  const fails = [];
  const MAIN = ["backend/server.js", "frontend/js/app.js", "frontend/js/core/store.js", "frontend/js/core/chart-panel.js"];
  for (const c of cc.classes) {
    const overlap = (c.touch || []).filter((g) => MAIN.some((m) => g === m));
    if (overlap.length) fails.push(c.class + " 声称要改主程序：" + overlap.join(","));
    if (!c.proof) fails.push(c.class + " 没有实证方式（proof）");
    if (!c.example) fails.push(c.class + " 没有示例落点（example）");
    for (const e of c.forbiddenTouch || []) if (MAIN.includes(e) && (c.touch || []).includes(e)) fails.push(c.class + " 既禁止又要求改 " + e);
  }
  if (!exists("tools/selftest.mjs")) fails.push("缺 tools/selftest.mjs：热插拔须在沙箱里真跑一遍，不能只在清单上声明");
  else {
    // 门禁必须执行它，而不是检查文件里有没有若干关键字：不跑就永远不知道它是否还能跑
    const st = spawnSync(process.execPath, [P("tools", "selftest.mjs")], { encoding: "utf8", timeout: 600000 });
    if (st.status !== 0) fails.push(`selftest 退出码 ${st.status}：${String(st.stdout || st.stderr).split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join(" | ") || String(st.stderr).slice(0, 120)}`);
    else if (!/自检 \d+ 项：PASS \d+ \/ FAIL 0/.test(st.stdout || "")) fails.push("selftest 输出里没有「FAIL 0」结论");
    const st2 = read("tools/selftest.mjs");
    for (const [needle, why] of [["mkdtempSync", "没有临时沙箱根（改动会落在真仓库上）"], ["spawnSync", "没有以子进程真跑门禁，无法证明可证红"], ["buildPage", "没有走后端装配，无法证明新数据自动生效"], ["逐字一致", "没有比对主程序未变"]]) if (!st2.includes(needle)) fails.push("selftest 缺少 " + why + "（" + needle + "）");
  }
  return { ok: !fails.length, detail: fails.join("; ") || cc.classes.length + " 类变更的落点全部在数据/资产层，且由 selftest 沙箱实证" };
});
// CSS 尺寸豁免口径：栅格间距/字号/圆角标度 + 1–3px 发丝线 + 视口相关值（与规范文档一致）
const SPACING = new Set([0, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96]);
const FONT = new Set([11, 13, 15, 17, 21, 28, 40]);
const RADIUS = new Set([4, 6, 8, 12, 16, 20, 999]);
function offGridPx(cssText) {
  const out = [];
  // 媒体查询断点是响应式条件，不是组件样式尺寸；不应计入栅格棘轮。
  const body = cssText.replace(/@media[^{]+\{/g, (s) => " ".repeat(s.length));
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, val] = m;
    if (/var\(--(sp|r|t)[\w-]*\)/.test(val)) continue;
    if (!/^(font-size|padding|padding-\w+|margin|margin-\w+|gap|width|height|min-width|max-width|min-height|border-radius|left|right|top|bottom|inset-inline-\w+)$/.test(prop)) continue;
    for (const n of val.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const v = Math.abs(Number(n[1]));
      if (v <= 3) continue; // 发丝线与描边
      if (/font-size/.test(prop) && FONT.has(v)) continue;
      if (/border-radius/.test(prop) && RADIUS.has(v)) continue;
      if (SPACING.has(v)) continue;
      out.push(`${prop}:${v}px`);
    }
  }
  return out;
}

gate("G13", "数字驱动：令牌外字面量", () => {
  const js = JS_SRC();
  const css = walk("frontend/css", /\.css$/);
  const jsHex = js.reduce((a, f) => a + COUNT(read(f), HEX), 0);
  const off = css.flatMap((f) => offGridPx(read(f) || ""));
  const cfgHex = walk("indicators", /\.json$/).concat(walk("sheets", /\.json$/), walk("summaries", /\.json$/)).reduce((a, f) => a + COUNT(read(f), HEX), 0);
  const r1 = ratchet("js_hex_literals", jsHex);
  const r2 = ratchet("css_offgrid_px", off.length);
  const r3 = ratchet("config_hex", cfgHex);
  const fails = [r1, r2, r3].filter((r) => !r.ok).map((r) => r.detail);
  return { ok: !fails.length, detail: fails.join("; ") || `JS hex ${jsHex}；CSS 栅格外 px ${off.length}；配置 hex ${cfgHex}（均在基线内）` };
});

gate("G14", "SSOT：同一事实只有一个 owner", () => {
  const files = uniq(JS_SRC().concat(walk("frontend/css", /\.css$/)));
  const codeOf = (f) => stripComments(read(f) || "").replace(/(--[\w-]+)\s*:\s*[^;]+;/g, "");
  const bad = [];
  // 文案类事实：只比字符串字面量（注释不算第二个 owner）；算术类事实：只比剥掉注释的代码
  const probes = [
    { label: "校验通过措辞", re: /交叉验证 [^\n"']{0,12}通过/, where: "strings" },
    { label: "改值留痕措辞", re: /已依 [^\n"']{0,40}改值/, where: "strings" },
    { label: "存疑措辞", re: /存疑（|存疑：|个存疑点/, where: "strings" },
    { label: "万亿换算", re: /\/\s*1e6\b/, where: "code" },
  ];
  for (const p of probes) {
    const hits = files.filter((f) => (p.where === "strings" ? p.re.test(stringsOf(read(f) || "")) : p.re.test(codeOf(f))));
    if (hits.length > 1) bad.push(`${p.label}: ${hits.map((h) => h.split("/").pop()).join(",")}`);
  }
  // 更新循环只有一个 owner（backend/lib/pipeline.js）。曾经 server.js 与根 run-update.mjs 各写一份：
  // CLI 那份漏了政策事件/报表/汇总三条腿还天天全量重取 —— 同一个事实两个 owner 就是这么烂掉的。
  const loopFiles = walk("backend", /\.js$/).filter((f) => /await updateIndicator\(/.test(codeOf(f)));
  if (loopFiles.length !== 1 || loopFiles[0] !== "backend/lib/pipeline.js") bad.push(`更新循环 owner 不唯一：${loopFiles.join(",") || "无"}`);
  const allDefs = walk("backend", /\.js$/).filter((f) => /(async function|const) updateAll\b/.test(codeOf(f)));
  if (allDefs.length !== 1 || allDefs[0] !== "backend/lib/pipeline.js") bad.push(`updateAll 定义不唯一：${allDefs.join(",") || "无"}`);
  const dupText = duplicateFragments(files);
  return { ok: !bad.length && !dupText.length, detail: [...bad, ...dupText].join("; ") || "措辞与换算各自单一 owner" };
});

function duplicateFragments(files) {
  const seen = new Map();
  const out = [];
  for (const f of files) {
    // 同一句用户可见的话（≥18 个汉字）出现在两个文件 = 两个 owner
    for (const m of stringsOf(read(f) || "").matchAll(/[一-鿿（【][一-鿿，、：；（）0-9A-Za-z]{18,}/g)) {
      const frag = m[0].slice(0, 40);
      if (!seen.has(frag)) seen.set(frag, new Set());
      seen.get(frag).add(f);
    }
  }
  for (const [frag, fsSet] of seen) if (fsSet.size > 1) out.push(`重复片段「${frag.slice(0, 16)}…」@${[...fsSet].map((x) => x.split("/").pop()).join(",")}`);
  return out.slice(0, 8);
}

gate("G15", "依赖方向：内核不得 import 外层", () => {
  const kernel = /^(backend\/lib\/(aggregate|integrity|paths)\.js|frontend\/js\/core\/(derive|dataset|chart-option)\.js)$/;
  const bad = [];
  for (const f of JS_SRC()) {
    if (!kernel.test(f)) continue;
    const src = read(f) || "";
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (/^frontend\/js\/(app|ui)\//.test(to) || /^backend\/(server|lib\/(fetchers|store))/.test(to)) bad.push(`${f} → ${to}`);
    }
  }
  return { ok: !bad.length, detail: bad.length ? `内核反向依赖：${bad.join("; ")}` : "内核零反向依赖（纯函数层不 import I/O 层）" };
});

gate("G16", "管道完整性（五态记录）", async () => {
  const dbm = await import(pathToFileURL(P("backend/lib/db.js")).href);
  const fails = [];
  const inds = walk("indicators", /\.json$/).map((f) => JSON.parse(read(f)));
  const stages = dbm.STAGES;
  for (const c of inds) {
    const run = dbm.lastRun(c.id);
    if (!run) {
      fails.push(`${c.id}: 没有运行记录`);
      continue;
    }
    const got = (run.stages || []).map((x) => x.stage).sort().join(",");
    const want = [...stages].sort().join(",");
    if (got !== want) fails.push(`${c.id}: 五态不全（${got || "无"}，须 ${want}）`);
    const illegal = (run.stages || []).filter((x) => !dbm.STAGE_STATUSES.includes(x.status));
    if (illegal.length) fails.push(`${c.id}: 出现非法状态 ${illegal.map((x) => x.status).join(",")}`);
    if (!dbm.RUN_STATUSES.includes(run.status)) fails.push(`${c.id}: 运行状态非法 ${run.status}`);
  }
  const pol = dbm.lastRun("policy-us");
  if (!pol) fails.push("policy-us: 政策事件刷新没有运行记录（写路径绕过五态）");
  else if ((pol.stages || []).length !== stages.length) fails.push(`policy-us 五态不全（${(pol.stages || []).length}/${stages.length}）`);
  return { ok: !fails.length, detail: fails.join("; ") || `${inds.length} 个序列 + 政策事件每轮都留 plan/fetch/validate/correct/commit 五态，状态取值全部合法` };
});

gate("G17", "插件即测：provider 必须带真实响应留档", () => {
  const ids = providerList.map((p) => p.id);
  if (!ids.length) return { ok: false, detail: "BLOCKED：provider 注册表为空（目录自动发现未落地）" };
  if (!exists("fixtures/_record.json")) return { ok: false, detail: "BLOCKED：fixtures/_record.json 缺失（先 node tools/record-fixtures.mjs）" };
  const rec = JSON.parse(read("fixtures/_record.json"));
  const exempt = new Set([].concat(
    JSON.parse(read("specs/degraded-sources.json") || "[]").map((x) => x.slug),
    JSON.parse(read("specs/rejected-sources.json") || "[]").map((x) => x.slug)
  ));
  const missing = ids.filter((id) => !exists("fixtures/" + id + ".fixture.json") && !exempt.has(id));
  const lazy = ids.filter((id) => exempt.has(id) && !exists("fixtures/" + id + ".fixture.json"));
  const stale = rec.results.filter((r) => r.ok && r.rows === 0 && !String(read("fixtures/" + r.id + ".fixture.json") || "").includes("\"rows\"")).map((r) => r.id);
  const fails = [];
  if (missing.length) fails.push("缺留档且未在降级/拒绝清单登记：" + missing.join(","));
  if (stale.length) fails.push("留档为空响应：" + stale.join(","));
  return { ok: !fails.length, detail: fails.join("; ") || ids.length + " 个 provider 中 " + (ids.length - lazy.length) + " 个有真实响应留档，" + lazy.length + " 个按 specs/degraded-sources.json 记录的上限豁免（" + lazy.join(",") + "）" };
});

gate("G18", "单实例守卫", () => {
  const panel = "frontend/js/core/chart-panel.js";
  if (!exists(panel)) return { ok: false, detail: "BLOCKED：core/chart-panel.js 不存在（fail-closed）" };
  const src = JS_SRC();
  const inits = src.filter((f) => /echarts\.init/.test(read(f) || ""));
  const sets = src.filter((f) => /setOption/.test(read(f) || "") && f !== panel);
  const outside = inits.filter((f) => f !== panel);
  const fails = [];
  if (inits.length !== 1) fails.push(`echarts.init 站点 ${inits.length}（须 1）: ${inits}`);
  if (outside.length) fails.push(`init 不在唯一出口：${outside}`);
  if (sets.length) fails.push(`setOption 越界：${sets}`);
  return { ok: !fails.length, detail: fails.join("; ") || `唯一出口 ${panel}；init 1 处、setOption 0 越界` };
});

gate("G19", "重复指纹守卫", () => {
  const files = graphicsFiles();
  if (!files.length) return { ok: false, detail: "BLOCKED：图形层文件清单为空" };
  const dups = [];
  for (const f of files) {
    const src = read(f) || "";
    const fns = functionsOf(src);
    for (let a = 0; a < fns.length; a++)
      for (let b = a + 1; b < fns.length; b++) if (fns[a].sk === fns[b].sk) dups.push(`${f}: ${fns[a].name} ≡ ${fns[b].name}（骨架逐字同构）`);
    for (const d of objectLiteralDupes(src)) dups.push(`${f}: 对象字面量键集重合 ${d}`);
  }
  // 共享骨架抽成 base() 后，正则就看不见重复了 —— 于是直接钉住「每个事实只写一次」本身
  const types = stripComments(read("frontend/js/core/chart-types.js") || "");
  const singleSite = [
    [/\byAxisIndex:/g, 1, "轴索引"],
    [/name:\s*layer\.label/g, 1, "序列名来源"],
    [/\bz:\s*style\.z/g, 1, "层叠顺序"],
  ];
  for (const [re, max, label] of singleSite) {
    const n = COUNT(types, re);
    if (n > max) dups.push(`chart-types.js: ${label} 写了 ${n} 处（须 1，抽进 base()）`);
  }
  const across = crossFileDupes(files);
  return { ok: !dups.length && !across.length, detail: [...dups, ...across].join("; ") || `图形层 ${files.length} 文件无同构函数/重复对象；轴索引与序列名各 1 处` };
});

function crossFileDupes(files) {
  const out = [];
  const bySkeleton = new Map();
  for (const f of files) for (const fn of functionsOf(read(f) || "")) {
    if (!bySkeleton.has(fn.sk)) bySkeleton.set(fn.sk, []);
    bySkeleton.get(fn.sk).push({ f: f.split("/").pop(), name: fn.name });
  }
  for (const [sk, sites] of bySkeleton) if (new Set(sites.map((s) => s.f)).size > 1 && sk.length > 300) out.push(`跨文件同构：${sites.map((s) => `${s.f}#${s.name}`).join(",")}`);
  return out;
}

gate("G20", "注册表键集一致", async () => {
  if (REG.error) return { ok: false, detail: `BLOCKED：注册表模块无法在 Node 下加载（${REG.error}）` };
  const specs = walk("charts", /\.json$/);
  if (!specs.length) return { ok: false, detail: "BLOCKED：charts/ 无 spec（fail-closed）" };
  const used = { recipe: new Set(), resolve: new Set(), columns: new Set() };
  for (const f of specs) {
    const s = JSON.parse(read(f));
    for (const l of s.layers || []) {
      if (l.recipe) used.recipe.add(l.recipe);
      for (const r of l.recipeBy || []) used.recipe.add(r.recipe);
    }
    for (const a of Object.values(s.axes || {})) used.resolve.add(a.resolve || "shared");
    for (const c of s.tooltip?.columns || []) used.columns.add(c);
  }
  // 图形配方也可以由指标配置声明（gold-overlay 的层不写 recipe），这些同样算「已被使用」
  for (const f of walk("indicators", /\.json$/)) {
    const c = JSON.parse(read(f));
    if (c.recipe) used.recipe.add(c.recipe);
  }
  const recipes = new Set(REG.recipes);
  // 图形配方现在可以由 semantics 按「量纲 × 角色 × 粒度」推导，spec 里不再逐页写死；
  // 因此「已使用」必须按当前指标集合把语义默认值全部算出来，否则语义表会变成门禁看不见的死角。
  const sem = await import(pathToFileURL(P("backend/lib/semantics.js")).href);
  for (const fp of walk("indicators", /\.json$/)) {
    const c = JSON.parse(read(fp));
    const kind = sem.kindOf(c);
    for (const role of ["primary", "overlay", "named", "picked"]) for (const g of ["day", "week", "month"]) used.recipe.add(sem.defaultRecipe(kind, role, g));
  }
  // tooltip 的 policy 列不经 spec 声明：装配核在面板有政策事件时自动追加（全站必画是产品指令，
  // 页面不能靠「这列我不写」把它关掉）。所以证据取装配核的追加语句本身，而不是 panels 的字段名。
  const appendCol = /ctx\.hasPolicy \? \[\.\.\.declared, "(\w+)"\]/.exec(read("frontend/js/core/chart-option.js") || "");
  if (appendCol) used.columns.add(appendCol[1]);
  const fails = [];
  if (!appendCol) fails.push("装配核不再自动追加政策事件 tooltip 列（全站必画被削弱）");
  for (const r of used.recipe) if (!recipes.has(r)) fails.push(`spec/指标声明的配方未注册：${r}`);
  for (const r of recipes) if (!used.recipe.has(r)) fails.push(`注册表死键（无 spec 使用）：${r}`);
  for (const c of used.columns) if (!REG.columns.includes(c)) fails.push(`tooltip 列未实现：${c}`);
  for (const c of REG.columns) if (!used.columns.has(c)) fails.push(`tooltip 列死键：${c}`);
  for (const r of used.resolve) if (!["shared", "independent"].includes(r)) fails.push(`resolve 取值非法：${r}`);
  return {
    ok: !fails.length,
    detail: fails.join("; ") || `${specs.length} 份 spec：配方 ${used.recipe.size}/${recipes.size} 双向相等，tooltip 列 ${used.columns.size}/${REG.columns.length} 双向相等`,
  };
});

gate("G21", "渲染层零算数·零 hex", () => {
  const kernel = ["frontend/js/core/chart-option.js", "frontend/js/core/chart-types.js", "frontend/js/core/chart-panel.js"];
  if (!kernel.every((f) => exists(f))) return { ok: false, detail: `BLOCKED：${kernel.filter((f) => !exists(f)).join(",")} 尚未落地` };
  const fails = [];
  for (const f of kernel) {
    const src = read(f);
    const hex = COUNT(src, HEX);
    if (hex) fails.push(`${f.split("/").pop()} hex ${hex}`);
    const ops = [...src.matchAll(/\/ 1e\d|Math\.min\(|Math\.max\(|\.findIndex\(|\.sort\(\)|\* 1e\d/g)].map((m) => m[0]);
    if (ops.length) fails.push(`${f.split("/").pop()} 内联整形 ${ops.length}：${[...new Set(ops)].join(",")}`);
  }
  const layerHex = graphicsFiles().reduce((a, f) => a + COUNT(read(f), HEX), 0);
  const r = ratchet("graphics_hex", layerHex);
  if (!r.ok) fails.push(r.detail);
  return { ok: !fails.length, detail: fails.join("; ") || `渲染核零 hex 零整形；图形层 hex ${layerHex}` };
});

gate("G22", "页面即数据（零改主程序）", () => {
  const specs = walk("charts", /\.json$/);
  if (!specs.length) return { ok: false, detail: "BLOCKED：无 charts/ spec" };
  const app = read("frontend/js/app.js") || "";
  const ids = new Set(specs.map((f) => path.basename(f, ".json")));
  const leaked = [...ids].filter((id) => app.includes(`"${id}"`) || app.includes(`'${id}'`));
  const mountLiterals = [...app.matchAll(/getElementById\("([\w-]*chart[\w-]*)"\)/g)].map((m) => m[1]);
  const fails = [];
  if (leaked.length) fails.push(`app.js 硬编码 spec id：${leaked}`);
  if (mountLiterals.length > specs.length) fails.push(`app.js 逐个点名图表容器 ${mountLiterals.length} 处（须由 spec 派生）`);
  if (exists("charts/probe.spec.json")) fails.push("遗留实验 spec 未清理");
  return { ok: !fails.length, detail: fails.join("; ") || `${specs.length} 份 spec 驱动页面；app.js 零 spec 字面量` };
});

gate("G23", "单一文案与区间引擎", () => {
  const files = graphicsFiles();
  const src = files.map((f) => read(f) || "").join("\n");
  const fmtFiles = files.filter((f) => /formatter:/.test(read(f) || ""));
  const tips = COUNT(src, /\btooltip:\s/g);
  const axisTrigger = COUNT(src, /trigger:\s*"axis"/g);
  const sv = COUNT(src, /startValue/g);
  const slider = COUNT(src, /fillerColor/g);
  const lets = COUNT(read("frontend/js/core/chart-panel.js") || "", /^let /gm);
  const old = present("frontend/js/chart.js").length;
  const fails = [];
  if (fmtFiles.length !== 1) fails.push(`含 formatter 的图形文件 ${fmtFiles.length} 个（须 1：${fmtFiles.join(",") || "无"}）`);
  if (tips !== 1 || axisTrigger !== 1) fails.push(`tooltip 构造点 ${tips}/axis 触发 ${axisTrigger}（各须 1）`);
  if (sv > 2) fails.push(`startValue 构造 ${sv}（须 ≤2，同一函数 inside+slider）`);
  if (slider !== 1) fails.push(`slider 样式对象 ${slider}（须 1）`);
  if (lets) fails.push(`chart-panel 模块级 let ${lets}（须 0，状态迁 store）`);
  if (old) fails.push("frontend/js/chart.js 仍在（三个平行渲染器的宿主，须删除）");
  return { ok: !fails.length, detail: fails.join("; ") || `formatter 文件 1 / tooltip 构造 1 / startValue ${sv} / slider 1 / 模块级 let 0` };
});

gate("G24", "视觉回归基线", () => {
  if (!exists("backend/lib/panels.js")) return { ok: false, detail: "BLOCKED：backend/lib/panels.js 未落地（dataset 无法无头组装）" };
  const manFile = "snapshots/manifest.json";
  if (!exists(manFile)) return { ok: false, detail: "BLOCKED：snapshots/manifest.json 缺失（先 node tools/snapshot.mjs --bless 再 --write）" };
  const man = JSON.parse(read(manFile));
  const fails = [];
  // 基线必须绑在冻结输入上：否则「官方多发布了一天」会被判成渲染回归（本轮红过一次，是判据错，不是代码错）
  if (!exists("snapshots/fixture.json")) return { ok: false, detail: "BLOCKED：缺 snapshots/fixture.json（先 node tools/snapshot.mjs --bless 冻结输入）" };
  const fx = JSON.parse(read("snapshots/fixture.json"));
  const fxDays = (Date.now() - Date.parse(fx.blessedAt)) / 86400000;
  const fxIds = Object.keys(fx.reads || {}).length;
  if (fxIds < 10) fails.push(`冻结输入只覆盖 ${fxIds} 个数据 id，不足以支撑回归基线`);
  if (fxDays > 180) fails.push(`冻结输入已 ${fxDays.toFixed(0)} 天未更新（>180 天须重新 --bless，避免基线与实际数据脱节太久）`);
  if (man.fixture?.reads !== fxIds) fails.push(`manifest 记录的输入数(${man.fixture?.reads})与 fixture 实际(${fxIds})不一致`);

  // 1) 覆盖面：每个（市场 × 有 panel 视图的 spec × 粒度）都必须有快照或有记录在案的原因
  const want = [];
  for (const region of JSON.parse(read("specs/regions.json")).map((r) => r.id)) {
    for (const f of walk("charts", /\.json$/)) {
      const s = JSON.parse(read(f));
      if (s.region && s.region !== region) continue;
      if (!(s.views || []).some((v) => v.projection === "panel")) continue;
      for (const g of man.granularities || []) want.push(`${region}.${s.page || "monitor"}.${s.id}.${g}`);
    }
  }
  const covered = new Set([...man.generated, ...man.skipped.map((x) => x.key)]);
  const missing = want.filter((k) => !covered.has(k));
  if (missing.length) fails.push(`清单未覆盖 ${missing.length} 组：${missing.slice(0, 3).join(",")}`);
  const reasonless = man.skipped.filter((x) => !x.reason);
  if (reasonless.length) fails.push(`跳过但没写原因 ${reasonless.length} 组`);
  // 2) 孤儿：快照文件对应的 spec 已不存在
  const orphan = man.generated.filter((k) => !want.includes(k));
  if (orphan.length) fails.push(`孤儿快照 ${orphan.length}: ${orphan.slice(0, 3).join(",")}`);
  // 3) 内容：直接跑一次比对（不靠人记得跑）
  const r = spawnSync(process.execPath, [P("tools", "snapshot.mjs"), "--check"], { encoding: "utf8", timeout: 180000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split("\n");
  if (r.status !== 0) fails.push(`快照内容漂移：${out.filter((x) => /差异|缺基线/.test(x)).slice(0, 3).join(" | ")}`);
  return {
    ok: !fails.length,
    detail: fails.join("; ") || `${man.generated.length} 份快照绑在冻结输入（${fxIds} 个数据 id，${fxDays.toFixed(1)} 天前 bless）上，与 spec 清单一一对应（跳过 ${man.skipped.length} 份均带原因），内容比对通过`,
  };
});

gate("G25", "政策事件：单一出处、官方证据、全站必画", async () => {
  const fails = [];
  const dbm = await import(pathToFileURL(P("backend/lib/db.js")).href);
  const pol = await import(pathToFileURL(P("backend/lib/policy.js")).href);
  const us = pol.list("us");
  if (!us.length) fails.push("库里没有任何政策事件（官方声明解析未落地或被清空）");
  // 1) 证据链：每条事件必须有官方域名 URL；利率事件必须有原文摘要
  const noUrl = us.filter((e) => !/^https:\/\/(www\.)?federalreserve\.gov\//.test(e.url || ""));
  if (noUrl.length) fails.push(`事件缺官方 URL ${noUrl.length} 条：${noUrl.slice(0, 2).map((e) => e.date).join(",")}`);
  const rateNoQuote = us.filter((e) => !["qt", "qt-slow", "qt-end", "qe"].includes(e.action) && !/^.{20,}$/.test(e.quote || ""));
  const bsWeak = us.filter((e) => ["qt", "qt-slow", "qt-end", "qe"].includes(e.action) && !/(balance sheet|run\u2011?off|reinvestment|\$|cap|holdings|securities|reduc\w*)/i.test(e.quote || ""));
  if (rateNoQuote.length) fails.push(`利率事件缺可核验原文句 ${rateNoQuote.length} 条：${rateNoQuote.slice(0, 2).map((e) => e.date).join(",")}`);
  if (bsWeak.length) fails.push(`缩表/扩表事件的依据句不含资产负债表要素 ${bsWeak.length} 条：${bsWeak.slice(0, 2).map((e) => e.date).join(",")}`);
  // 2) 方向与幅度自洽：降息不得为正、加息不得为负；幅度必须有来源说明
  // 标注密度：缩表/扩表类里程碑应当是稀疏的（一轮周期里几条），若占比过高说明把例行套话当成了动作
  const bsEvents = us.filter((e) => ["qt", "qt-slow", "qt-end", "qe"].includes(e.action));
  const ratio = us.length ? bsEvents.length / us.length : 0;
  if (ratio > 0.2) fails.push(`资产负债表类事件占比 ${(ratio * 100).toFixed(0)}%（>20%）：疑似把例行重申当成新动作，图上会挤满竖线`);
  const dupSameDay = us.filter((e) => e.action === "qt" && us.some((x) => x !== e && x.date === e.date && x.action === "qt"));
  if (dupSameDay.length) fails.push(`同一天多条 qt 事件：${dupSameDay.map((e) => e.date).join(",")}`);
  const signBad = us.filter((e) => (e.action === "cut" && e.deltaBp > 0) || (e.action === "hike" && e.deltaBp < 0));
  if (signBad.length) fails.push(`幅度符号与动作矛盾 ${signBad.length} 条：${signBad.slice(0, 2).map((e) => e.date).join(",")}`);
  // 只有利率动作需要说明幅度来源；缩表/扩表类事件没有 bp 概念
  const noSource = us.filter((e) => ["hike", "cut"].includes(e.action) && !e.deltaSource);
  if (noSource.length) fails.push(`幅度未标注来源（原文/区间推得）${noSource.length} 条`);
  // 3) 前端不得再写一份事件表：出现具体日期字面量即视为分家
  const feFiles = walk("frontend/js", /\.js$/).filter((x) => !x.includes("vendor"));
  const dated = feFiles.filter((x) => /"20\d\d-\d\d-\d\d"|monetary20\d{6}/.test(read(x)));
  if (dated.length) fails.push(`前端写死了政策日期/链接：${dated.join(",")}`);
  // 4) 全站必画：面板数据必须带 policy 与 policyNote 两个字段（缺一即为「有的图画有的图不画」）
  const panelsSrc = read("backend/lib/panels.js") || "";
  if (!/const chartPolicy = /.test(panelsSrc) || !/policy: events/.test(panelsSrc) || !/policyNote: policy\.noteFor/.test(panelsSrc))
    fails.push("panels 未把政策事件与说明成对注入面板数据（chartPolicy 单一出处）");
  if ((panelsSrc.match(/\.\.\.chartPolicy\(region\)/g) || []).length < 3) fails.push("有面板路径没走 chartPolicy（不同视图会画出标注不一致的图）");
  const optSrc = read("frontend/js/core/chart-option.js") || "";
  if (!/function policyMarkLines/.test(optSrc)) fails.push("装配核缺政策竖线实现");
  if ((optSrc.match(/markLine = \{/g) || []).length !== 1) fails.push("markLine 构造点不是唯一（政策线与阈值线必须合成一处）");
  // 5) 跨市场标注必须自报出处，不许静默把美联储事件画在中国图上
  const chart = pol.chartList();
  const cnNote = pol.noteFor("cn", chart);
  if (!chart.length && !cnNote) fails.push("图表标注线既无事件也无说明文字（静默空白）");
  if (chart.length && !chart.some((e) => e.region === "cn") && !cnNote) fails.push("中国市场图上的标注全是他市场事件却没有来源说明");
  if (us.length) {
    const snapFile = "snapshots/us.monitor.main-trend.day.json";
    if (!exists(snapFile)) fails.push("缺快照，无法证明竖线真的画出来了");
    else {
      const snap = JSON.parse(read(snapFile));
      const lines = (snap.option.series[0].markLine?.data || []).filter((d) => d.xAxis !== undefined && d.label);
      if (!lines.length) fails.push("快照里没有政策竖线");
      else if (!lines.some((d) => /加息|降息|按兵不动|缩表|扩表/.test(d.label.formatter || ""))) fails.push("竖线标签缺政策动作文字");
    }
  }
  return {
    ok: !fails.length,
    detail: fails.join("; ") || `政策事件 ${us.length} 条全部带官方 URL 与原文摘要，方向自洽；前端零日期字面量；竖线已进快照（加息/降息/缩表/扩表可辨）`,
  };
});
gate("G7", "端到端实测（浏览器判据）", () => {
  if (!exists("specs/evidence-browser.json")) return { ok: false, detail: "BLOCKED-BROWSER：没有浏览器实测判据（须用 browser-use 实跑并落盘 specs/evidence-browser.json）" };
  const ev = JSON.parse(read("specs/evidence-browser.json"));
  const ageDays = (Date.now() - Date.parse(ev.at)) / 86400000;
  const fails = [];
  if (!(ev.cases || []).length) fails.push("判据里没有用例");
  const painted = (ev.cases || []).filter((c) => c.canvas && c.canvas !== "无").length;
  if (painted < 4) fails.push("实跑出图的页面只有 " + painted + " 个（须 ≥4：监控台/报表/黄金/中国）");
  if ((ev.consoleErrors || 0) !== 0) fails.push("浏览器控制台有 " + ev.consoleErrors + " 条错误");
  const overlay = (ev.cases || []).find((c) => c.seriesAfter != null);
  if (!overlay || overlay.seriesAfter <= overlay.seriesBefore) fails.push("没有「多参数叠加」的实测证据（series 数须因叠加而增加）");
  if (ageDays > 3) fails.push("判据已过期 " + ageDays.toFixed(1) + " 天（>3 天须重跑）");
  return { ok: !fails.length, detail: fails.join("; ") || (ev.cases || []).length + " 个用例实跑出图（" + painted + " 张画布有尺寸），叠加后 series 由 " + overlay.seriesBefore + " 增至 " + overlay.seriesAfter + "，控制台 0 错误；判据 " + ageDays.toFixed(2) + " 天前" };
});

gate("G26", "区间参数单一 owner（presets.json）", () => {
  const fails = [];
  // 预设 id / 天数 / 粒度枚举只允许在 charts/presets.json 声明；JS 里出现即为第二份副本
  const PATTERNS = [
    [/\b(?:2W|1M|3M|6M|1Y|3Y|5Y|10Y|ALL)\b/, "预设 id 字面量"],
    [/\bdays\s*:\s*\d+/, "区间天数定义"],
    [/\[\s*["']day["']\s*,\s*["']week["']\s*,\s*["']month["']\s*\]/, "粒度枚举副本"],
  ];
  // provider 里的 "1Y"（LPR 期限）、"100"（CDS 票息）等是业务参数，不是区间预设；
  // 区间语义只存在于装配层（backend/lib、frontend/js/core、frontend/js/views、frontend/js/ui）。
  const scope = JS_SRC().filter((f) => /^backend\/lib\//.test(f) || /^backend\/server\.js$/.test(f) || /^frontend\/js\//.test(f));
  for (const f of scope) {
    const src = read(f);
    if (!src) continue;
    // 去掉注释与字符串后检查？注释里出现不算产物；这里只查代码行（去行注释）
    const code = src.split("\n").filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join("\n");
    for (const [re, label] of PATTERNS) if (re.test(code)) fails.push(`${f} 出现${label}`);
  }
  // owner 自身：id 唯一 + 每个条目必须有 days（ALL 允许 null）
  const presets = JSON.parse(read("charts/presets.json"));
  for (const key of ["standard", "long"]) {
    const ids = (presets[key] || []).map((p) => p.id);
    if (new Set(ids).size !== ids.length) fails.push(`presets.json ${key} 存在重复 id`);
  }
  if (!presets.defaults?.preset || !presets.defaults?.granularity) fails.push("presets.json 缺 defaults.preset/granularity 唯一默认声明");
  if (!(presets.granularities || []).length) fails.push("presets.json 缺 granularities 注册表");
  // 装配点必须复用唯一判定函数
  if (/\]\s*\.includes\(params\.granularity\)/.test(read("backend/lib/panels.js") || "")) fails.push("panels.js 仍有本地粒度白名单副本");
  if (/spec\.defaultPreset\s*\|\|\s*["']/.test(read("backend/lib/panels.js") || "")) fails.push("panels.js 仍有本地 defaultPreset 回退副本");
  return {
    ok: !fails.length,
    detail: fails.join("; ") || "区间 id/天数/粒度枚举只在 charts/presets.json 声明；前后端共用 defaultPresetOf/normalizeGranularity；owner 内 id 唯一",
  };
});

gate("G27", "图幅样式单一 owner（tokens.css）", () => {
  const fails = [];
  const tokens = read("frontend/css/tokens.css") || "";
  const layout = read("frontend/css/layout.css") || "";
  // 图幅高度令牌只在 tokens.css 定义；layout.css 只能消费 var()，不得再赋值
  for (const t of ["chart-h", "chart-h-mid", "chart-h-compact"]) {
    const defs = (tokens.match(new RegExp(`--${t}\\s*:`, "g")) || []).length;
    if (defs < 1) fails.push(`tokens.css 缺 --${t} 定义`);
    // layout.css 里 `--chart-h: var(--chart-h-compact)` 是 size 类的转发映射，不是第二份样式事实；
    // 只有赋予具体尺寸值（px/clamp/dvh）才算重复 owner。逐声明解析，避免子串误命中。
    const decls = [...layout.matchAll(new RegExp(`--${t}\\s*:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
    if (decls.some((v) => !/^var\(/.test(v))) fails.push(`layout.css 重复定义 --${t} 的具体值（应只在 tokens.css 声明）`);
  }
  // 渲染核不得出现裸样式数字（须走 theme 令牌）
  for (const f of ["frontend/js/core/chart-option.js", "frontend/js/core/chart-types.js"]) {
    const src = read(f) || "";
    for (const [re, label] of [
      [/fontSize\s*:\s*\d/, "fontSize 字面量"],
      [/itemGap\s*:\s*\d/, "itemGap 字面量"],
      [/borderWidth\s*:\s*1\.6/, "描边宽度字面量"],
      [/barWidth\s*:\s*\d/, "柱宽字面量"],
      [/barMinHeight\s*:\s*\d/, "柱高下限字面量"],
    ]) if (re.test(src)) fails.push(`${f} 仍有${label}`);
  }
  // spec 的 $token 引用必须都能在 tokens.css 找到定义
  for (const f of walk("charts", /\.json$/)) {
    const src = read(f) || "";
    for (const m of src.matchAll(/\$([a-z][\w-]*)/g)) {
      if (!new RegExp(`--${m[1]}\\s*:`).test(tokens)) fails.push(`${f} 引用不存在的令牌 --${m[1]}`);
    }
    // size 枚举只能是 CSS 已实现的 class
    for (const m of src.matchAll(/"size"\s*:\s*"([^"]+)"/g)) {
      if (!new RegExp(`\\.chart--${m[1]}\\b`).test(layout)) fails.push(`${f} 的 size "${m[1]}" 无对应 CSS class`);
    }
  }
  // theme.js 消费的 chart 令牌都必须存在
  const theme = read("frontend/js/core/theme.js") || "";
  for (const m of theme.matchAll(/num\("([\w-]+)"\)/g)) {
    if (!new RegExp(`--${m[1]}\\s*:`).test(tokens)) fails.push(`theme.js 读取的 --${m[1]} 未在 tokens.css 定义`);
  }
  return {
    ok: !fails.length,
    detail: fails.join("; ") || "图幅高度/字号/线宽/柱宽只在 tokens.css 声明；渲染核零裸样式字面量；spec 的 $token 与 size 均可解析",
  };
});

// 全屏下方板被裁 + 滑块划不动的同类根治：body grid 的隐式行会被内容撑高，
// .main 的 overflow-y 只在被撑高的容器里滚，超出 body 视口的部分永远不可达。
gate("G28", "滚动容器锁定视口（全屏裁切同类根治）", () => {
  const fails = [];
  const layout = read("frontend/css/layout.css") || "";
  const bodyRule = layout.match(/(?:^|\n)\s*body\s*\{([^}]*)\}/);
  if (!bodyRule) fails.push("layout.css 找不到 body 规则");
  else {
    const d = bodyRule[1];
    if (!/display\s*:\s*grid/.test(d)) fails.push("body 必须是 grid 容器");
    if (!/grid-template-rows\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/.test(d))
      fails.push("body 缺 grid-template-rows: minmax(0,1fr)（隐式行被内容撑高，滚动容器超出视口）");
  }
  const mainRule = layout.match(/(?:^|\n)\s*\.main\s*\{([^}]*)\}/);
  if (!mainRule) fails.push("layout.css 找不到 .main 规则");
  else {
    const d = mainRule[1];
    if (!/min-height\s*:\s*0/.test(d)) fails.push(".main 缺 min-height:0（grid item 无法收缩）");
    if (!/overflow-y\s*:\s*auto/.test(d)) fails.push(".main 缺 overflow-y:auto（页面无法滚动）");
  }
  // 高卡片吸附顶部后底部永远在视口外，纵向 scroll-snap 一律禁止
  if (/scroll-snap-type\s*:\s*y/.test(layout)) fails.push("出现纵向 scroll-snap（会裁掉高卡片底部）");
  return {
    ok: !fails.length,
    detail: fails.join("; ") || "body 行高锁定视口；.main 可收缩且自身滚动；无纵向 scroll-snap",
  };
});

// ---------- 执行 ----------
const results = [];
for (const g of gates) {
  if (only.length && !only.includes(g.id)) continue;
  let r;
  try {
    r = await g.fn();
  } catch (e) {
    r = { ok: false, detail: `门禁自身异常（按红处理）：${e.message}` };
  }
  results.push({ id: g.id, name: g.name, status: r.ok ? "GREEN" : r.detail.startsWith("BLOCKED") ? "RED-BLOCKED" : "RED", detail: r.detail });
}
if (record) {
  for (const [k, v] of Object.entries(ratchets)) if (v.observed <= (v.baseline ?? v.observed)) baselines[k] = v.observed;
  fs.writeFileSync(P(BASELINE_FILE), JSON.stringify(baselines, null, 2) + "\n");
  console.log(`已记录基线：${JSON.stringify(baselines)}`);
}
const red = results.filter((r) => r.status !== "GREEN");
if (asJson) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) console.log(`${r.status.padEnd(12)} ${r.id.padEnd(4)} ${r.name}\n${"".padEnd(15)}${r.detail}`);
  console.log(`\n门禁 ${results.length} 条：GREEN ${results.length - red.length} / RED ${red.length}`);
  console.log(`棘轮：${JSON.stringify(Object.fromEntries(Object.entries(ratchets).map(([k, v]) => [k, v.observed])))}`);
}
process.exit(red.length ? 1 : 0);
