// option 装配核：纯函数，输入 spec（声明）× dataset（后端对齐后的数据）× theme（token），输出 ECharts option。
// 本文件不出现字面色值、不做单位换算/对齐运算（theme 与后端 panels 各为其唯一 owner），
// 并且是全站唯一的 tooltip 文案工厂与 dataZoom 构造点。
import { eraOf, fmtVal, zoneOf, zoomWindow } from "./derive.js";
import { alpha, color } from "./theme.js";
import { delta, lastOnOrBefore, nearCategory, visibleLayers } from "./dataset.js";
import { RECIPES } from "./chart-types.js";
import { RECIPE_META } from "./recipe-meta.js";

const AXIS_ORDER = ["left", "right"];

// ---------- 坐标轴解析：唯一决定几根轴、哪一侧、偏移与留白 ----------
// 轴的定义取后端已解析的 ds.axes（小数位与轴名由落在该轴上的序列决定），前端不再回读原始 spec
export function resolveAxes(ds, shown, theme) {
  const keys = Object.keys(ds.axes || {}).filter((k) => shown.some((l) => l.axis === k));
  const seq = { left: 0, right: 0 };
  const extra = { left: 0, right: 0 };
  const index = new Map();
  const yAxis = keys.map((key) => {
    const a = ds.axes[key];
    const side = a.side || AXIS_ORDER[0];
    const idx = seq[side]++;
    extra[side] = idx * theme.axisOffset;
    return {
      type: "value",
      name: a.label || "",
      nameTextStyle: { color: color(a.hue || "muted"), fontSize: 11 },
      inverse: !!a.inverse,
      scale: a.zeroBased !== true,
      min: a.zeroBased === true ? 0 : undefined,
      position: side,
      offset: idx * theme.axisOffset,
      axisLabel: { color: theme.muted, formatter: (v) => `${a.prefix || ""}${fmtVal(v, { precision: a.precision ?? 2 })}${a.suffix || ""}` },
      splitLine: side === AXIS_ORDER[0] && idx === 0 ? { lineStyle: { color: alpha("line", 0.6) } } : { show: false },
      axisLine: { show: false },
    };
  });
  keys.forEach((k, i) => index.set(k, i));
  return {
    yAxis,
    grid: {
      left: theme.grid.left + extra.left,
      right: theme.grid.right + extra.right,
      top: theme.grid.top,
      bottom: theme.grid.bottom,
    },
    axisIndexOf: (k) => index.get(k) ?? 0,
  };
}

// ---------- 注记：阈值线 / 政策事件竖线 / 时期底色 / 阈值带 ----------
// 政策事件竖线：全站唯一实现，所有面板默认都画（数据来自 ds.policy，后端一处产出）。
// 每条线 = 竖向虚线 + 顶部官方标签文字；颜色由动作种类决定，取 tokens 里的政策色。
const POLICY_COLOR = { hike: "policy-hike", cut: "policy-cut", hold: "policy-hold", qt: "policy-qt", "qt-slow": "policy-qt", "qt-end": "policy-qt", qe: "policy-qe", other: "muted" };

function policyMarkLines(ds, cats, theme) {
  const events = (ds.policy || []).filter((e) => nearCategory(cats, e.date) != null);
  return events.map((e) => {
    const c = color(POLICY_COLOR[e.action] || "policy-hold");
    return {
      xAxis: nearCategory(cats, e.date),
        lineStyle: { color: c, type: "dashed", width: e.action === "hold" ? 1 : 1.4, opacity: e.action === "hold" ? 0.5 : 0.9 },
        label: {
          show: true,
          formatter: e.label,
          position: "insideEndTop",
          rotation: 0,
          distance: 4,
          color: c,
          fontSize: 10,
          fontWeight: e.action === "hold" ? 400 : 700,
          backgroundColor: alpha("surface", 0.72),
          padding: [2, 3],
      },
    };
  });
}

