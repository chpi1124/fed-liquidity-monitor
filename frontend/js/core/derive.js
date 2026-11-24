export const fmtVal = (v, cfg) => (v == null ? "—" : Number(v).toFixed(cfg?.precision ?? 2));

export function zoneOf(zones, v) {
  if (!zones || v == null) return null;
  for (const z of zones) {
    if (z.max == null) return z;
    if (z.includeMax === false ? v < z.max : v <= z.max) return z;
  }
  return zones[zones.length - 1];
}

// 返回的是 token 名（如 "info"/"risk-1"），由 theme.css()/theme.color() 单一出口解析
export function colorOf(zones, v, hue) {
  return zoneOf(zones, v)?.color || hue || "accent";
}

export function rangeText(zones, i) {
  const z = zones[i];
  if (i === 0) return z.includeMax === false ? `<${z.max}` : `≤${z.max}`;
  if (z.max == null) return `>${zones[i - 1].max}`;
  return `${zones[i - 1].max}–${z.max}`;
}

// 区间求解的唯一实现：预设表由 charts/presets.json 提供，本函数只按天切。
export function zoomWindow(points, preset, presets = []) {
  if (!points || !points.length) return { start: 0, end: 0 };
  const p = presets.find((x) => x.id === preset) || presets[presets.length - 1];
  if (!p || !p.days) return { start: 0, end: points.length - 1 };
  const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);
  const cut = new Date(last);
  cut.setUTCDate(cut.getUTCDate() - p.days);
  const cutStr = cut.toISOString().slice(0, 10);
  let start = points.findIndex((pt) => pt.date >= cutStr);
  if (start < 0) start = 0;
  return { start, end: points.length - 1 };
}

export function nextBusinessDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export function publicationLine(cfg, latestD) {
  if (cfg?.publication !== "T+1" || !latestD) return "";
  const pending = nextBusinessDay(latestD);
  const pub = nextBusinessDay(pending);
  return `官方 T+1 发布：${pending} 的利率由纽约联储于 ${pub} 美东上午（约 8–9 点，北京时间 20–22 点）公布，本站届时自动更新；今日数值须待次一工作日官方发布后方可显示。`;
}

// 校验结论的唯一措辞：任何组件要说「交叉验证」都调用这里，杜绝两处各写一遍
export function validationNote(x) {
  return x?.validation?.checked ? `交叉验证 ${x.validation.matched}/${x.validation.checked} 通过` : "本期未获并行确认（单源或未取到校验腿）";
}

export const fmtPoint = (cfg, v) => {
  if (v == null) return "—";
  const pre = cfg?.axisPrefix || "";
  const unit = cfg?.unit || "";
  return `${pre}${fmtVal(v, cfg)}${unit === pre ? "" : unit}`;
};

export const fmtTrillion = (v) => (v == null ? "—" : (v / 1e6).toFixed(3));
export const fmtYi = (wc) => (wc == null ? "—" : (wc / 100).toFixed(1));

// 派生比值指标分子/分母腿的实数展示：单位→万亿换算与 fmtTrillion 同一把尺子（本文件是换算唯一 owner）。
// 未声明单位或未知单位时只报原值，绝不猜口径。
export function fmtLeg(v, unit) {
  if (v == null) return "—";
  const div = unit === "百万美元" ? 1e6 : unit === "十亿美元" ? 1e3 : null;
  const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v);
  return div ? `${num} ${unit}（${(v / div).toFixed(3)} 万亿）` : `${num} ${unit ?? ""}`.trimEnd();
}

// 导航提示的换算与措辞唯一 owner：后端只回 {kind, value, note}（数据），这里决定怎么说
export function hintText(h) {
  if (!h) return "";
  if (h.kind === "trillion") return `${fmtTrillion(h.value)} 万亿 · ${h.note}`;
  if (h.kind === "count") return `${h.value} 项 · ${h.note}`;
  if (h.kind === "date") return `最新 ${h.value}`;
  throw new Error(`未知导航提示类型：${h.kind}（须在前端补一种说法，不得静默留空）`);
}

export function eraOf(eras, date) {
  return (eras || []).find((e) => date >= e.from && (e.to == null || date <= e.to)) || null;
}

export function compositionSegments(sheet) {
  const assets = sheet?.groups?.find((g) => g.key === "assets");
  if (!assets || !sheet.total) return [];
  const segs = assets.items.filter((it) => it.leaf && it.depth).map((it) => ({ label: it.zh, value: it.v }));
  const sum = segs.reduce((s, x) => s + x.value, 0);
  if (sheet.total > sum) segs.push({ label: "其他净资产", value: sheet.total - sum });
  return segs;
}

export function deltaInfo(tail, unit) {
  if (!tail || tail.length < 2) return null;
  const a = tail[tail.length - 2].v;
  const b = tail[tail.length - 1].v;
  const d = unit === "bp" ? b - a : (b - a) * 100;
  return { bp: Math.round(Math.abs(d) * 100) / 100, dir: d > 0 ? "up" : d < 0 ? "down" : "flat" };
}

// 每张图的「可读到文本」摘要：既是 aria-label，也是可抓取的文字结论（不靠看图才能知道）
export function panelSummary(spec, ds, selected = {}) {
  const shown = (ds.layers || []).filter((l) => selected[l.id] !== false);
  const first = ds.x?.values?.[0] || "—";
  const last = ds.x?.values?.[ds.x?.values?.length - 1] || "—";
  const brief = shown
    .map((l) => {
      const latest = l.latest || {};
      const v = latest.v ?? latest.c;
      return `${l.name} ${fmtPoint(l, v)}${latest.date ? `（${latest.date}）` : ""}，${validationNote(l)}`;
    })
    .join("；");
  const hidden = (ds.layers || []).length - shown.length;
  return `${spec.title || "数据图"}：${brief || "无可显示序列"}；区间 ${first} 至 ${last}，共 ${(ds.x?.values || []).length} 个观测点${hidden ? `，已关闭 ${hidden} 条序列` : ""}。存疑与改值点只标记不删除。`;
}
