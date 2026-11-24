// 面板装配：charts/*.json（声明）× 已入库数据（store）→ 对齐后的 dataset 契约。
// 日期并集、跨序列对齐、单位换算都在这里一次做完；前端渲染层不再算数（G21 的落点）。
// 数据红线不变：官方未发布 = null（不插值）、存疑只标记、改值必带 {from,to,by}、单源必须显式声明。
import fs from "node:fs";
import path from "node:path";
import { CHARTS_DIR, SPECS_DIR } from "./paths.js";
import { loadIndicators } from "./indicators.js";
import { loadSheets } from "./sheets.js";
import { loadSummaries } from "./summaries.js";
import { aggregate } from "./aggregate.js";
import { kindOf, defaultRecipe, roleOf } from "./semantics.js";
import * as store from "./store.js";
import * as policy from "./policy.js";

// 标注线与来源说明成对产生：一次取全站事件，两处读同一个数组（不再各调一次 list）
const chartPolicy = (region) => {
  const events = policy.chartList();
  return { policy: events, policyNote: policy.noteFor(region, events) };
};

export function loadCharts(region) {
  if (!fs.existsSync(CHARTS_DIR)) return [];
  return fs
    .readdirSync(CHARTS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "presets.json")
    .map((f) => JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, f), "utf8")))
    .filter((s) => !s.region || !region || s.region === region)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// pickFrom：一组成员条件只有一个 owner（导航列表与主图共用 main-trend 的 pick，不在两处各写一遍）
export function pickOf(spec, specs) {
  if (spec.pick) return spec.pick;
  if (spec.pickFrom) {
    const src = specs.find((s) => s.id === spec.pickFrom);
    if (!src) throw new Error(`spec ${spec.id} 的 pickFrom 指向不存在的 ${spec.pickFrom}`);
    return src.pick;
  }
  return null;
}

