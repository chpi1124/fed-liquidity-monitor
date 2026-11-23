// 美联储政策事件解析（加息 / 降息 / 按兵不动 / 缩表 / 缩表放缓 / 结束缩表 / 扩表）。
// 唯一出处：本文件解析，backend/lib/policy.js 推得幅度并写库生成标签；前端与门禁不得再写一份（G25）。
// 三条硬规矩：
//  1) 一页可以同时给出利率动作与资产负债表动作 ⇒ 各产一行事件，各行只带自己那条动作的依据句；
//  2) 依据句必须来自官方原文句子本身 —— 页面模板（导航/FAQ/Transcripts 列表）也含 balance sheet 字样，
//     整段 match 会把模板噪声当证据，因此只在含政策关键词的句子中取证；
//  3) 解析不到就不产出：利率动作必须同时拿到目标区间；缩表数字取不到时只记动作、绝不编月度上限。
import { request } from "./_shared.js";

const CALENDAR = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
// 官方清单两处（实测覆盖不同，取并集才连续）：
//  · fomccalendars.htm ⇒ 2021-01 起（48 次）
//  · fomchistorical{YEAR}.htm ⇒ 2016–2020，每年一页
const HIST = "https://www.federalreserve.gov/monetarypolicy/fomchistorical";
const BASE = "https://www.federalreserve.gov";

const iso = (s) => s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);

function collectLinks(html) {
  const out = new Map();
  for (const m of html.matchAll(/href="(\/newsevents\/pressreleases\/monetary(\d{8})([a-z]))\.htm"/g)) {
    out.set(m[2] + m[3], { path: m[1], date: iso(m[2]), tail: m[3] });
  }
  return [...out.values()];
}

const clean = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#39;|&#x27;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/[\u2011-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

// 官方用分数与带分数：5、4-3/4、3/8、1/2、0
function fraction(s) {
  const t = String(s).trim();
  const mixed = t.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (mixed) {
    const den = Number(mixed[3]);
    return den ? Number(mixed[1]) + Number(mixed[2]) / den : null;
  }
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    return den ? Number(frac[1]) / den : null;
  }
  const dec = t.match(/^(\d+(?:\.\d+)?)$/);
  return dec ? Number(dec[1]) : null;
}

function parseRange(s) {
  const parts = String(s).split(/\s+to\s+/i);
  if (parts.length !== 2) return null;
  const lo = fraction(parts[0]);
  const hi = fraction(parts[1]);
  return lo == null || hi == null ? null : [lo, hi];
}

function parseDelta(s) {
  const n = fraction(String(s).trim().replace(/\s*percentage\s+points?/i, ""));
  return n == null ? null : Number((n * 100).toFixed(1));
}

// 只在「含政策关键词的句子」里取证；must 用于排除模板句，not 用于排除引用句
function sentenceWith(t, re, must, not) {
  for (const s of t.split(/(?<=[.!?])\s+/)) {
    if (!re.test(s)) continue;
    if (must && !must.test(s)) continue;
    // 引用句不算新动作：如「将继续缩减……正如 5 月发布的《缩减计划》所述」——动作在那份文件里已经标过一次
    if (not && not.test(s)) continue;
    return s.trim().slice(0, 260);
  }
  return "";
}

// 指回既有文件的措辞（described/detailed/issued in ...）= 转述，不是新的政策动作
const REFERENCE = /\b(?:described|detailed|set out|outlined|discussed|announced|issued|published|explained)\b[^.]{0,60}\bin\b/i;

// 月度缩减上限：官方句式 initially be set at $30 billion per month and after three months will increase to $60 billion
// 取文中出现过的最大月度数作稳态上限；多个资产类别各自的上限不在这里相加（那不是官方给出的合计数）
function monthlyCaps(t) {
  const found = [...t.matchAll(/\$([\d.]+) billion (?:per month|each month|monthly)/gi)].map((m) => Number(m[1]));
  return found.length ? Math.max(...found) : null;
}

