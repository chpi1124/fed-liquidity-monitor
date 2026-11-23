// 纽约联储 SRF / ON RRP 操作利率：管理利率取 offering，不用 stop-out（stop-out 是竞价结果，可高于管理利率）
import { rpChunks } from "./_nyfed.js";

export default {
  id: "nyfed-rp-rate",
  org: "Federal Reserve Bank of New York",
  endpoints: ["https://markets.newyorkfed.org/api/rp/results/search.json"],
  cadence: "daily",
  incremental: "windowed",
  windowNote: "与 repo 共用操作结果端点，窄窗有效性同上未定论",
  note: "例：2023-07-11 的 stop-out 为 5.30，高于当期管理利率，故 srf 优先取 percentOfferingRate",
  fetch: async (src, start, end) => {
    const want = src.series === "srf" ? "Repo" : "Reverse Repo";
    const m = new Map();
    await rpChunks(start, end, (op) => {
      if (op.operationType !== want || op.auctionStatus !== "Results") return;
      const t0 = (op.details || [])[0] || {};
      const rate =
        src.series === "srf"
          ? t0.percentOfferingRate ?? t0.minimumBidRate
          : t0.percentAwardRate ?? t0.percentOfferingRate ?? t0.percentStopOutRate ?? t0.minimumBidRate;
      if (rate != null) m.set(op.operationDate, rate);
    });
    return m;
  },
};