export function loadRegions() {
  const fp = path.join(SPECS_DIR, "regions.json");
  if (!fs.existsSync(fp)) throw new Error("specs/regions.json 缺失：市场清单与官方来源署名必须有唯一出处");
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

export function loadPresets() {
  const fp = path.join(CHARTS_DIR, "presets.json");
  if (!fs.existsSync(fp)) throw new Error("charts/presets.json 缺失：区间预设必须集中声明，不得散写在前端");
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

// pick 谓词只认数据字段，且只有一种语法：
//   {surface:"gold"} 相等；{unit:["%","bp"]} 属于；{notSurface:["strip","gold"]} 不属于；{precision:{gt:2}} 数值比较。
// 「新增一类图/页」= 改这份数据，不改代码。
export function matches(cfg, pick) {
  return Object.entries(pick || {}).every(([k, v]) => {
    const neg = /^not[A-Z]/.test(k);
    const key = neg ? k[3].toLowerCase() + k.slice(4) : k;
    const actual = cfg[key];
    if (neg) return Array.isArray(v) ? !v.includes(actual) : actual !== v;
    if (v && typeof v === "object") {
      if (v.oneOf) return v.oneOf.includes(actual);
      if (v.gt != null) return Number(actual) > v.gt;
      if (v.lt != null) return Number(actual) < v.lt;
      return false;
    }
    if (Array.isArray(v)) return v.includes(actual);
    return actual === v;
  });
}

function recipeFor(layerSpec, ctx, cfg) {
  if (layerSpec.recipe) return layerSpec.recipe;
  const by = (layerSpec.recipeBy || []).find((r) => matches({ granularity: ctx.granularity, freq: ctx.freq }, r.when));
  if (by) return by.recipe;
  if (cfg?.recipe) return cfg.recipe;
  // 到这里不再抛错：图形语义由「量纲 × 层角色 × 粒度」在 semantics 一处推导（C-6）。
  // spec 或指标想要别的样子就显式声明，声明即优先级，不允许把同一件事写进每个页面。
  return defaultRecipe(kindOf(cfg || {}), roleOf(layerSpec), ctx.granularity);
}

// styleBy：多条规则可叠加合并（月频用矩形点、特定序列另给面积/柱宽），后匹配的覆盖先匹配的
function styleFor(layerSpec, ctx, cfg) {
  const keys = { granularity: ctx.granularity, freq: ctx.freq, id: cfg?.id, unit: cfg?.unit, recipe: ctx.recipe };
  let style = {};
  for (const rule of layerSpec.styleBy || []) if (matches(keys, rule.when)) style = { ...style, ...rule.style };
  return { ...(layerSpec.style || {}), ...style };
}

function axisKeyFor(cfg, layerSpec, spec) {
  if (layerSpec.axis) return layerSpec.axis;
  // 序列自带的轴归属优先（axisGroup 是配置声明），其次才按 spec 的 unit 规则归类
  if (cfg.axisGroup && spec.axes?.[cfg.axisGroup]) return cfg.axisGroup;
  const rule = (spec.axisBy || []).find((r) => matches(cfg, r.when));
  if (rule) return rule.axis;
  const fallback = Object.keys(spec.axes || {})[0];
  if (!fallback) throw new Error(`spec ${spec.id} 未声明 axes`);
  return fallback;
}

function layerFromIndicator(cfg, granularity, read = store.read) {
  const d = read(cfg.id);
  if (!d?.points?.length) return { id: cfg.id, error: "数据未入库", ready: false };
  const rows = aggregate(d.points, granularity);
  const isDay = granularity === "day";
  return {
    id: cfg.id,
    ready: true,
    name: cfg.name,
    unit: cfg.unit,
    precision: cfg.precision,
    hue: cfg.hue,
    posColor: cfg.posColor,
    negColor: cfg.negColor,
    invert: !!cfg.invert,
    freq: cfg.freq || "day",
    updatedAt: d.updatedAt,
    legs: d.legs || null,
    latest: rows[rows.length - 1] || null,
    values: rows.map((p) => (isDay ? p.v : p.c)),
    ohlc: isDay ? null : rows.map((p) => [p.o, p.c, p.l, p.h]),
    counts: isDay ? null : rows.map((p) => p.n),
    flags: rows.map((p) => ({ ok: p.ok ?? null, suspect: p.suspect ?? null, corrected: p.corrected ?? null })),
    dates: rows.map((p) => p.date),
    validation: d.validation,
    integrity: d.integrity ? { verdict: d.integrity.verdict, counts: d.integrity.counts, thresholds: d.integrity.thresholds, notes: d.integrity.notes } : null,
    meta: {
      source: cfg.source || cfg.en,
      en: cfg.en,
      formula: cfg.formula,
      description: cfg.description,
      sourceNote: cfg.sourceNote,
      checkKind: cfg.checkKind,
      publication: cfg.publication,
      zones: cfg.zones,
      integrityRange: d.integrity?.thresholds?.range ?? null,
      singleSource: !!cfg.singleSource || !d.validation?.checked,
    },
  };
}

function layerFromSheet(sheetCfg, layerSpec, read = store.read) {
  const d = read(`sheet-${sheetCfg.id}`);
  if (!d?.history?.length) return { id: sheetCfg.id, error: "报表数据未入库", ready: false };
  const f = layerSpec.rescale || 1;
  return {
    id: sheetCfg.id,
    ready: true,
    name: layerSpec.name || sheetCfg.name || "总资产",
    unit: layerSpec.unit || " 万亿美元",
    precision: layerSpec.precision ?? 3,
    hue: layerSpec.hue || sheetCfg.hue,
    freq: "week",
    updatedAt: d.updatedAt,
    latest: { date: d.asOf, v: d.total * f },
    values: d.history.map((p) => p.v * f),
    dates: d.history.map((p) => p.d),
    ohlc: null,
    counts: null,
    flags: d.history.map((p) => ({ ok: p.ok ?? null, suspect: null, corrected: null })),
    validation: d.validation,
    integrity: null,
    meta: {
      source: "Federal Reserve H.4.1",
      sourceNote: layerSpec.sourceNote || "FRED WALCL · 与理事会 H.4.1 交叉验证",
      publication: sheetCfg.publication,
      singleSource: false,
    },
  };
}

// 一组成员（nav / tiles 投影用）：只回配置与状态摘要，不搬运序列
function membersOf(spec, specs, region, read = store.read) {
  const pick = pickOf(spec, specs);
  const list = loadIndicators(region).filter((c) => matches(c, pick));
  return list.map((c) => {
    const d = read(c.id);
    return {
      ...c,
      status: d?.points?.length
        ? {
            ready: true,
            updatedAt: d.updatedAt,
            latest: d.points[d.points.length - 1],
            tail: d.points.slice(-30).map((p) => ({ d: p.d, v: p.v })),
            validation: d.validation,
            integrity: d.integrity ? { verdict: d.integrity.verdict, counts: d.integrity.counts } : null,
          }
        : { ready: false },
    };
  });
}

// 页面清单同样由 spec 派生：新增一页 = 写一份 charts/*.json，PageNav 自动出现。
// updatedAt 也在这一处算：导航不再向每个数据端点各问一次。
export function pagesOf(region) {
  const specs = loadCharts(region).slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.id).localeCompare(String(b.id)));
  const byPage = new Map();
  for (const s of specs) {
    if (!applies(s, specs, region)) continue;
    const id = s.page || "monitor";
    if (!byPage.has(id)) byPage.set(id, []);
    byPage.get(id).push(s);
  }
  const indicators = loadIndicators(region);
  const summaries = loadSummaries(region);
  const out = [];
  for (const [id, pageSpecs] of byPage) {
    const voice = pageSpecs.find((s) => s.navLabel) || pageSpecs[0];
    const stamps = [];
    const hints = [];
    // 导航提示回的是数据（kind + 原值），单位换算与措辞由前端 hintText 单一 owner 负责
    for (const s of pageSpecs) {
      if (s.sheet) {
        const d = store.read(`sheet-${s.sheet}`);
        if (d?.updatedAt) stamps.push(d.updatedAt);
        if (d?.total) hints.push({ kind: "trillion", value: d.total, note: "H.4.1" });
      }
      if ((s.needs || []).includes("summaries")) {
        let rows = 0;
        for (const cfg of summaries) {
          const d = store.read(`summary-${cfg.id}`);
          if (d?.updatedAt) stamps.push(d.updatedAt);
          rows += d?.rows?.length || 0;
        }
        if (rows) hints.push({ kind: "count", value: rows, note: "官方双源" });
      }
      let lastDate = "";
      for (const c of indicators.filter((x) => matches(x, pickOf(s, specs)))) {
        const d = store.read(c.id);
        if (d?.updatedAt) stamps.push(d.updatedAt);
        const ld = d?.points?.[d.points.length - 1]?.d || "";
        if (ld > lastDate) lastDate = ld;
      }
      if (lastDate) hints.push({ kind: "date", value: lastDate });
    }
    out.push({ id, label: voice?.navLabel || voice?.title || id, sub: voice?.navSub || "", hint: hints[0] || null, updatedAt: stamps.sort().pop() || null });
  }
  return out;
}