// 水平参考线的唯一形状（阈值线 / 走廊线共用）：{ yAxis, lineStyle, label } 只在这里定义一次。
// 两份逐键相同的对象字面量会被 G19 判成重复实现 —— 那正是「改了一处、另一处忘了」的来源。
function hLine(yAxis, { text, color, position = "insideEndTop", yAxisIndex }) {
  return {
    yAxis,
    ...(yAxisIndex ? { yAxisIndex } : {}),
    lineStyle: { color, type: "dashed", width: 1 },
    label: { formatter: text, position, color, fontSize: 11 },
  };
}

// 走廊四条线（天花板/地板/联邦基金/准备金）由 spec 的模式追加为 step 序列画在 % 轴上，
// 不再用无限横线：四条利率随 FOMC 决议变化，「今天水平的横线铺满十年」本身就是错的。

function zoneRules(layer) {
  const zones = layer.meta?.zones;
  if (!zones) return undefined;
  return {
    silent: true,
    symbol: "none",
    data: zones
      .filter((z) => z.max != null)
      .map((z) => {
        const above = zoneOf(zones, z.max + 0.001);
        return hLine(z.max, { text: `${above.label} > ${z.max}${layer.unit || ""}`, color: color(above.color) });
      }),
  };
}

function eraAreas(eras, cats) {
  if (!eras?.length || !cats.length) return undefined;
  const last = cats[cats.length - 1];
  return {
    silent: true,
    label: { show: true, position: "insideTop", fontSize: 10, fontWeight: 700 },
    data: eras.map((e) => [
      { name: e.label, xAxis: nearCategory(cats, e.from), itemStyle: { color: alpha(e.color, 0.08) }, label: { color: color(e.color) } },
      { xAxis: e.to ? nearCategory(cats, e.to) : last },
    ]),
  };
}

function thresholdBand(layer) {
  const r = layer.meta?.integrity?.range ?? layer.meta?.integrityRange;
  if (!Array.isArray(r) || r.length !== 2) return undefined;
  return { silent: true, data: [[{ yAxis: r[0] }, { yAxis: r[1], itemStyle: { color: alpha(layer.hue || "accent", 0.05) } }]] };
}

// ---------- tooltip：全站唯一文案工厂 ----------
// 导出键集供门禁 G20 比对（spec 声明的列必须在这里有实现，不得静默少画）
export const TOOLTIP_COLUMNS = {
  value: (r) => (r.recipe === "candlestick" ? "" : `: <b>${fmtVal(r.v, r.layer)}</b>${r.layer.unit || ""}`),
  ohlc: (r) =>
    r.recipe === "candlestick"
      ? `<br/>开 ${fmtVal(r.o, r.layer)} · 收 ${fmtVal(r.c, r.layer)} · 高 ${fmtVal(r.h, r.layer)} · 低 ${fmtVal(r.l, r.layer)}`
      : "",
  // 流量类序列的方向语义：与正负分色同一套判据，避免「颜色说一件事、文字说另一件事」
  flowDir: (r) => {
    if (!r.layer.posColor || r.v == null) return "";
    const c = color(r.v >= 0 ? r.layer.posColor : r.layer.negColor);
    return `　<b style="color:${c}">${r.v >= 0 ? "净流入·吸纳" : "净流出·吐出"}</b>`;
  },
  zone: (r) => (r.zone ? `　${r.zone.label}` : ""),
  validation: (r) => `　${r.flag?.ok === true ? "交叉验证 通过" : r.flag?.ok === false ? "交叉验证 不一致" : "无校验源"}`,
  correction: (r) => {
    const c = r.flag?.corrected;
    if (!c) return "";
    if (c.from != null && c.to != null) return `<br/>已依 ${c.by} 改值：${fmtVal(c.from, r.layer)} → ${fmtVal(c.to, r.layer)}${r.layer.unit}`;
    return `<br/>本期含 ${c} 个改值点`;
  },
  suspect: (r) => {
    const s = r.flag?.suspect;
    if (!s) return "";
    if (typeof s === "string") return `<br/>存疑（${s}）：保留原值不删不改，已排除出本桶统计`;
    return `<br/>本期含 ${s} 个存疑点（已排除出开/高/低/收统计）`;
  },
  era: (r) => (r.era ? `<br/>时期：${r.era}` : ""),
  wow: (r) => (r.wow == null ? "" : `<br/>周环比 <b>${r.wow >= 0 ? "+" : ""}${fmtVal(r.wow, { precision: 1 })}</b> ${r.layer.unit.trim()}`),
  source: (r) => (r.layer.meta?.sourceNote ? `　${r.layer.meta.sourceNote}` : ""),
  policy: (r) => (r.policyEvents || []).map((e) => `<br/>政策事件：${e.label}`).join(""),
};

