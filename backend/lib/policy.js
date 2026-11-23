// 政策事件（加息/降息/按兵不动/缩表/扩表）的读取与刷新端口。
// 事件本体来自哪个官方源，由 specs/regions.json 的 policy 字段声明（资产层认领，代码不写死）；
// 标签文字在这里一次生成，前端只负责画线（渲染层零文案、零算数）。规范落点：docs/核心数据面板组件规范与守卫.html C-11。
import fs from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import { fetchSeries, has as hasProvider } from "../providers/registry.js";
import { drainUsage } from "../providers/_shared.js";
import { SPECS_DIR } from "./paths.js";

// 市场 → 政策事件源（可多于一本，但合并逻辑未实现前拒绝静默取第一个）
function sourceIds(region) {
  const list = JSON.parse(fs.readFileSync(path.join(SPECS_DIR, "regions.json"), "utf8"));
  const ids = (list.find((r) => r.id === region) || {}).policy || [];
  const unknown = ids.filter((id) => !hasProvider(id));
  if (unknown.length) throw new Error(`regions.json 里 ${region} 声明的政策事件源未注册：${unknown.join(",")}`);
  if (ids.length > 1) throw new Error(`${region} 声明了 ${ids.length} 个政策事件源：多源合并（同期次谁赢）尚未定义，不做静默取舍`);
  return ids;
}

export function sourceRegions() {
  const list = JSON.parse(fs.readFileSync(path.join(SPECS_DIR, "regions.json"), "utf8"));
  return list.filter((r) => (r.policy || []).length).map((r) => r.id);
}

const ACTIONS = {
  hike: "加息",
  cut: "降息",
  hold: "按兵不动",
  qt: "缩表",
  "qt-slow": "缩表放缓",
  "qt-end": "结束缩表",
  qe: "扩表",
  other: "政策动作",
};

const bp = (v) => (v == null ? "" : `${v > 0 ? "+" : ""}${Number(v).toFixed(v % 1 ? 1 : 0)}bp`);
const rng = (r) => (r == null ? "" : `${r[0]}–${r[1]}%`);

// 标签：先说动作，再说幅度/新区间，最后说量级（缩表上限）。文字短是刻意的 —— 竖线顶部只能放短句。
export function labelOf(ev) {
  // 官方上限以十亿美元计，中文标签按亿表述：换算只在这里做一次（渲染层不再算数）
  const yi = (billion) => (billion == null ? null : Math.round(Number(billion) * 10));
  if (ev.action === "qt") return yi(ev.monthlyCapBillion) ? `缩表 ≤${yi(ev.monthlyCapBillion)}亿/月` : "缩表";
  if (ev.action === "qt-slow") return yi(ev.monthlyCapBillion) ? `缩表放缓至${yi(ev.monthlyCapBillion)}亿/月` : "缩表放缓";
  if (ev.action === "qe") return "扩表";
  const parts = [ACTIONS[ev.action] || ACTIONS.other];
  if (ev.deltaBp) parts.push(bp(ev.deltaBp));
  else if (ev.action === "hold") parts.push("维持");
  if (ev.range) parts.push(rng(ev.range));
  if (ev.bsAction && ev.bsAction !== "none" && ev.bsAction !== "qt-continue" && !String(ev.action).startsWith("qt") && ev.action !== "qe") parts.push("＋" + (ACTIONS[ev.bsAction] || "资产负债表动作"));
  return parts.join(" ");
}

export function list(region) {
  const rows = db.policyEvents(region);
  return rows.map((r) => ({ ...r, label: labelOf(r), kind: r.action }));
}

// 图表标注线：全站同一套，不按本页 region 过滤。
// 「所有图中必须用竖向虚线标注美联储加息/降息/缩表/扩表」是产品指令，
// 且美联储资产负债表动作确实驱动全球流动性（中国外汇占款即其镜像），不是可省的装饰。
export function chartList() {
  return db.policyEventsAll().map((r) => ({ ...r, label: labelOf(r), kind: r.action }));
}

export function noteFor(region, events) {
  if (!events.length) return "尚未取到任何官方政策事件（声明页不可达或未解析出动作），本轮不画标注线";
  // source 形如「发布机构 · 具体文号」，标注来源只取机构段：同一机构的两种文号不该被当成两个出处
  const orgs = [...new Set(events.map((e) => String(e.source || "").split(" · ")[0]))];
  const local = events.some((e) => e.region === (region || "us"));
  if (local && orgs.length === 1) return "";
  return `标注线来自 ${orgs.join("；")}（跨市场政策事件，非本页市场专属发布）`;
}

