// H.4.1（美联储理事会每周公布流动性测量，官方 HTML，仅周四发布、无机器可读端点）解析细节。
// 下划线前缀 = 不是 provider：同一份官方文件同时供养「条件表」与「日平均因子表」两个 provider。
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export const H41_URL = "https://www.federalreserve.gov/releases/h41/current/h41.htm";

export function h41Date(s) {
  const m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[1]] + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

export function h41Num(s) {
  const x = s.replace(/[,\s+]/g, "").replace(/^\((.*)\)$/, "$1");
  if (!x || x === "...") return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/&#xa0;|&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// 表格切分 + 三个日期锚点（本期 / 上周 / 去年同期）的读取方式在两张表里完全一致，只在这里实现一次
function tables(t, keep) {
  const tb = t
    .split(/<table[^>]*>/i)
    .slice(1)
    .map((s) => s.split(/<\/table>/i)[0])
    .filter(keep);
  if (!tb.length) throw new Error("H.4.1 statement tables not found");
  return tb.map((s) =>
    [...s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]))
    )
  );
}

function anchors(trs, seen) {
  const dates = [];
  for (const r of trs.slice(0, 3)) for (const c of r) {
    const d = h41Date(c);
    if (d && !dates.includes(d) && !seen.has(d)) {
      dates.push(d);
      seen.add(d);
    }
  }
  return dates;
}

export function parseStatement(t) {
  const rows = new Map();
  let date = null, prevDate = null, yearAgoDate = null;
  const seen = new Set();
  for (const trs of tables(t, (tb) => /Eliminations from consolidation/i.test(tb))) {
    if (!date) {
      const d = anchors(trs, seen);
      if (d.length >= 3) [date, prevDate, yearAgoDate] = d;
    }
    for (const r of trs) {
      if (r.length < 5) continue;
      const label = r[0].replace(/\d+$/, "").trim();
      const v = h41Num(r[2]);
      if (!label || v == null) continue;
      if (!rows.has(label)) rows.set(label, { v, wc: h41Num(r[3]), yc: h41Num(r[4]) });
    }
  }
  if (!date) throw new Error("H.4.1 dates not parsed");
  return { date, prevDate, yearAgoDate, rows };
}

export function parseFactors(t) {
  const rows = new Map();
  let date = null, prevDate = null, yearAgoDate = null;
  const seen = new Set();
  for (const trs of tables(t, (tb) => /Reserve Bank credit, related items/i.test(tb) && /Averages of daily figures/i.test(tb))) {
    if (!date) {
      const d = anchors(trs, seen);
      if (d.length >= 3) [date, prevDate, yearAgoDate] = d;
    }
    for (const r of trs) {
      if (r.length < 5) continue;
      const label = r[0].replace(/\d+$/, "").trim();
      const avg = h41Num(r[1]);
      if (!label || avg == null) continue;
      if (!rows.has(label)) rows.set(label, { avg, wc: h41Num(r[2]), yc: h41Num(r[3]), wed: h41Num(r[4]) });
    }
  }
  if (!date) throw new Error("H.4.1 factors dates not parsed");
  return { date, prevDate, yearAgoDate, rows };
}