function buildTooltip(spec, ctx) {
  const declared = spec.tooltip?.columns || ["value", "validation"];
  const columns = (ctx.hasPolicy ? [...declared, "policy"] : declared).filter((c, i, a) => a.indexOf(c) === i);
  const unknown = columns.filter((c) => !TOOLTIP_COLUMNS[c]);
  if (unknown.length) throw new Error(`spec ${spec.id} 声明了未实现的 tooltip 列：${unknown.join(",")}（合法列：${Object.keys(TOOLTIP_COLUMNS).join(",")}）`);
  return {
    hasPolicy: ctx.hasPolicy,
    trigger: "axis",
    axisPointer: { type: "cross", label: { backgroundColor: color("surface2") } },
    backgroundColor: alpha("surface", 0.94),
    borderColor: color("line"),
    textStyle: { color: color("ink"), fontSize: 12 },
    formatter: (params) => {
      const rows = ctx.read(params);
      if (!rows.length) return `${ctx.dateAt(params)}<br/>无可显示序列（点击上方标签开启）`;
      const head = `${rows[0].date}${rows[0].bucketNote}`;
      const body = rows
        .filter((r) => r.v != null || r.c != null)
        .map((r) => `${r.marker}${r.layer.label}${columns.map((c) => TOOLTIP_COLUMNS[c](r)).join("")}`)
        .join("<br/>");
      return `${head}<br/>${body}${ctx.lagNotes(rows)}${ctx.policyFoot(rows)}`;
    },
  };
}

// ---------- 区间与缩放：全站唯一构造点（inside + slider 各一处） ----------
export function buildWindow(cats, preset, ds, theme) {
  const w = zoomWindow(cats.map((date) => ({ date })), preset, ds.presets || []);
  return [
    { type: "inside", startValue: w.start, endValue: w.end },
    {
      type: "slider",
      startValue: w.start,
      endValue: w.end,
      height: theme.slider.height,
      bottom: theme.slider.bottom,
      borderColor: color("line"),
      backgroundColor: alpha("surface", 0.8),
      fillerColor: alpha("accent", 0.16),
      handleStyle: { color: color("accent"), borderColor: color("accent") },
      moveHandleStyle: { color: color("line2") },
      textStyle: { color: color("muted") },
      dataBackground: { lineStyle: { color: color("line2") }, areaStyle: { color: alpha("line2", 0.3) } },
    },
  ];
}

// ---------- 主装配 ----------
export function buildOption({ spec, ds, preset, selected = {}, theme, policyOn = true }) {
  const shown = visibleLayers(ds.layers, selected);
  const cats = ds.x.values;
  const axes = resolveAxes(ds, shown, theme);
  const derived = deriveColumns(spec, ds);
  const ann = spec.annotations || [];
  const anchorId = spec.anchor || ds.layers[0]?.id;

  const ctx = tooltipContext({ spec, ds, shown, cats, derived, policyOn });
  const series = shown.map((layer) => {
    const s = RECIPES[layer.recipe]({ layer, theme, axisIndex: axes.axisIndexOf(layer.axis), style: layer.style || {}, spec, ds, cats });
    if (layer.id === anchorId) {
      const lines = [...(ann.includes("zones") ? zoneRules(layer)?.data || [] : []), ...(policyOn ? policyMarkLines(ds, cats, theme) : [])];
      if (lines.length) s.markLine = { silent: true, symbol: "none", data: lines };
    }
    if (ann.includes("eras")) s.markArea = eraAreas(ds.eras, cats) || s.markArea;
    if (layer.id === anchorId && ann.includes("integrityBands")) s.markArea = thresholdBand(layer) || s.markArea;
    return s;
  });

  const option = {
    backgroundColor: "transparent",
    animation: false,
    grid: axes.grid,
    tooltip: buildTooltip(spec, ctx),
    xAxis: {
      type: "category",
      data: cats,
      axisLine: { lineStyle: { color: color("line") } },
      axisLabel: { color: color("muted") },
    },
    yAxis: axes.yAxis,
    dataZoom: buildWindow(cats, preset, ds, theme),
    series,
  };
  if (spec.legend === true || (spec.legend === "auto" && ds.layers.length > 1)) {
    option.legend = {
      data: ds.layers.map((l) => l.label),
      selected: Object.fromEntries(ds.layers.map((l) => [l.label, selected[l.id] !== false])),
      selectedMode: "multiple",
      inactiveColor: color("axis-inactive"),
      itemGap: 16,
      textStyle: { color: color("ink2"), fontSize: 12 },
      top: 2,
    };
  }
  return option;
}

