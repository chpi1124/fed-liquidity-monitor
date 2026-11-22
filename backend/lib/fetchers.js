import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "./paths.js";

const NYFED_PATHS = {
  sofr: "secured/sofr",
  effr: "unsecured/effr",
};

// 中国外汇交易中心 / 全国银行间同业拆借中心（央行下属官方发布机构）
const CFETS_AG = "https://www.chinamoney.com.cn/ags/ms";
const CFETS_CMS = "https://www.chinamoney.com.cn/r/cms/www/chinamoney";

// HMRC UK Trade Info：HS 7108 全部 CN8 子目。
// ⚠ 71082000「Monetary gold 货币黄金」必须包含：只取 710811/710812 会把月度净环流量级压低约 100 倍
// （2024-01：全口径进口 66.1 吨 vs 仅非货币 0.68 吨），且会人为造出「几乎每月净流入」的假象。
const UK_TRADE = "https://api.uktradeinfo.com";
const UK_GOLD_CN8 = [71081100, 71081200, 71081310, 71081380, 71082000];
const UK_TRADE_IMPORT_FLOWS = new Set([1, 3]);
const UK_TRADE_EXPORT_FLOWS = new Set([2, 4]);

// UN Comtrade 公共预览端点（联合国汇总各国海关申报数据；英国申报值即 HMRC 口径）
const COMTRADE_MONTH = "https://comtradeapi.un.org/public/v1/preview/C/M/HS";

// 世界银行大宗商品市场部（Pink Sheet 发布方）
const WB_PAGE = "https://www.worldbank.org/en/research/commodity-markets";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function request(url, as, hdr) {
  let lastErr;
  const extra = typeof hdr === "string" ? { referer: hdr } : hdr || {};
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60000),
        headers: {
          "user-agent": UA,
          accept: as === "json" ? "application/json" : as === "html" ? "text/html" : as === "buffer" ? "*/*" : "text/csv",
          ...extra,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === "buffer") return Buffer.from(await res.arrayBuffer());
      return await (as === "json" ? res.json() : res.text());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`${url} -> ${lastErr.message}`);
}

