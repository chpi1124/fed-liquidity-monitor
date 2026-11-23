// 中国人民银行《货币当局资产负债表》（月度）：官方按年出一张表 —— 12 个月作列，
// 同一行并列发布 htm 与 xlsx 两种编码。两种编码各自独立解析后逐期比对，是这份表在本站能做的
// 机器可读交叉验证腿（同一出版方、不同载体；任一侧解析错位就会当场对不上）。
// 目录 slug 逐年不同（2026 年用 2026ntjsj/hbtjgl，2025 年用纯数字段）⇒ 一律从调查统计司页逐级发现，
// 不硬编码任何年份 URL：硬编码会让历史在某年悄悄断掉。
import { request, xlsxSheet } from "./_shared.js";

const BASE = "https://www.pbc.gov.cn";
const DEPT = `${BASE}/diaochatongjisi/116219/index.html`;
const TABLE_CN = "货币当局资产负债表";
const OVERVIEW_CN = "货币统计概览";

// 页面上的 href 把发布日期压成了一段（attachDir/2026-11-<ts>.htm），真实路径是 /2026/11/<ts>.htm。
// 照抄 href 取数必然 404（美联储源上踩过同一类坑），所以在此还原目录层级。
function realHref(href) {
  const m = String(href).match(/^(.*\/attachDir\/)(\d{4})-(\d{2})-(.+)$/);
  return m ? `${m[1]}${m[2]}/${m[3]}/${m[4]}` : String(href);
}

const abs = (href, base) => new URL(realHref(href), base).toString();

