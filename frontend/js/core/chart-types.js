// 图形配方注册表：spec 的 layers[].recipe 只能取这里的键；新增一种图形 = 加一个纯函数 + 加一条 spec，
// 渲染层与主程序都不改（「零改渲染层」的可执行落点）。
import { colorOf, eraOf } from "./derive.js";
import { alpha, color } from "./theme.js";

// 存疑与已改值的可见化只在这一处实现：折线、柱、K 线共用同一套标记语言，
// 不会再出现「某种图形形态悄悄不画标记」。
function markOf(flag, theme) {
  if (flag?.suspect) return { borderColor: theme.suspect, borderWidth: theme.flagBorderWidth };
  if (flag?.corrected) return { borderColor: theme.corrected, borderWidth: theme.flagBorderWidth };
  return null;
}

// mode="point"：折线上的存疑点画成空心菱形；mode="item"：柱/蜡烛描边。
function seriesData(values, flags, theme, baseStyle, mode) {
  return values.map((v, i) => {
    if (v == null) return null;
    const mark = markOf(flags?.[i], theme);
    const style = baseStyle ? { ...(baseStyle(v, i) || {}) } : null;
    if (!mark && !style) return v;
    const out = { value: v, itemStyle: style || {} };
    if (mark) {
      if (mode === "point") {
        out.symbol = "diamond";
        out.symbolSize = theme.symbolSize;
        out.showSymbol = true;
        Object.assign(out.itemStyle, { color: theme.bg1, ...mark });
      } else Object.assign(out.itemStyle, mark);
    }
    return out;
  });
}

// 每个配方都要回答「画在哪个轴、叫什么名、压在第几层」——这三件事只在这里写一次（G19 的可执行落点：
// 本文件中 yAxisIndex / name: layer.label 各只允许出现一次）。
function base(ctx, type, z) {
  const { layer, axisIndex, style = {} } = ctx;
  return { name: layer.label, type, yAxisIndex: axisIndex, z: style.z ?? z };
}

export const RECIPES = {
  // 水平型序列（利率、价格）：月频时用矩形点标出「只在观测月有值」
  line: (ctx) => {
    const { layer, theme, style = {} } = ctx;
    const hue = color(layer.hue);
    return {
      ...base(ctx, "line", 3),
      connectNulls: !!style.connect,
      showSymbol: !!style.showSymbol,
      symbol: style.symbol || "circle",
      symbolSize: style.symbolSize || theme.symbolSize,
      lineStyle: { color: hue, width: style.width ?? theme.lineWidth, opacity: style.opacity ?? 1 },
      // 阶梯线：政策利率两次决议之间是水平的 ⇒ step 才是真实形状，直线插值会画出不存在的坡
      step: style.step ? "end" : undefined,
      itemStyle: { color: hue, borderColor: theme.bg1, borderWidth: style.showSymbol ? theme.hairline : 0 },
      areaStyle: style.area ? { color: alpha(layer.hue, style.area) } : undefined,
      data: seriesData(layer.values, layer.flags, theme, null, "point"),
    };
  },

  // 走廊着色柱：颜色由该点落在哪个利率/风险区间决定
  zoneBar: (ctx) => {
    const { layer, theme, style = {} } = ctx;
    const zones = layer.meta?.zones;
    return {
      ...base(ctx, "bar", 2),
      barWidth: style.barWidth || `${theme.barDay}%`,
      data: seriesData(layer.values, layer.flags, theme, zones ? (v) => ({ color: color(colorOf(zones, v, layer.hue)) }) : null, "item"),
    };
  },

  // 时期着色柱（资产负债表规模）：颜色由该日期落在哪个政策时期决定
  eraBar: (ctx) => {
    const { layer, theme, style = {}, ds, cats } = ctx;
    const eras = ds?.eras || [];
    return {
      ...base(ctx, "bar", 2),
      barWidth: style.barWidth || `${theme.barSheet}%`,
      data: seriesData(
        layer.values,
        layer.flags,
        theme,
        eras.length ? (v, i) => ({ color: color(eraOf(eras, cats[i])?.color || layer.hue || "info") }) : null,
        "item"
      ),
      itemStyle: { color: color(layer.hue || "info") },
    };
  },

  // 金额存量柱（SRF 动用量、逆回购规模等）：量级是主角，着色只保留状态标记，不参与走廊语义
  bar: (ctx) => {
    const { layer, theme, style = {} } = ctx;
    return {
      ...base(ctx, "bar", 2),
      barWidth: style.barWidth || `${theme.barDay}%`,
      itemStyle: { color: color(layer.hue || "accent") },
      data: seriesData(layer.values, layer.flags, theme, null, "item"),
    };
  },

  // 有正负的流量柱：净流入/流出分色，语义与「零」这条基线同等重要
  signedBar: (ctx) => {
    const { layer, theme, style = {} } = ctx;
    const pos = color(layer.posColor || layer.hue);
    const neg = color(layer.negColor || layer.hue);
    return {
      ...base(ctx, "bar", 2),
      barWidth: style.barWidth || theme.barWidth,
      barMinHeight: style.barMinHeight ?? theme.barMinHeight,
      itemStyle: { color: pos },
      data: seriesData(layer.values, layer.flags, theme, layer.posColor ? (v) => ({ color: v >= 0 ? pos : neg }) : null, "item"),
    };
  },

  // 周/月开高低收：实体与影线的语义不能被拆成四条线，保留独立配方
  candlestick: (ctx) => {
    const { layer, theme, style = {} } = ctx;
    const hue = color(layer.hue);
    return {
      ...base(ctx, "candlestick", 3),
      itemStyle: { color: hue, color0: hue, borderColor: hue, borderColor0: hue },
      data: (layer.ohlc || []).map((row, i) => {
        if (!row) return null;
        const mark = markOf(layer.flags?.[i], theme);
        if (!mark) return { value: row };
        return { value: row, itemStyle: { color: hue, color0: hue, borderColor: mark.borderColor, borderColor0: mark.borderColor } };
      }),
    };
  },
};

// 配方键与文案注记的唯一对应表在 recipe-meta.js；本文件只负责「怎么画」。
export function recipeOf(name) {
  const fn = RECIPES[name];
  if (!fn) throw new Error(`未注册的图形配方：${name}（合法键：${Object.keys(RECIPES).join(", ")}）`);
  return fn;
}
