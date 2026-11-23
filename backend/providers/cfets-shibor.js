
// Shibor（上海银行间同业拆放利率）：官方按期限逐日发布，日期过滤只在 lang=CN 下生效（见 _cfets.js）
import { AG, LANG, ORG, windows, pickTenor } from "./_cfets.js";

export default {
  id: "cfets-shibor",
  org: ORG,
  endpoints: [AG + "/cm-u-bk-shibor/ShiborHis"],
  cadence: "daily-1100",
  incremental: "windowed",
  windowNote: "官方历史端点单次约 250 行上限，须日期分窗",
  note: "官方历史端点单次最多约 250 天，按 180 天分窗合并",
  fetch: (src, start, end) =>
    windows("/cm-u-bk-shibor/ShiborHis?" + LANG + "&reference=1&bank=100", "https://www.chinamoney.com.cn/chinese/swhitmbj/", start, end, pickTenor(src.tenor || "ON", "showDateCN")),
};
