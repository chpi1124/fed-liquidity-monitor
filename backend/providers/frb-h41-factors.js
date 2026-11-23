import { request } from "./_shared.js";
import { H41_URL, parseFactors } from "./_h41.js";

export default {
  id: "frb-h41-factors",
  org: "Board of Governors of the Federal Reserve System",
  endpoints: [H41_URL],
  cadence: "weekly-thu",
  incremental: "snapshot-only",
  windowNote: "同一份文件的日平均因子表",
  note: "同一份 H.4.1 的「日平均因子表」：准备金余额与各分项的日均值口径",
  fetch: async () => parseFactors(await request(H41_URL, "html")),
};
