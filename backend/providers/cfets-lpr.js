// LPR（贷款市场报价利率）：每月 20 日官方公布，历史端点同样受 lang=CN 日期过滤限制
import { AG, LANG, ORG, windows, pickTenor } from "./_cfets.js";

export default {
  id: "cfets-lpr",
  org: ORG,
  endpoints: [AG + "/cm-u-bk-currency/LprHis"],
  cadence: "monthly-20",
  incremental: "rolling-guard",
  windowNote: "LprHis 恒回 12 期（与区间无关）⇒ 硬红线 B-7：只 upsert 新期次，禁止覆盖历史",
  fetch: (src, start, end) =>
    windows("/cm-u-bk-currency/LprHis?" + LANG, "https://www.chinamoney.com.cn/chinese/lpr/", start, end, pickTenor(src.tenor || "1Y", "showDateCN")),
};