export function viewsOf(spec) {
  return (spec.views || []).filter((v) => v && v.container && v.projection);
}

// 一个页面 = 一组视图（views）。新增一页只写 charts/*.json，主程序与渲染层都不改。
// spec 是否适用于该市场：本页在该市场一个序列都没有，就不该出现在导航里（也不该报错）
export function applies(spec, specs, region) {
  if (spec.sheet) return loadSheets(region).some((s) => s.id === spec.sheet);
  if ((spec.needs || []).includes("summaries")) return loadSummaries(region).length > 0;
  const pick = pickOf(spec, specs);
  if (!pick) return true;
  return loadIndicators(region).some((c) => matches(c, pick));
}

export function buildPage(pageId, params, read = store.read) {
  const region = params.region || "us";
  const specs = loadCharts(region)
    .slice()
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.id).localeCompare(String(b.id)));
  const onPage = specs.filter((s) => (s.page || "monitor") === pageId && applies(s, specs, region));
  const views = [];
  const needs = new Set(["series"]);
  for (const spec of onPage) {
    for (const n of spec.needs || []) needs.add(n);
    for (const v of viewsOf(spec)) {
      const base = { ...v, specId: spec.id, title: spec.title, empty: spec.empty, specRegion: spec.region || region };
      if (v.projection === "panel") views.push({ ...base, ds: buildPanel(spec.id, params, specs, read), spec });
      else if (v.projection === "tables" && v.source === "sheet") views.push({ ...base, sheet: sheetDetail(findSheet(region, params, spec), params, read) });
      else if (v.projection === "composition") views.push({ ...base, sheet: sheetDetail(findSheet(region, params, spec), params, read) });
      else if (v.projection === "tables" && v.source === "summaries") views.push({ ...base, summaries: summaryItems(region, read) });
      else if (v.projection === "nav" || v.projection === "tiles") views.push({ ...base, members: membersOf(v.pick ? { ...spec, pick: v.pick, pickFrom: null } : spec, specs, region, read) });
      // header / toolbar / desc：前端从本页其他视图（面板数据 + spec）派生，后端不再复制一份口径
      else views.push(base);
    }
  }
  return {
    page: pageId,
    region,
    granularity: params.granularity || "day",
    needs: [...needs],
    presets: loadPresets(),
    views,
    hasSpecs: onPage.length > 0,
  };
}

