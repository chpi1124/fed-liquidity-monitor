// 交易所行情（黄金 ETF GLD 等）：官方端点单次上限约 2513 行，按约 9 年窗口分段合并
import { request, usDate, dayRange } from "./_shared.js";

const STEP = 9 * 365 * 86400000;

export default {
  id: "nasdaq",
  org: "Nasdaq, Inc. (exchange-published market data)",
  endpoints: ["https://api.nasdaq.com/api/quote"],
  cadence: "daily-close",
  incremental: "tail",
  windowNote: "公开端点认 fromdate/todate，单次上限约 2513 行",
  fetch: async (src, start, end) => {
    const sym = src.symbol;
    if (!sym || !/^[\w.=:-]+$/.test(sym)) throw new Error("nasdaq: invalid symbol");
    const cls = src.assetclass || "etf";
    const m = new Map();
    for (const [s, e] of dayRange(start, end, STEP)) {
      const j = await request(
        "https://api.nasdaq.com/api/quote/" + sym + "/historical?assetclass=" + cls + "&fromdate=" + s + "&todate=" + e + "&limit=10000",
        "json",
        { referer: "https://www.nasdaq.com/", origin: "https://www.nasdaq.com" }
      );
      for (const r of j?.data?.tradesTable?.rows ?? []) {
        const d = usDate(r.date);
        const v = String(r.close || "").replace(/[$,]/g, "").trim();
        if (d && v && v !== "." && v !== "N/A") m.set(d, Number(v));
      }
    }
    if (!m.size) throw new Error("nasdaq " + sym + ": no rows");
    return m;
  },
};
