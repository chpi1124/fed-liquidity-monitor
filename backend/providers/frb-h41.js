import { request } from "./_shared.js";
import { H41_URL, parseStatement } from "./_h41.js";

export default {
  id: "frb-h41",
  org: "Board of Governors of the Federal Reserve System",
  endpoints: [H41_URL],
  cadence: "weekly-thu",
  incremental: "snapshot-only",
  windowNote: "H.4.1 current 只含本期/上周/去年同期，历史靠本地留存",
  note: "H.4.1 只有 HTML（无 CSV/JSON 端点），周四发布覆盖截至周三的数据",
  fetch: async () => parseStatement(await request(H41_URL, "html")),
};