function parseCfetsRmb(j, pair) {
  const rec = (j.records || []).find((x) => x.vrtEName === pair || x.vrtName === pair);
  if (!rec) throw new Error(`cfets rmb parity: pair ${pair} not found`);
  const d = (j.data?.lastDate || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const m = new Map();
  m.set(d, Number(rec.price));
  return m;
}

// CFETS history endpoints cap the query span (~250 days); chunk into 180-day windows and merge.
async function fetchCfetsWindows(path, referer, start, end, extract) {
  const m = new Map();
  const STEP = 180 * 86400000;
  const endT = Date.parse(`${end}T00:00:00Z`);
  let cur = Date.parse(`${start}T00:00:00Z`);
  while (cur <= endT) {
    const winEnd = Math.min(cur + STEP, endT);
    const s = new Date(cur).toISOString().slice(0, 10);
    const e = new Date(winEnd).toISOString().slice(0, 10);
    const j = await request(`${CFETS_AG}${path}&startDate=${s}&endDate=${e}`, "json", referer);
    extract(j, m);
    cur = winEnd + 86400000;
  }
  if (!m.size) throw new Error(`cfets ${path}: no rows`);
  return m;
}
const pickCfets = (tenor, dateKey) => (j, m) => {
  for (const r of j.records ?? []) {
    const d = r[dateKey];
    const v = r[tenor];
    if (d && v != null && v !== "") m.set(d, Number(v));
  }
};

const H41_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function h41Date(s) {
  const m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(H41_MONTHS[m[1]] + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

function h41Num(s) {
  const x = s.replace(/[,\s+]/g, "").replace(/^\((.*)\)$/, "$1");
  if (!x || x === "...") return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

function parseH41(t) {
  const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/&#xa0;|&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const tables = t
    .split(/<table[^>]*>/i)
    .slice(1)
    .map((s) => s.split(/<\/table>/i)[0])
    .filter((tb) => /Eliminations from consolidation/i.test(tb));
  if (!tables.length) throw new Error("H.4.1 condition statement tables not found");
  const rows = new Map();
  let date = null, prevDate = null, yearAgoDate = null;
  for (const tb of tables) {
    const trs = [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]))
    );
    if (!date) {
      const dates = [];
      for (const r of trs.slice(0, 3)) for (const c of r) { const d = h41Date(c); if (d) dates.push(d); }
      if (dates.length >= 3) [date, prevDate, yearAgoDate] = dates;
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

function parseH41Factors(t) {
  const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/&#xa0;|&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const tables = t
    .split(/<table[^>]*>/i)
    .slice(1)
    .map((s) => s.split(/<\/table>/i)[0])
    .filter((tb) => /Reserve Bank credit, related items/i.test(tb) && /Averages of daily figures/i.test(tb));
  if (!tables.length) throw new Error("H.4.1 factors tables not found");
  const rows = new Map();
  let date = null, prevDate = null, yearAgoDate = null;
  for (const tb of tables) {
    const trs = [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]))
    );
    if (!date) {
      const dates = [];
      for (const r of trs.slice(0, 3)) for (const c of r) { const d = h41Date(c); if (d && !dates.includes(d)) dates.push(d); }
      if (dates.length >= 3) [date, prevDate, yearAgoDate] = dates;
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

function parseFred(t) {
  const m = new Map();
  for (const line of t.split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    if (!d || !v || v === ".") continue;
    m.set(d, Number(v));
  }
  return m;
}

// MM/DD/YYYY -> YYYY-MM-DD
function usDate(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// U.S. Treasury daily real (inflation-indexed) yield curve, per-year CSVs; pick a tenor column.
async function fetchTreasuryReal(src, start, end) {
  const tenor = src.tenor || "10 YR";
  const key = tenor.replace(/\s/g, "");
  const m = new Map();
  const y0 = Number(start.slice(0, 4));
  const y1 = Number(end.slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    let txt;
    try {
      txt = await request(
        `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${y}&_format=csv`,
        "text"
      );
    } catch { continue; }
    const lines = txt.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const head = lines[0].split(",").map((s) => s.replace(/"/g, "").trim());
    const col = head.findIndex((h) => h.replace(/\s/g, "") === key);
    if (col < 0) continue;
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const d = usDate(cells[0]);
      const v = cells[col] == null ? "" : cells[col].replace(/"/g, "").trim();
      if (!d || v === "" || v === "." || v === "N/A") continue;
      if (d >= start && d <= end) m.set(d, Number(v));
    }
  }
  if (!m.size) throw new Error(`treasury-real tenor ${tenor}: no rows`);
  return m;
}

// Nasdaq exchange market data (e.g. gold ETFs GLD/IAU); ~2513-row cap -> chunk by ~9-year windows.
async function fetchNasdaq(src, start, end) {
  const sym = src.symbol;
  if (!sym || !/^[\w.=:-]+$/.test(sym)) throw new Error("nasdaq: invalid symbol");
  const cls = src.assetclass || "etf";
  const m = new Map();
  const STEP = 9 * 365 * 86400000;
  const endT = Date.parse(`${end}T00:00:00Z`);
  let cur = Date.parse(`${start}T00:00:00Z`);
  while (cur <= endT) {
    const winEnd = Math.min(cur + STEP, endT);
    const s = new Date(cur).toISOString().slice(0, 10);
    const e = new Date(winEnd).toISOString().slice(0, 10);
    const j = await request(
      `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${cls}&fromdate=${s}&todate=${e}&limit=10000`,
      "json",
      { referer: "https://www.nasdaq.com/", origin: "https://www.nasdaq.com" }
    );
    for (const r of j?.data?.tradesTable?.rows ?? []) {
      const d = usDate(r.date);
      const v = String(r.close || "").replace(/[$,]/g, "").trim();
      if (d && v && v !== "." && v !== "N/A") m.set(d, Number(v));
    }
    cur = winEnd + 86400000;
  }
  if (!m.size) throw new Error(`nasdaq ${sym}: no rows`);
  return m;
}

// HMRC UK Trade Info（英国税务海关总署官方对外贸易统计 OData 服务）。
// $apply 服务端聚合已实测与逐行求和完全一致，且不受分页行数截断影响，故单次请求取全序列。
async function fetchUkTrade(src, start, end) {
  const ids = src.commodity || UK_GOLD_CN8;
  if (!ids.every((n) => Number.isInteger(n))) throw new Error("uk-trade: invalid commodity ids");
  const from = Number(`${start.slice(0, 7).replace("-", "")}`);
  const to = Number(`${end.slice(0, 7).replace("-", "")}`);
  const filter = `(${ids.map((i) => `CommodityId eq ${i}`).join(" or ")}) and MonthId ge ${from} and MonthId le ${to}`;
  const apply = `filter(${filter})/groupby((MonthId,FlowTypeId),aggregate(NetMass with sum as kg))`;
  const j = await request(
    `${UK_TRADE}/OTS?$apply=${encodeURIComponent(apply)}&$format=json`,
    "json",
    { referer: "https://www.uktradeinfo.com/" }
  );
  const rows = j?.value;
  if (!Array.isArray(rows)) throw new Error("uk-trade: unexpected payload");
  const flows = new Map();
  for (const r of rows) {
    if (!UK_TRADE_IMPORT_FLOWS.has(r.FlowTypeId) && !UK_TRADE_EXPORT_FLOWS.has(r.FlowTypeId)) continue;
    const p = String(r.MonthId);
    const d = `${p.slice(0, 4)}-${p.slice(4, 6)}-01`;
    const o = flows.get(d) || { imp: 0, exp: 0 };
    if (UK_TRADE_IMPORT_FLOWS.has(r.FlowTypeId)) o.imp += r.kg || 0;
    else o.exp += r.kg || 0;
    flows.set(d, o);
  }
  const measure = src.measure || "net";
  const m = new Map();
  for (const [d, o] of [...flows.entries()].sort()) {
    const kg = measure === "import" ? o.imp : measure === "export" ? o.exp : o.imp - o.exp;
    m.set(d, kg / 1000);
  }
  if (!m.size) throw new Error("uk-trade: no rows");
  return m;
}

// 零依赖 ZIP 容器读取（XLSX 即 ZIP），供世界银行 Pink Sheet 解析使用。
function unzipEntries(b) {
  const eocd = b.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (eocd < 0) throw new Error("zip: central directory not found");
  const total = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < total; i++) {
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nlen).toString("utf8");
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.slice(start, start + csize);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function xlsxSheet(buf, sheetName) {
  const f = unzipEntries(buf);
  const wb = (f["xl/workbook.xml"] || Buffer.from("")).toString("utf8");
  const rels = (f["xl/_rels/workbook.xml.rels"] || Buffer.from("")).toString("utf8");
  let target = null;
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = s[0];
    const name = (tag.match(/name="([^"]+)"/) || [])[1];
    const id = (tag.match(/r:id="rId(\d+)"/) || [])[1];
    if (name !== sheetName || !id) continue;
    for (const r of rels.matchAll(/<Relationship[^>]*>/g)) {
      const rt = r[0];
      if ((rt.match(/Id="rId(\d+)"/) || [])[1] !== id) continue;
      target = (rt.match(/Target="([^"]+)"/) || [])[1];
    }
  }
  if (!target) throw new Error(`xlsx: sheet "${sheetName}" not found`);
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const xml = (f[path] || Buffer.from("")).toString("utf8");
  const strings = [...(f["xl/sharedStrings.xml"] || Buffer.from("")).toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")
  );
  const rows = [...xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((m) => [Number(m[1]), m[2]]);
  const decode = (cellXml) => {
    const v = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v == null) return null;
    return /t="s"/.test(cellXml) ? strings[Number(v)] ?? "" : v;
  };
  const cell = (rowXml, col) => {
    for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (m[1] !== col) continue;
      return decode(`${m[2]}>${m[3] || ""}`);
    }
    return null;
  };
  return { rows, cell };
}

// 世界银行大宗商品价格数据（Pink Sheet）月度 XLSX：官方国际组织，金价以美元/金衡盎司计。
// 下载链接从官方页面自动发现，不写死带哈希的 URL（该哈希随发布批次变化）。
async function fetchWorldBank(src, start, end) {
  const page = await request(WB_PAGE, "html");
  const rel = (page.match(/href="([^"]*CMO-Historical-Data-Monthly[^"]*\.xlsx)"/i) || [])[1];
  if (!rel) throw new Error("worldbank: monthly XLSX link not found on the commodity-markets page");
  const url = rel.startsWith("http") ? rel : `https:${rel}`;
  const buf = await request(url, "buffer");
  const { rows, cell } = xlsxSheet(buf, src.sheet || "Monthly Prices");
  const label = String(src.column || "Gold").trim().toLowerCase();
  const periodCol = src.periodCol || "A";
  let col = null;
  for (const [, rowXml] of rows.slice(0, 15)) {
    for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const v = cell(rowXml, m[1]);
      if (v != null && String(v).trim().toLowerCase() === label) col = m[1];
    }
    if (col) break;
  }
  if (!col) throw new Error(`worldbank: column "${src.column || "Gold"}" not found`);
  const lo = start.slice(0, 7);
  const hi = end.slice(0, 7);
  const m = new Map();
  for (const [, rowXml] of rows) {
    const per = String(cell(rowXml, periodCol) || "");
    const pm = per.match(/^(\d{4})M(\d{2})$/);
    if (!pm) continue;
    const ym = `${pm[1]}-${pm[2]}`;
    if (ym < lo || ym > hi) continue;
    const raw = cell(rowXml, col);
    const v = raw == null ? NaN : Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    m.set(`${ym}-01`, v);
  }
  if (!m.size) throw new Error(`worldbank: no rows for column ${col}`);
  return m;
}

// UN Comtrade 月度净环流（校验腿）：净重 netWgt 单位为 kg，除以 1000 得公吨。
// 公共预览端点每次只能查一个 period，且限流严格，故逐月取数并主动节流；
// 只取最近 maxMonths 个月（默认 6），个别月份失败则跳过（该月不计入校验，不造数）。
async function fetchUncomtrade(src, start, end) {
  const reporter = src.reporterCode || 826;
  const cmd = src.cmdCode || "7108";
  const months = [];
  let y = Number(start.slice(0, 4));
  let mo = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && mo <= em)) {
    months.push(`${y}${String(mo).padStart(2, "0")}`);
    if (++mo > 12) {
      mo = 1;
      y++;
    }
  }
  const take = months.slice(-(src.maxMonths || 6));
  const one = async (flow, period) => {
    const j = await request(`${COMTRADE_MONTH}?reporterCode=${reporter}&cmdCode=${cmd}&flowCode=${flow}&partnerCode=0&period=${period}&format=JSON`, "json");
    const row = (j?.data || [])[0];
    return row && row.netWgt != null ? Number(row.netWgt) : null;
  };
  const m = new Map();
  for (const p of take) {
    try {
      const [mi, mx] = await Promise.all([one("M", p), one("X", p)]);
      if (mi == null && mx == null) continue;
      m.set(`${p.slice(0, 4)}-${p.slice(4)}-01`, ((mi || 0) - (mx || 0)) / 1000);
    } catch {
      continue;
    }
    await new Promise((r) => setTimeout(r, src.paceMs || 2500));
  }
  if (!m.size) throw new Error("uncomtrade: 无可比月份（限流或官方尚未发布）");
  return m;
}

function pdfText(buf) {
  const s = buf.toString("latin1");
  let textAll = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const raw = Buffer.from(m[1].replace(/\r?\n$/, ""), "latin1");
    let out;
    try { out = zlib.inflateSync(raw); } catch { try { out = zlib.inflateRawSync(raw); } catch { continue; } }
    const txt = out.toString("latin1");
    const pieces = [...txt.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g)].map((mm) =>
      mm[1] != null ? mm[1] : [...mm[2].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]).join("")
    );
    if (pieces.length) textAll += pieces.join(" ") + "\n";
  }
  return textAll.replace(/\s+/g, " ");
}

