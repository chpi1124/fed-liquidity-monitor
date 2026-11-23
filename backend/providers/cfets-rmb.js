// 人民币汇率中间价：官方当日发布端点（一次只回最新一个日期，历史不可回补）
import { CMS, ORG } from "./_cfets.js";
import { request } from "./_shared.js";

function parse(j, pair) {
  const rec = (j.records || []).find((x) => x.vrtEName === pair || x.vrtName === pair);
  if (!rec) throw new Error("cfets rmb parity: pair " + pair + " not found");
  const d = (j.data && j.data.lastDate ? String(j.data.lastDate).slice(0, 10) : "") || new Date().toISOString().slice(0, 10);
  const m = new Map();
  m.set(d, Number(rec.price));
  return m;
}

export default {
  id: "cfets-rmb",
  org: ORG,
  endpoints: [CMS + "/data/fx/ccpr.json"],
  cadence: "daily-0915",
  incremental: "snapshot-only",
  windowNote: "官方只给最新一日中间价，历史靠本地累积",
  note: "官方只给最新一日的中间价；本站按日累积，不回补历史（不造数）",
  fetch: async (src) => parse(await request(CMS + "/data/fx/ccpr.json", "json", "https://www.chinamoney.com.cn/chinese/bkccpr/"), src.pair || "USD/CNY"),
};