function findSheet(region, params, spec) {
  const sheets = loadSheets(region);
  return sheets.find((s) => s.id === (params.sheet || spec.sheet)) || sheets[0];
}

function sheetDetail(sheetCfg, params, read = store.read) {
  if (!sheetCfg) return null;
  const d = read(`sheet-${sheetCfg.id}`);
  if (!d) return null;
  return { id: sheetCfg.id, cfg: sheetCfg, ...d };
}

function summaryItems(region, read = store.read) {
  return loadSummaries(region)
    .map((cfg) => {
      const d = read(`summary-${cfg.id}`);
      return d?.rows?.length ? { id: cfg.id, cfg, ...d } : null;
    })
    .filter(Boolean);
}

export function buildPanel(specId, params, specsArg, read = store.read) {
  const spec = (specsArg || loadCharts(params.region || "us")).find((s) => s.id === specId);
  if (!spec) throw new Error(`unknown chart spec: ${specId}`);
  const region = params.region || "us";
  const granularity = ["day", "week", "month"].includes(params.granularity) ? params.granularity : "day";
  const indicators = loadIndicators(region);
  const sheets = loadSheets(region);

  // 只有需要指标序列的层才要求主序列；报表型 spec 不必凑一个指标
  const needsPrimary = (spec.layers || []).some((l) => ["primary", "overlay", "picked"].includes(l.series));
  let primary = null;
  let primaryId = null;
  if (needsPrimary) {
    primaryId = params.primary || pickOne(pickOf(spec, loadCharts(region)), indicators)?.id;
    if (!primaryId)
      return {
        specId,
        region,
        granularity,
        error: `该市场（${region}）下本页面无可用序列`,
        layers: [],
        x: { key: "date", values: [] },
        presets: loadPresets()[spec.presets] || [],
        defaultPreset: spec.defaultPreset || "ALL",
        axes: spec.axes || {},
        annotations: spec.annotations || [],
        ...chartPolicy(region),
        overflow: [],
        limits: spec.limits || {},
      };
    primary = indicators.find((c) => c.id === primaryId);
    if (!primary) throw new Error(`unknown indicator: ${primaryId}`);
  }

  const wanted = [];
  for (const layerSpec of spec.layers || []) {
    if (layerSpec.series === "primary") wanted.push({ layerSpec, cfg: primary });
    else if (layerSpec.series === "overlay")
      for (const id of (params.overlay || "").split(",").filter(Boolean)) {
        const cfg = indicators.find((c) => c.id === id);
        if (cfg && cfg.id !== primary.id) wanted.push({ layerSpec, cfg });
      }
    else if (layerSpec.series === "sheet") {
      const sheet = sheets.find((s) => s.id === (params.sheet || spec.sheet)) || sheets[0];
      if (sheet) wanted.push({ layerSpec, sheetCfg: sheet, cfg: sheet });
    } else if (layerSpec.series === "picked") for (const cfg of pickAll(layerSpec.pick || spec.pick, indicators)) wanted.push({ layerSpec, cfg });
    else {
      const cfg = indicators.find((c) => c.id === layerSpec.series);
      if (cfg) wanted.push({ layerSpec, cfg });
    }
  }
  // 视图模式：spec 可声明多套看法（如「梗差」页的「走廊横线 / SOFR 柱」）。
  // 模式默认「追加」层；声明 replace:true 时改为「替换」基础层——用于互斥看法
  // （如「梗差图」只看梗差、「SOFR 柱」只看 SOFR，二者绝不同屏叠加）。
  // 装配仍走同一条链，不给某个页面写 if。
  const viewModes = spec.viewModes || [];
  const view = [...viewModes.map((m) => m.id), null].includes(params.view) && params.view ? params.view : spec.defaultView || viewModes[0]?.id || null;
  const mode = viewModes.find((m) => m.id === view) || null;
  // 叠加能力独立于视图模式：替换型模式清掉基础层时，overlay 层声明必须保留，
  // 否则「叠加到其他参数图」会在走廊/SOFR 模式下静默失效（本轮实测踩过）。
  const overlaySpecs = (spec.layers || []).filter((l) => l.series === "overlay");
  const baseWanted = wanted.slice();
  if (mode?.replace) wanted.length = 0;
  for (const ml of mode?.layers || (mode?.layer ? [mode.layer] : [])) {
    const cfg = indicators.find((c) => c.id === ml.indicator);
    if (cfg && !wanted.some((w) => w.cfg?.id === cfg.id)) wanted.push({ layerSpec: { series: cfg.id, recipe: ml.recipe, style: ml.style }, cfg });
  }
  for (const layerSpec of mode?.replace ? overlaySpecs : []) {
    for (const id of (params.overlay || "").split(",").filter(Boolean)) {
      const cfg = indicators.find((c) => c.id === id);
      if (cfg && !wanted.some((w) => w.cfg?.id === cfg.id)) wanted.push({ layerSpec, cfg });
    }
  }
  // 替换型模式在该市场没有对应序列时（如中国市场的美联储走廊线）回落到基础层：
  // 视图模式可以换看法，但不能把面板变空白或抛错。
  if (!wanted.length) wanted.push(...baseWanted);
  if (!wanted.length) throw new Error(`spec ${specId} 的 layers 未匹配到任何序列`);

  const limits = spec.limits || {};
  const built = wanted.map((w) => {
    const layer = w.sheetCfg ? layerFromSheet(w.sheetCfg, w.layerSpec, read) : layerFromIndicator(w.cfg, granularity, read);
    const ctx = { granularity, freq: layer.freq };
    const axis = axisKeyFor(w.cfg || {}, w.layerSpec, spec);
    const recipe = recipeFor(w.layerSpec, ctx, w.cfg);
    return { layer, axis, recipe, style: styleFor(w.layerSpec, { ...ctx, recipe }, w.cfg), cfg: w.cfg };
  });

  const ok = built.filter((b) => b.layer.ready);
  if (!ok.length) {
    // 失败也要给完整契约形状：缺 x / axes / policy 时前端会读到 undefined，错误现场反而变成崩溃现场
    return {
      specId,
      region,
      granularity,
      error: built.map((b) => `${b.layer.id}：${b.layer.error}`).join("；"),
      layers: built.map((b) => ({ ...b.layer, axis: b.axis, recipe: b.recipe })),
      x: { key: "date", values: [] },
      axes: spec.axes || {},
      annotations: spec.annotations || [],
      eras: erasOf(spec, params, sheets),
      ...chartPolicy(region),
      presets: loadPresets()[spec.presets] || [],
      defaultPreset: spec.defaultPreset || "ALL",
      overflow: [],
      limits: spec.limits || {},
    };
  }

  const dateSet = new Set();
  for (const b of ok) for (const d of b.layer.dates || []) dateSet.add(d);
  const cats = [...dateSet].sort();

  const layers = ok.map((b) => {
    const byDate = new Map(b.layer.dates.map((d, i) => [d, i]));
    const align = (arr) => cats.map((c) => (byDate.has(c) ? arr[byDate.get(c)] : null));
    return {
      id: b.layer.id,
      name: b.layer.name,
      unit: b.layer.unit,
      precision: b.layer.precision,
      hue: b.layer.hue,
      posColor: b.layer.posColor,
      negColor: b.layer.negColor,
      invert: b.layer.invert,
      freq: b.layer.freq,
      recipe: b.recipe,
      axis: b.axis,
      style: b.style,
      values: align(b.layer.values),
      ohlc: b.layer.ohlc ? align(b.layer.ohlc) : null,
      counts: b.layer.counts ? align(b.layer.counts) : null,
      flags: align(b.layer.flags),
      meta: b.layer.meta,
      validation: b.layer.validation,
      integrity: b.layer.integrity,
      legs: b.layer.legs ?? null,
      updatedAt: b.layer.updatedAt,
      latest: b.layer.latest,
    };
  });

  const shared = countShared(layers, spec);
  const overflow = [];
  if (limits.sharedMax && shared > limits.sharedMax) overflow.push(`同轴叠加 ${shared} 条 > 上限 ${limits.sharedMax}`);
  if (limits.totalMax && layers.length > limits.totalMax) overflow.push(`合计 ${layers.length} 条 > 上限 ${limits.totalMax}`);

  const anchor = layers.find((l) => l.id === primaryId) || layers[0];
  // 轴的小数位与名称由落在该轴上的序列决定（不是第二处硬编码），共享轴取最严精度
  const axesOut = {};
  for (const [k, a] of Object.entries(spec.axes || {})) {
    const ls = layers.filter((l) => l.axis === k);
    axesOut[k] = { ...a, precision: a.precision ?? (ls.length ? Math.max(...ls.map((l) => l.precision ?? 2)) : 2), label: a.label ?? a.unit };
  }
  return {
    specId,
    region,
    granularity,
    title: spec.title,
    anchor: anchor.id,
    updatedAt: layers.map((l) => l.updatedAt).filter(Boolean).sort().pop() || null,
    x: { key: "date", values: cats },
    layers,
    annotations: spec.annotations || [],
    ...chartPolicy(region),
    eras: erasOf(spec, params, sheets),
    axes: axesOut,
    axisBy: spec.axisBy,
    limits: { ...limits, shared },
    overflow,
    presets: loadPresets()[spec.presets] || [],
    defaultPreset: spec.defaultPreset || (loadPresets()[spec.presets] || []).slice(-1)[0]?.id || "ALL",
    primary: primaryId,
    view,
    viewModes,
    // viewGroups：顶层互斥视图组（如「梗差图」/「走廊与SOFR」），由 spec 声明。
    // 前端据此渲染两级切换，组内的模式共享同一组 tabs，不在此写任何页面 if。
    viewGroups: spec.viewGroups || [],
    overlayIds: (params.overlay || "").split(",").filter(Boolean),
    availableOverlays: indicators
      .filter((c) => c.id !== primaryId && (!spec.overlay?.pick || matches(c, spec.overlay.pick)))
      .map((c) => ({ id: c.id, name: c.name, unit: c.unit, precision: c.precision, freq: c.freq, checkKind: c.checkKind, axisGroup: c.axisGroup })),
  };
}

function pickOne(pick, indicators) {
  return pickAll(pick, indicators)[0];
}

function pickAll(pick, indicators) {
  if (!pick) return [];
  return indicators.filter((c) => matches(c, pick));
}

function erasOf(spec, params, sheets) {
  if (!spec.eras) return null;
  if (spec.eras.from === "sheet") {
    const sheet = sheets.find((s) => s.id === (params.sheet || spec.sheet)) || sheets[0];
    return sheet?.eras || null;
  }
  return spec.eras.list || null;
}

// 同轴叠加计数：只为「真比较」计数（同一逻辑轴上的可见层）
function countShared(layers, spec) {
  const per = {};
  for (const l of layers) per[l.axis] = (per[l.axis] || 0) + 1;
  const sharedAxis = Object.entries(spec.axes || {}).filter(([k, a]) => a.resolve !== "independent").map(([k]) => k);
  return Math.max(0, ...sharedAxis.map((k) => per[k] || 0));
}