const HKEX_PAGE = "https://www.hkex.com.hk/Services/Market-Data-Services/Index-Services/HKEX-Artificial-Intelligence-Index?sc_lang=en";
const HKEX_MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };

async function fetchHkexFactsheet() {
  const page = await request(HKEX_PAGE, "html");
  const links = [...page.matchAll(/href="([^"]*HKEXAI[^"]*Factsheet[^"]*\.pdf)"/gi)].map((m) => m[1]);
  const rel = links.find((l) => !/Methodology/i.test(l));
  if (!rel) throw new Error("HKEX AI factsheet PDF link not found");
  const url = rel.startsWith("http") ? rel : `https://www.hkex.com.hk${rel.startsWith("/") ? "" : "/"}${rel}`;
  const buf = await request(url, "buffer");
  const text = pdfText(buf);
  const lm = text.match(/Index Level[\s\S]{0,160}?HKEX AI ([\d,]+\.\d+)/i);
  if (!lm) throw new Error("HKEX AI index level not parsed from factsheet");
  const level = Number(lm[1].replace(/,/g, ""));
  const folder = url.match(/(\d{4})(\d{2})(\d{2})-HKEXAI-Factsheet/i);
  let asOf;
  if (folder) asOf = `${folder[1]}-${folder[2]}-${folder[3]}`;
  else {
    const mm = text.match(/Index Factsheet (\w+) (20\d[\d ]*)/i);
    if (!mm || !(mm[1] in HKEX_MONTHS)) throw new Error("HKEX AI factsheet month not parsed");
    const year = Number(mm[2].replace(/\s/g, ""));
    const mon = HKEX_MONTHS[mm[1]];
    asOf = new Date(Date.UTC(year, mon + 1, 0)).toISOString().slice(0, 10);
  }
  const m = new Map();
  m.set(asOf, level);
  return m;
}

