// 存款类机构质押式回购加权利率（DR/R 系列）：官方按日发布，期限值藏在 frValueMap 里
import { AG, LANG, ORG, windows } from "./_cfets.js";

const PATH = "/cm-u-bk-currency/FrrHis";

export default {
  id: "cfets-repo",
  org: ORG,
  endpoints: [AG + PATH],
  cadence: "daily-1700",
  incremental: "tail",
  windowNote: "FrrHis 认日期区间（只在 lang=CN 下生效）",
  fetch: (src, start, end) => {
    const tenor = src.tenor || "FDR007";
    return windows(
      PATH + "?" + LANG + "&reference=1&bank=100",
      "https://www.chinamoney.com.cn/chinese/bkfrr/",
      start,
      end,
      (j, m) => {
        for (const r of j.records ?? []) {
          const map = r.frValueMap;
          if (map && map.date && map[tenor] != null && map[tenor] !== "") m.set(map.date, Number(map[tenor]));
        }
      }
    );
  },
};
