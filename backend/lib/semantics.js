// 图形语义的唯一决定处（「按数据种类决定怎么画」只在这里写一遍）。
// 判据来自指标自己声明的量纲 unit —— 量纲已经是单一事实源，这里只把它翻译成图形语义，不再新增第二处配置。
// 规范落点：docs/核心数据面板组件规范与守卫.html C-6（图形语义由数据决定，不由页面各写一遍）。
import { strategyOf } from "../providers/registry.js";
import { getWatermark } from "./db.js";

export const KINDS = ["rate", "price", "amount", "flow"];

export function kindOf(cfg) {
  const u = String(cfg.unit || "").trim();
  // 顺序即优先级：带“每单位”的价格先判，再判有符号流量、金额存量，最后才是利率型
  if (/\/\s*(股|oz)|\$\s*\/|oz$/.test(u)) return "price";
  if (/吨|桶|盎司$/.test(u)) return "flow";
  if (/(%|bp|基点)$/.test(u) || u === "%" || u === "bp") return "rate";
  if (/美元|万亿|十亿|亿|百万/.test(u)) return "amount";
  return "rate";
}

// (种类, 层角色, 粒度) ⇒ 配方。利率型只在「主层 + 周/月」用 K 线（开高低收对利率走廊有意义），
// 叠加进来时一律用折线，避免与主层的柱/蜡烛打架；金额型一律柱状（SRF 动用量就是柱，不是线）。
export function defaultRecipe(kind, role, granularity) {
  if (kind === "amount") return "bar";
  if (kind === "flow") return "signedBar";
  if (kind === "price") return "line";
  if (role === "primary" && (granularity === "week" || granularity === "month")) return "candlestick";
  if (role === "primary") return "zoneBar";
  return "line";
}

// 层的角色来自 spec 的声明（primary/overlay/picked/sheet/显式 id），不是页面名
export function roleOf(layerSpec) {
  const s = layerSpec.series || "";
  return ["primary", "overlay", "picked", "sheet"].includes(s) ? s : "named";
}

// 一轮更新该向官方要哪段区间：水位线 + provider 策略 + 发布节奏 ⇒ start/end/mode。
export function fetchWindow(cfg, srcProviderId, today, earliest) {
  const strat = strategyOf(srcProviderId) || { strategy: "windowed", note: "未知 provider ⇒ 保守按分窗全取" };
  const overlap = overlapDays(cfg);
  const back = isoDays(today, overlap);
  const start = back > earliest ? back : earliest;
  const wm = getWatermark(cfg.id);
  if (!wm) return { ...strat, overlap, start: earliest, end: today, mode: "full", reason: "本地无水位线 ⇒ 首次全量建库" };
  if (strat.strategy === "snapshot-only") return { ...strat, overlap, start: today, end: today, mode: "snapshot", reason: strat.note || "官方只给最新一期" };
  if (strat.strategy === "whole-file") return { ...strat, overlap, start: earliest, end: today, mode: "whole-file-diff", reason: strat.note || "整文件下载，只对新增或变化的期次 upsert" };
  if (strat.strategy === "rolling-guard") return { ...strat, overlap, start, end: today, mode: "rolling-upsert", reason: strat.note || "滚动窗口源，禁止覆盖历史（B-7）" };
  if (strat.strategy === "monthly-step") return { ...strat, overlap, start: isoDays(wm.last_fetched_to, overlap), end: today, mode: "incremental", reason: strat.note || "按月步进，只请求新月份" };
  const from = isoDays(wm.last_observed || wm.last_fetched_to, overlap);
  return { ...strat, overlap, start: from > earliest ? from : earliest, end: today, mode: "incremental", reason: `水位线 ${wm.last_observed} 回退 ${overlap} 天修订窗（${strat.note}）` };
}

function isoDays(dateStr, days) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}

export function overlapDays(cfg) {
  const pub = cfg.publication || "T";
  const period = { T: 1, "T+1": 1, W: 7, M: 31, "M+1": 31, "M+2": 31 }[pub] || 1;
  const factor = { T: 4, "T+1": 4, W: 4, M: 2, "M+1": 2, "M+2": 2 }[pub] || 4;
  return Math.max(7, period * factor);
}