async function rpChunks(start, end, visit) {
  const y0 = Number(start.slice(0, 4));
  const y1 = Number(end.slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    const s = y === y0 ? start : `${y}-01-01`;
    const e = y === y1 ? end : `${y}-12-31`;
    const j = await request(
      `https://markets.newyorkfed.org/api/rp/results/search.json?startDate=${s}&endDate=${e}`,
      "json"
    );
    for (const op of j.repo?.operations ?? []) visit(op);
  }
}

// ⚠ 中国货币网 ag 接口的日期过滤只在 lang=CN 下生效；lang=zh_CN 会被静默忽略并只回最近一页
// （FrrHis 22 行、LprHis 12 行），历史被截断且不报错。加分页类参数（pageSize/pageNum 等）
// 同样会退回「最新一页」，因此只用日期分窗取数。参数写法取自官方页面脚本。
const CFETS_LANG = "lang=CN";

export async function fetchSeries(src, start, end) {
  if (src.provider === "frb-h41") {
    const t = await request("https://www.federalreserve.gov/releases/h41/current/h41.htm", "html");
    return parseH41(t);
  }
  if (src.provider === "frb-h41-factors") {
    const t = await request("https://www.federalreserve.gov/releases/h41/current/h41.htm", "html");
    return parseH41Factors(t);
  }
  if (src.provider === "hkex-factsheet") {
    return fetchHkexFactsheet();
  }
  if (src.provider === "cfets-shibor") {
    return fetchCfetsWindows(
      `/cm-u-bk-shibor/ShiborHis?${CFETS_LANG}&reference=1&bank=100`,
      "https://www.chinamoney.com.cn/chinese/swhitmbj/",
      start, end, pickCfets(src.tenor || "ON", "showDateCN")
    );
  }
  if (src.provider === "cfets-rmb") {
    const j = await request(`${CFETS_CMS}/data/fx/ccpr.json`, "json", "https://www.chinamoney.com.cn/chinese/bkccpr/");
    return parseCfetsRmb(j, src.pair || "USD/CNY");
  }
  if (src.provider === "cfets-lpr") {
    return fetchCfetsWindows(
      `/cm-u-bk-currency/LprHis?${CFETS_LANG}`,
      "https://www.chinamoney.com.cn/chinese/lpr/",
      start, end, pickCfets(src.tenor || "1Y", "showDateCN")
    );
  }
  if (src.provider === "cfets-repo") {
    const tenor = src.tenor || "FDR007";
    return fetchCfetsWindows(
      `/cm-u-bk-currency/FrrHis?${CFETS_LANG}&reference=1&bank=100`,
      "https://www.chinamoney.com.cn/chinese/bkfrr/",
      start, end,
      (j, m) => {
        for (const r of j.records ?? []) {
          const map = r.frValueMap;
          if (map && map.date && map[tenor] != null && map[tenor] !== "") m.set(map.date, Number(map[tenor]));
        }
      }
    );
  }
  if (src.provider === "nyfed") {
    const p = NYFED_PATHS[src.series];
    if (!p) throw new Error(`unknown nyfed series: ${src.series}`);
    const j = await request(
      `https://markets.newyorkfed.org/api/rates/${p}/search.json?startDate=${start}&endDate=${end}`,
      "json"
    );
    const m = new Map();
    for (const r of j.refRates ?? []) {
      const val = src.field === "volume" ? r.volumeInBillions : src.field === "p99" ? r.percentPercentile99 : r.percentRate;
      if (val == null) continue;
      m.set(r.effectiveDate, Number(val));
    }
    return m;
  }
  if (src.provider === "nyfed-repo") {
    const want = src.series === "onrrp" ? "Reverse Repo" : "Repo";
    const m = new Map();
    await rpChunks(start, end, (op) => {
      if (op.operationType !== want || op.auctionStatus !== "Results") return;
      const acc = op.totalAmtAccepted / 1e9;
      let e = m.get(op.operationDate);
      if (!e) {
        e = { v: 0, settle: new Map() };
        m.set(op.operationDate, e);
      }
      e.v += acc;
      if (op.term === "Overnight") {
        e.settle.set(op.settlementDate, (e.settle.get(op.settlementDate) || 0) + acc);
      }
    });
    return m;
  }
  if (src.provider === "nyfed-rp-rate") {
    const want = src.series === "srf" ? "Repo" : "Reverse Repo";
    const m = new Map();
    await rpChunks(start, end, (op) => {
      if (op.operationType !== want || op.auctionStatus !== "Results") return;
      const t0 = (op.details || [])[0] || {};
      // stop-out 是竞价结果，可高于管理利率（如 2023-07-11 为 5.30）；管理利率取 offering/最低投标利率
      const rate =
        src.series === "srf"
          ? t0.percentOfferingRate ?? t0.minimumBidRate
          : t0.percentAwardRate ?? t0.percentOfferingRate ?? t0.percentStopOutRate ?? t0.minimumBidRate;
      if (rate != null) m.set(op.operationDate, rate);
    });
    return m;
  }
  if (src.provider === "fred") {
    const ids = Array.isArray(src.series) ? src.series : [src.series];
    const maps = await Promise.all(
      ids.map(async (id) => parseFred(await request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, "text")))
    );
    const m = new Map();
    for (const mm of maps) for (const [d, v] of mm) m.set(d, (m.get(d) || 0) + v);
    return m;
  }
  if (src.provider === "cds-feed") {
    return parseCdsFeed(src);
  }
  if (src.provider === "treasury-real") {
    return fetchTreasuryReal(src, start, end);
  }
  if (src.provider === "nasdaq") {
    return fetchNasdaq(src, start, end);
  }
  if (src.provider === "uk-trade") {
    return fetchUkTrade(src, start, end);
  }
  if (src.provider === "worldbank") {
    return fetchWorldBank(src, start, end);
  }
  if (src.provider === "uncomtrade") {
    return fetchUncomtrade(src, start, end);
  }
  throw new Error(`unknown provider: ${src.provider}`);
}

// Pluggable authoritative CDS snapshot: a CSV at data/cds/<file> with rows `date,spread_bp`.
// Supplies entitled/licensed per-name CDS (broker/terminal export, or the post-2029 Reg SBSR
// public dissemination feed) so the pipeline auto-computes weekly high and cross-verifies
// two independent files. Never fabricates: a missing or empty snapshot throws, degrading the
// row to a transparently-labeled gap.
function parseCdsFeed(src) {
  if (!src.file || !/^[\w.-]+$/.test(src.file)) throw new Error("cds-feed: invalid file");
  const p = path.join(DATA_DIR, "cds", src.file);
  if (!fs.existsSync(p)) throw new Error(`cds-feed: no entitled snapshot at data/cds/${src.file}`);
  const m = new Map();
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    if (!d || !v || v.trim() === "" || v === ".") continue;
    const n = Number(v);
    if (!Number.isNaN(n)) m.set(d.trim(), n);
  }
  if (!m.size) throw new Error(`cds-feed: data/cds/${src.file} has no rows`);
  return m;
}