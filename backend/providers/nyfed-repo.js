// 纽约联储回购/逆回购操作规模（官方操作结果，按年分窗）
import { rpChunks } from "./_nyfed.js";

export default {
  id: "nyfed-repo",
  org: "Federal Reserve Bank of New York",
  endpoints: ["https://markets.newyorkfed.org/api/rp/results/search.json"],
  cadence: "daily",
  incremental: "windowed",
  windowNote: "/api/rp 按年分窗；本次窄窗探测未取得有效 JSON ⇒ 按门禁纪律不放宽为 tail",
  note: "同一天多笔操作累加；隔夜笔另记结算日口径，供期限结构校验",
  fetch: async (src, start, end) => {
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
      if (op.term === "Overnight") e.settle.set(op.settlementDate, (e.settle.get(op.settlementDate) || 0) + acc);
    });
    return m;
  },
};