// 刷新：只取库里最新事件之后的声明（增量），并像序列一样留下五态运行记录
export async function refresh(region = "us", { force = false } = {}) {
  const have = db.policyEventCount(region);
  const stored = db.policyEvents(region);
  const start = force || !stored.length ? undefined : stored.at(-1).date;
  const usage = drainUsage();
  const startedAt = new Date().toISOString();
  let res;
  const ids = sourceIds(region);
  if (!ids.length) return { have, added: 0, total: have, skipped: [], links: [], note: "该市场尚未在 regions.json 登记政策事件源，本轮不刷新" };
  try {
    res = await fetchSeries({ provider: ids[0] }, start || "2016-01-01", new Date().toISOString().slice(0, 10));
  } catch (e) {
    recordRun(region, startedAt, usage, "failed", e.message, 0, []);
    throw e;
  }
  // 幅度：原文写了就用原文；没写就用「本次新区间中点 − 上次区间中点」，两端都是官方声明里的数，
  // 并在 delta_source 里标明是推得的，绝不让读者以为声明原文写了幅度
  const tail = stored.slice(-1);
  let prev = tail.length ? tail.at(-1) : null;
  const withDelta = [];
  // 缩表/扩表只在三种情况下算一次新动作：官方另发公告、月度上限数字发生变化、或本句文字明确宣布开始/计划/买入。
  // 每次例会声明都会复述既有上限，照单全收会让图上每次会议都多一条竖线（G25 的占比判据正是为此而设）。
  const isBs = (a) => ["qt", "qt-slow", "qt-end", "qe"].includes(a);
  const ANNOUNCE = /(?:Plans? (?:for|to) Reducing|Announc\w+[^.]{0,60}Balance Sheet|Balance Sheet (?:Reduction|Normalization)|Technical Details of Balance Sheet|Pace of (?:Balance Sheet )?(?:Runoff|Reduction))/i;
  const EXPLICIT = /(?:plans? (?:to|for)|expects to begin|begin(?:ning)? (?:the )?(?:process of )?reducing|commence|additional balance sheet actions|purchase Treasury bills)/i;
  const prevBs = stored.filter((x) => isBs(x.action));
  let lastCap = prevBs.length ? prevBs.at(-1).monthlyCapBillion ?? null : null;
  const dropped = [];
  const planned = [];
  for (const ev of res.events) {
    if (!isBs(ev.action)) {
      planned.push(ev);
      continue;
    }
    const capChanged = ev.monthlyCapBillion != null && ev.monthlyCapBillion !== lastCap;
    if (ANNOUNCE.test(String(ev.title || "")) || capChanged || EXPLICIT.test(String(ev.quote || ""))) {
      planned.push(ev);
      if (ev.monthlyCapBillion != null) lastCap = ev.monthlyCapBillion;
    } else {
      dropped.push(`${ev.date}/${ev.action}=复述既有上限 ${ev.monthlyCapBillion ?? "?"}（十亿/月）`);
    }
  }
  for (const ev of planned) {
    let delta = ev.deltaBp;
    let src = delta == null ? "" : "官方声明原文";
    const rngNow = ev.rangeLo == null ? null : [ev.rangeLo, ev.rangeHi];
    if (delta == null && rngNow && prev && prev.range) {
      const mid = (r) => (Number(r[0]) + Number(r[1])) / 2;
      delta = Number(((mid(rngNow) - mid(prev.range)) * 100).toFixed(1));
      src = "由前后两次官方声明区间推得";
    }
    // 声明原文只给幅度大小，方向由动作决定：降息取负、加息取正，绝不把 -50bp 写成 +50bp
    const signed = ev.action === "cut" ? -Math.abs(delta) : ev.action === "hike" ? Math.abs(delta) : delta;
    const full = { ...ev, deltaBp: ev.action === "hold" ? 0 : signed, deltaSource: ev.action === "hold" ? "声明维持原区间" : src };
    withDelta.push(full);
    db.upsertPolicyEvent(full, region);
    prev = { date: ev.date, range: rngNow || prev?.range || null };
  }
  // 被判定为「复述既有上限」的候选也进运行记录：筛选过程必须可审计，不能只在代码里默默丢掉
  recordRun(region, startedAt, usage, res.skipped.length || dropped.length ? "degraded" : "ok", null, withDelta.length, [...res.skipped, ...dropped]);
  const events = list(region);
  return { have, added: res.events.length, kept: withDelta.length, dropped: dropped.length, total: events.length, skipped: res.skipped, drops: dropped, links: res.links };
}

function recordRun(region, startedAt, usage, status, error, added, skipped) {
  const cfg = { id: `policy-${region}` };
  db.commitRunRecord({
    cfg,
    plan: { mode: "incremental", start: startedAt.slice(0, 10), end: new Date().toISOString().slice(0, 10), strategy: "windowed", overlap: 0 },
    usage,
    startedAt,
    status,
    error,
    added,
    stages: {
      plan: { status: "ok", info: "只取库里最新事件之后的声明" },
      fetch: { status: skipped.length ? "degraded" : "ok", info: skipped.length ? `有 ${skipped.length} 条未解析/取回失败` : "全部取回" },
      validate: { status: "ok", info: "每条事件必须带官方 URL 与原文摘要" },
      correct: { status: "skipped", info: "政策事件不存在改值：解析不出即不产出" },
      commit: { status: status === "failed" ? "failed" : "ok", info: `事件 ${added} 条` },
    },
  });
}

export { ACTIONS };
