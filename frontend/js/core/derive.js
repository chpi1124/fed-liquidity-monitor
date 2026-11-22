export const DEFAULT_COLOR = "#ff8a2a";

export const fmtVal = (v, cfg) => (v == null ? "—" : Number(v).toFixed(cfg?.precision ?? 2));

export function zoneOf(zones, v) {
  if (!zones || v == null) return null;
  for (const z of zones) {
    if (z.max == null) return z;
    if (z.includeMax === false ? v < z.max : v <= z.max) return z;
  }
  return zones[zones.length - 1];
}

export function colorOf(zones, v, hue) {
  return zoneOf(zones, v)?.color || hue || DEFAULT_COLOR;
}

export function rangeText(zones, i) {
  const z = zones[i];
  if (i === 0) return z.includeMax === false ? `<${z.max}` : `≤${z.max}`;
  if (z.max == null) return `>${zones[i - 1].max}`;
  return `${zones[i - 1].max}–${z.max}`;
}

export const PRESETS = [
  { id: "2W", label: "近两周", days: 14, title: "一键定位最近两周" },
  { id: "1M", label: "1M", days: 30 },
  { id: "3M", label: "3M", days: 91 },
  { id: "6M", label: "6M", days: 182 },
  { id: "1Y", label: "1Y", days: 365 },
  { id: "ALL", label: "全部", days: null },
];

export function zoomWindow(points, preset, presets = PRESETS) {
  if (!points || !points.length) return { start: 0, end: 0 };
  const p = presets.find((x) => x.id === preset) || presets[presets.length - 1];
  if (!p.days) return { start: 0, end: points.length - 1 };
  const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);
  const cut = new Date(last);
  cut.setUTCDate(cut.getUTCDate() - p.days);
  const cutStr = cut.toISOString().slice(0, 10);
  let start = points.findIndex((pt) => pt.date >= cutStr);
  if (start < 0) start = 0;
  return { start, end: points.length - 1 };
}

export const SHEET_PRESETS = [
  { id: "1Y", label: "1Y", days: 365 },
  { id: "3Y", label: "3Y", days: 1095 },
  { id: "5Y", label: "5Y", days: 1825 },
  { id: "10Y", label: "10Y", days: 3650 },
  { id: "ALL", label: "全部", days: null, title: "2002 年至今全部周度数据" },
];

export const fmtTrillion = (v) => (v == null ? "—" : (v / 1e6).toFixed(3));
export const fmtYi = (wc) => (wc == null ? "—" : (wc / 100).toFixed(1));

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

// 序列在图例/开关标签中的名称：由指标配置派生，chart 与组件共用，避免两处硬编码。
export function seriesLabel(cfg) {
  const tags = [];
  if (cfg.invert) tags.push("轴反向");
  if (cfg.freq === "month") tags.push("月度");
  if (cfg.render === "bar") tags.push("柱");
  return cfg.name + (tags.length ? `（${tags.join("·")}）` : "");
}

// 数值显示的唯一口径：前缀与单位相同时不重复输出（如金价 unit="$" 且 axisPrefix="$"）。
export function fmtPoint(cfg, v) {
  if (v == null) return "—";
  const pre = cfg.axisPrefix || "";
  const unit = cfg.unit || "";
  return `${pre}${fmtVal(v, cfg)}${unit === pre ? "" : unit}`;
}

export function validationNote(x) {
  return x.validation?.checked ? `交叉验证 ${x.validation.matched}/${x.validation.checked} 通过` : "无并行校验机构";
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