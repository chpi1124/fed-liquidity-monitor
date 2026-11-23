// 图形投影层的唯一算数出口：对齐后的列上做派生运算与几何映射。
// 日期并集/跨序列对齐属数据整形，归后端 backend/lib/panels.js；本层不重复实现，避免两处尺子。
export function rescale(values, factor) {
  if (!factor || factor === 1) return values;
  return values.map((v) => (v == null ? null : v * factor));
}

export function delta(values, factor = 1) {
  return values.map((v, i) => (i === 0 || v == null || values[i - 1] == null ? null : (v - values[i - 1]) * factor));
}

export function share(values) {
  const sum = values.reduce((a, v) => a + (v || 0), 0);
  return values.map((v) => (sum ? (v || 0) / sum : 0));
}

export function nearCategory(cats, date) {
  const i = cats.findIndex((c) => c >= date);
  return cats[i < 0 ? cats.length - 1 : i];
}

export function lastOnOrBefore(sorted, date) {
  let lo = 0;
  let hi = sorted.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= date) {
      res = sorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
}

// Sparkline 与任何微型折线共用同一把尺子：返回 [x, y] 顶点序列与末点。
export function geometry(values, w, h, pad = 3) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - pad * 2) + pad, h - pad - ((v - lo) / span) * (h - pad * 3)]);
  return { pts, last: pts[pts.length - 1], min: lo, max: hi };
}

// 图层可见性只看这一个谓词：图例开关、坐标轴增减、叠加上限计数共用。
export function visibleLayers(layers, selected) {
  return layers.filter((l) => selected[l.id] !== false && (l.values?.length || l.ohlc?.length));
}
