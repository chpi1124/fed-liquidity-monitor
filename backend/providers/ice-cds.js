// ICE Clear Credit 官方公开结算价：5Y 单名 CDS 的 EOD points-upfront 价格。
// 端点由 ICE 官网公开（免登录）：https://www.ice.com/api/cds-settlement-prices/icc-single-names
// 注意：这是 ICE 官方发布的结算价本身，不折算 bp、不补期限曲线、不混入媒体转述；
// 使用条款限制再分发，本站只作本地监控展示原始点位并署名 ICE Clear Credit。
import { request } from "./_shared.js";

const API = "https://www.ice.com/api/cds-settlement-prices/icc-single-names";

export default {
  id: "ice-cds",
  org: "ICE Clear Credit (official public 5Y single-name CDS settlement prices)",
  endpoints: [API, "https://www.ice.com/cds-settlement-prices/icc/single-name-instruments"],
  cadence: "daily-close",
  incremental: "snapshot-only",
  windowNote: "ICE 公开端点返回最近清算日快照（通常含当日与前一日）；只取 USD/SNRFOR/100 票息基准合约",
  fetch: async (src) => {
    if (!src.code || !/^[A-Z0-9.-]+$/.test(src.code)) throw new Error("ice-cds: invalid code");
    const coupon = String(src.coupon ?? "100");
    const rows = await request(API, "json");
    if (!Array.isArray(rows) || !rows.length) throw new Error("ice-cds: empty settlement snapshot");
    const prefix = `${src.code}.SNRFOR.USD.`;
    const pick = rows
      .filter((r) => r && typeof r.instrumentName === "string" && r.instrumentName.startsWith(prefix))
      .filter((r) => r.instrumentName.includes(`.${coupon}.`))
      .filter((r) => r.clearingDate && r.eodPrice != null && r.eodPrice !== "")
      .map((r) => ({ d: String(r.clearingDate).slice(0, 10), v: Number(r.eodPrice) }))
      .filter((r) => Number.isFinite(r.v))
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (!pick.length) throw new Error(`ice-cds: no USD/SNRFOR/${coupon} contract for ${src.code}`);
    const m = new Map();
    for (const r of pick) m.set(r.d, r.v); // 同日多档合约只保留官方基准 100 票息
    return m;
  },
};
