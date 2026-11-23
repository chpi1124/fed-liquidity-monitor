// 纽约联储官方利率端点（SOFR / EFFR 等）：T+1 发布
import { request } from "./_shared.js";
import { RATES, RATE_PATHS } from "./_nyfed.js";

export default {
  id: "nyfed",
  org: "Federal Reserve Bank of New York",
  endpoints: [RATES],
  cadence: "daily-t1",
  incremental: "tail",
  windowNote: "/api/rates 认 startDate/endDate，窄窗实测 6 行",
  note: "取哪一列由指标配置决定（rate / volume / p99），不在代码里分序列写分支",
  fetch: async (src, start, end) => {
    const p = RATE_PATHS[src.series];
    if (!p) throw new Error("unknown nyfed series: " + src.series + "（已登记：" + Object.keys(RATE_PATHS).join(", ") + "）");
    const j = await request(RATES + "/" + p + "/search.json?startDate=" + start + "&endDate=" + end, "json");
    const m = new Map();
    for (const r of j.refRates ?? []) {
      const val = src.field === "volume" ? r.volumeInBillions : src.field === "p99" ? r.percentPercentile99 : r.percentRate;
      if (val == null) continue;
      m.set(r.effectiveDate, Number(val));
    }
    return m;
  },
};