const QE = /resume(?:d)? (?:purchases|adding to|the purchase of)|purchase Treasury bills to maintain|longer-run purchases of Treasury bills|increase (?:the size of )?(?:its|the) balance sheet|reinvest(?:ment)? .{0,60}(?:at a larger scale|into Treasury bills)/i;
const QT_END = /cease(?:d)? (?:the )?(?:balance sheet )?reduction|end (?:the )?(?:balance sheet )?(?:reduction|run[- ]off|program)|complete(?:d)? (?:the )?balance sheet reduction|conclude(?:d)? (?:the )?(?:run[- ]off|balance sheet reduction|program)/i;
const QT_SLOW = /slow(?:ing)? (?:the pace of )?(?:the )?(?:balance sheet )?(?:reduction|run[- ]off)|reduce (?:the )?(?:monthly )?(?:cap|redemption cap|amounts)|lower(?:ing)? (?:the )?(?:monthly )?(?:cap|run[- ]off cap)|at a slower pace/i;
// 新动作的严格措辞：计划 / 开始 / 着手 / 批准额外步骤 / 缩小规模 / 缩减计划本身
const BEGIN_STRICT = /(?:plans? (?:to|for) (?:reduce|reducing)|begin(?:ning)? (?:the )?(?:process of )?(?:reducing|run[- ]off|normali[sz]ation)|will (?:begin|commence) reducing|commence(?:d|s)? (?:the )?reduction|approve[d]? (?:additional|the) balance sheet|additional balance sheet actions|reduce the size of the (?:Federal Reserve'?s )?balance sheet|balance sheet reduction program)/i;
// 例行重申（将继续缩减）：只作为附注，不算新动作
const QT_ROUTINE = /continue (?:reducing|to reduce)[^.]{0,200}(?:holdings|balance sheet)|ongoing reduction of the balance sheet/i;

// 四类动作一律按「句」判定，并且排除指回既有文件的转述句：
// 转述句在每次例会声明里都会出现（“将继续缩减……正如 5 月发布的《缩减计划》所述”），
// 按整页 match 会把每次会议都标成一次新的缩表动作。
function balanceSheet(t) {
  const monthly = monthlyCaps(t);
  const must = /balance sheet|run[- ]off|reinvestment|cap|Treasury|securities|\$/i;
  const sentence = (re) => sentenceWith(t, re, must, REFERENCE);
  const qe = sentence(QE);
  if (qe) return { action: "qe", explicit: true, monthly, note: "恢复买入或扩大资产负债表", quote: qe };
  const end = sentence(QT_END);
  if (end) return { action: "qt-end", explicit: true, monthly: 0, note: "宣布结束缩表", quote: end };
  const slow = sentence(QT_SLOW);
  if (slow && !/continue (?:reducing|to reduce)/i.test(slow)) return { action: "qt-slow", explicit: true, monthly, note: "放缓缩表节奏或下调月度上限", quote: slow };
  const begin = sentence(BEGIN_STRICT);
  if (begin) return { action: "qt", explicit: true, monthly, note: "宣布开始或实施资产负债表缩减", quote: begin };
  if (sentenceWith(t, QT_ROUTINE)) return { action: "qt-continue", explicit: false, monthly, note: "例行重申继续缩表", quote: "" };
  return { action: "none", explicit: false, monthly: null, note: "", quote: "" };
}

// 返回该页给出的 0～2 条事件：利率动作一条，资产负债表动作一条
function parsePage(html, url) {
  const t = clean(html);
  const title = ((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || "")
    .replace(/&#39;/g, "'")
    .replace(/\s*\|.*$/, "")
    .trim();
  // 标题也是官方证据：缩表计划往往单独成一篇公告，标题即写明动作
  const bs = balanceSheet(title + ". " + t);
  const out = [];
  const dec = t.match(/decided to (lower|raise|maintain|keep)[^.]{0,300}?\s(?:to|at)\s([\d/\-]+(?:\/\d+)?\s+to\s+[\d/\-]+(?:\/\d+)?)\s+percent/i);
  if (dec) {
    const range = parseRange(dec[2]);
    if (range) {
      const verb = dec[1].toLowerCase();
      const action = verb === "lower" ? "cut" : verb === "raise" ? "hike" : "hold";
      const explicit = t.match(/by\s+([\d/]+(?:-\d+\/\d+)?)\s+percentage\s+point/i);
      out.push({
        action,
        deltaBp: action === "hold" ? 0 : explicit ? parseDelta(explicit[1]) : null,
        deltaSource: action === "hold" ? "声明维持原区间" : explicit ? "官方声明原文" : null,
        rangeLo: range[0],
        rangeHi: range[1],
        bsAction: bs.action,
        monthlyCapBillion: bs.monthly,
        title,
        quote: sentenceWith(t, /decided to (?:lower|raise|maintain|keep)/i, /percent/),
        url,
        source: "Board of Governors of the Federal Reserve System · FOMC 声明",
      });
    }
  }
  if (bs.explicit) {
    out.push({
      action: bs.action,
      deltaBp: null,
      deltaSource: null,
      rangeLo: null,
      rangeHi: null,
      bsAction: bs.action,
      monthlyCapBillion: bs.monthly,
      title,
      quote: bs.quote || sentenceWith(title + ". " + t, /balance sheet|run[- ]off|reinvestment|cap|purchas/i, /balance sheet|run[- ]off|cap|purchas|Treasury/i),
      bsNote: bs.note,
      url,
      source: "Board of Governors of the Federal Reserve System · FOMC 声明或配套公告",
    });
  }
  return out;
}

export default {
  id: "fed-policy",
  org: "Board of Governors of the Federal Reserve System",
  endpoints: [CALENDAR, HIST + "2020.htm"],
  cadence: "per-meeting",
  incremental: "windowed",
  windowNote: "官方清单页一次给出全年决议链接；本站只取回晚于库里最新事件的页面，历史不回补",
  note: "事件由声明/公告原文解析得到；缺区间或缺动作即不产出（不猜、不补）",

  async fetch(src, start, end) {
    const all = new Map();
    const cal = await request(CALENDAR, "html");
    for (const l of collectLinks(cal)) all.set(l.path, l);
    const calYears = [...all.values()].map((l) => l.date.slice(0, 4)).sort();
    const earliestCalYear = calYears.length ? Number(calYears[0]) : new Date().getFullYear();
    const fromYear = Number(String(start || "2016-01-01").slice(0, 4)) || 2016;
    const gaps = [];
    for (let y = Math.min(fromYear, earliestCalYear); y < earliestCalYear; y++) {
      try {
        for (const l of collectLinks(await request(HIST + y + ".htm", "html"))) all.set(l.path, l);
      } catch (e) {
        gaps.push("官方历史页 " + y + " 取不到：" + String(e.message).slice(0, 60));
      }
    }
    const links = [...all.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const todo = links.filter((l) => (!start || l.date > start) && (!end || l.date <= end));
    const events = [];
    const skipped = [...gaps];
    for (const l of todo) {
      const url = BASE + l.path + ".htm";
      let html;
      try {
        html = await request(url, "html");
      } catch (e) {
        skipped.push(l.date + l.tail + " 取回失败：" + String(e.message).slice(0, 60));
        continue;
      }
      const evs = parsePage(html, url);
      if (!evs.length) {
        skipped.push(l.date + l.tail + " 未解析出可核验的政策动作（例行重申不算新动作）");
        continue;
      }
      for (const ev of evs) events.push(Object.assign({ date: l.date }, ev, { tag: l.tail }));
    }
    return { events, skipped, links: links.length, fetched: todo.length };
  },
};