// 派生列（如周环比）只在这里算一次，tooltip 与其他读图组件共用同一份
function deriveColumns(spec, ds) {
  const out = {};
  for (const op of spec.derive || []) {
    for (const l of ds.layers) out[l.id] = { ...(out[l.id] || {}), [op.name]: delta(l.values, op.factor || 1) };
  }
  return out;
}

function tooltipContext({ spec, ds, shown, cats, derived, policyOn = true }) {
  const bucketNoteAt = (layer, i) =>
    layer.counts?.[i] != null && layer.ohlc?.[i] ? `（${ds.granularity === "week" ? "周" : "月"}，${layer.counts[i]} 个交易日）` : "";
  return {
    // 政策事件的唯一开关点：关时 tooltip 列、逐点说明、尾注一并不出现（G20 的自动追加判据仍成立）
    hasPolicy: policyOn && (ds.policy || []).length > 0,
    // 来源说明与「为什么没画」是同一种话：只要后端给了 policyNote 就要说，不能因为画得出线就闭嘴
    // （中国页上画的是美联储事件，读者必须看见出处，否则等于静默替换市场口径）
    policyFoot: () => (policyOn && ds.policyNote ? `<br/><span style="color:${color("muted")}">${ds.policyNote}</span>` : ""),
    dateAt: (params) => cats[(Array.isArray(params) ? params[0] : params)?.dataIndex ?? 0] ?? "",
    read: (params) => {
      const list = Array.isArray(params) ? params : [params];
      return list
        .map((pp) => {
          const layer = shown[pp.seriesIndex];
          if (!layer) return null;
          const i = pp.dataIndex;
          const row = layer.ohlc?.[i];
          const v = layer.values?.[i];
          return {
            date: cats[i],
            i,
            marker: pp.marker,
            layer,
            recipe: layer.recipe,
            flag: layer.flags?.[i] || {},
            v,
            o: row?.[0],
            c: row?.[1],
            l: row?.[2],
            h: row?.[3],
            zone: layer.meta?.zones ? zoneOf(layer.meta.zones, row ? row[1] : v) : null,
            era: eraOf(ds.eras, cats[i])?.label,
            wow: derived[layer.id]?.[spec.tooltip?.wowColumn]?.[i],
            bucketNote: bucketNoteAt(layer, i),
            policyEvents: policyOn ? (ds.policy || []).filter((e) => e.date === cats[i]) : [],
          };
        })
        .filter(Boolean);
    },
    // 月频序列在日频窗口内没有观测点时，必须说明「官方尚未发布」而非缺数（不造数原则的读图侧配套）
    lagNotes: (rows) => {
      if (!spec.tooltip?.lagNote) return "";
      const date = rows[0]?.date;
      return shown
        .filter((l) => l.meta?.freq === "month" && rows.every((r) => r.layer.id !== l.id || r.v == null))
        .map((l) => {
          const obsDates = cats.filter((d, k) => l.values[k] != null);
          const obs = lastOnOrBefore(obsDates, date);
          return `<br/><span style="color:${color("muted")}">${l.label}：该日无官方月度观测${obs ? `（最近观测月 ${obs.slice(0, 7)}）` : ""}，${RECIPE_META[l.recipe]?.lag || ""}。</span>`;
        })
        .join("");
    },
  };
}