// 官方老页面是 gb2312、新页面是 utf-8：按 meta 声明解码，猜错会得到「国外资产」→乱码，
// 那样标签匹配不上就是空表，绝不能让它静默成 0 条数据
function decode(buf) {
  const cs = (buf.subarray(0, 4096).toString("latin1").match(/charset=["']?([\w-]+)/i) || [])[1] || "";
  try {
    return new TextDecoder(/gb/i.test(cs) ? "gbk" : "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

const html = async (url, referer) => decode(await request(url, "buffer", { referer: referer || url }));

const strip = (s) =>
  String(s == null ? "" : s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .trim();

const num = (s) => {
  const t = strip(s).replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

// 官方一格内是「国外资产 Foreign Assets」，层级缩进靠 &nbsp; 撑；键只取开头中文段
const cnLabel = (s) => (strip(s).match(/^[一-鿿（）、．]+/) || [])[0] || "";

const MONTH_CELL = /^(\d{4})\.(\d{1,2})$/;

// 一行可能并排两组「标签 + 12 个月」（资产侧 + 负债侧），按「列下标 − 标签下标 − 1」对齐月份，
// 这样中间空的月份也不会把后面的值整体错位
function blocksOf(cells, months) {
  const labels = [];
  cells.forEach((raw, i) => {
    if (num(raw) !== null) return;
    const l = cnLabel(raw);
    if (l && !labels.some((x) => x.label === l && Math.abs(x.i - i) < 13)) labels.push({ i, label: l });
  });
  const out = new Map();
  labels.forEach((cur, k) => {
    const stop = k + 1 < labels.length ? labels[k + 1].i : cells.length;
    for (let i = cur.i + 1; i < stop; i++) {
      const v = num(cells[i]);
      const ym = months[i - cur.i - 1];
      if (v !== null && ym) out.set(cur.label, (out.get(cur.label) || new Map()).set(ym, v));
    }
  });
  return out;
}

function monthsOf(cells) {
  const out = [];
  for (const c of cells) {
    const m = MONTH_CELL.exec(strip(c));
    if (!m) {
      if (out.length) break;
      continue;
    }
    out.push(`${m[1]}-${m[2].padStart(2, "0")}`);
  }
  return out;
}

// —— 发现：调查统计司 → 某年统计数据 → 货币统计概览 → 货币当局资产负债表那一行的 htm/xlsx ——
const found = new Map(); // `${year}|${fmt}` -> { url, rows } | null
const nav = new Map(); // year -> 概览页 URL | null

async function overviewOf(year) {
  if (nav.has(year)) return nav.get(year);
  const dept = await html(DEPT);
  const yLink = [...dept.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,60}?)<\/a>/g)]
    .map((m) => ({ href: m[1], text: strip(m[2]) }))
    .find((x) => x.text.startsWith(`${year}年统计数据`));
  if (!yLink) {
    nav.set(year, null);
    return null;
  }
  const yearUrl = abs(yLink.href, BASE);
  const page = await html(yearUrl, DEPT);
  const ov = [...page.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g)]
    .map((m) => ({ href: m[1], text: strip(m[2]) }))
    .find((x) => x.text.includes(OVERVIEW_CN));
  const url = ov ? abs(ov.href, yearUrl) : null;
  nav.set(year, url);
  return url;
}

async function tableOf(year, fmt) {
  const key = `${year}|${fmt}`;
  if (found.has(key)) return found.get(key);
  const ovUrl = await overviewOf(year);
  if (!ovUrl) {
    found.set(key, null);
    return null;
  }
  const page = await html(ovUrl, DEPT);
  const row = page
    .split(/<tr/i)
    .find((r) => r.includes(TABLE_CN));
  if (!row) {
    found.set(key, null);
    return null;
  }
  const href = [...row.matchAll(/href="([^"]+\.(?:htm|xlsx))"/gi)]
    .map((m) => m[1])
    .find((h) => (fmt === "xlsx" ? /\.xlsx$/i : /\.htm$/i).test(h));
  if (!href) {
    // 官方 2015-2020 与 2022 年只提供 .xls（OLE2/BIFF 容器），本站未实现该容器 ⇒ 那些年没有第二编码。
    // 静默跳过会让「双编码逐期比对」被读成全年成立，所以这里必须出声，并登记在 specs/degraded-sources.json。
    const offered = [...row.matchAll(/href="[^"]+\.((?:xlsx|xls|htm|pdf))"/gi)].map((m) => m[1].toLowerCase());
    console.log(`[pbc-statement] ${year} 年官方只提供 ${[...new Set(offered)].join("/")}，无 ${fmt} ⇒ 本轮该年不参与双编码比对（界面对应点标「无校验源」）`);
    found.set(key, null);
    return null;
  }
  const url = abs(href, ovUrl);
  let parsed = null;
  if (fmt === "xlsx") {
    const sh = xlsxSheet(await request(url, "buffer", { referer: ovUrl }), "Sheet1");
    const cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const rows = sh.rows.map(([, rx]) => cols.map((c) => strip(sh.cell(rx, c))));
    parsed = parseRows(rows);
  } else {
    const src = await html(url, ovUrl);
    const rows = [...src.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]));
    parsed = parseRows(rows);
  }
  if (!parsed.months.length || !parsed.items.size) throw new Error(`pbc-statement ${year} ${fmt}：${url} 取回了但没解析出任何期次（官方改版？宁可报错也不静默交空表）`);
  parsed.url = url;
  found.set(key, parsed);
  return parsed;
}

function parseRows(rows) {
  let months = [];
  for (const r of rows) {
    const m = monthsOf(r);
    if (m.length > 1) {
      months = m;
      break;
    }
  }
  const items = new Map();
  if (months.length) {
    for (const r of rows) {
      for (const [label, vals] of blocksOf(r, months)) {
        const cur = items.get(label) || new Map();
        for (const [ym, v] of vals) cur.set(ym, v);
        items.set(label, cur);
      }
    }
  }
  return { months, items };
}

// 期末值用当月最后一天作观测日：官方表头写的就是「2026.10」月末余额，取月中或月初会把口径挪位
const monthEnd = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

export const ITEMS = ["国外资产", "外汇", "货币黄金", "对其他存款性公司债权", "对政府债权", "储备货币", "货币发行", "政府存款", "总负债", "总资产"];

export async function itemSeries(item, fmt, start, end) {
  const out = new Map();
  for (let y = Number(end.slice(0, 4)); y >= Number(start.slice(0, 4)); y--) {
    const t = await tableOf(y, fmt);
    if (!t) continue;
    const vals = t.items.get(item);
    if (!vals) continue;
    for (const [ym, v] of vals) {
      const d = monthEnd(ym);
      if (d >= start && d <= end) out.set(d, v);
    }
  }
  if (!out.size) throw new Error(`pbc-statement：${start.slice(0, 4)}..${end.slice(0, 4)} 年官方表里没有项目「${item}」（${fmt}）—— 项目名须与官方标签逐字一致，宁可报错也不换指标`);
  return out;
}

export default {
  id: "pbc-statement",
  org: "中国人民银行",
  endpoints: [DEPT, `${BASE}/diaochatongjisi/116219/116319/`],
  cadence: "monthly-mid",
  incremental: "monthly-step",
  windowNote: "官方按年出一张表（12 个月作列）⇒ 水位线之后只需当年文件；历史期次只补新期次，不覆盖（B-7）",
  fetch: (src, start, end) => itemSeries(src.item, src.fmt || "htm", start, end),
};
