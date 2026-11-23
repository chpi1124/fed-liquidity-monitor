// HMRC UK Trade Info（英国税务海关总署官方对外贸易统计 OData 服务）。
// $apply 服务端聚合已实测与逐行求和完全一致，且不受分页行数截断影响，故单次请求取全序列。
// ⚠ HS 71082000「Monetary gold 货币黄金」必须包含：只取 710811/710812 会把月度净环流量级压低约 100 倍
// （2024-01：全口径进口 66.1 吨 vs 仅非货币 0.68 吨），且会人为造出「几乎每月净流入」的假象。
import { request } from "./_shared.js";

const BASE = "https://api.uktradeinfo.com";
const GOLD_CN8 = [71081100, 71081200, 71081310, 71081380, 71082000];
const IMPORT_FLOWS = new Set([1, 3]);
const EXPORT_FLOWS = new Set([2, 4]);

export default {
  id: "uk-trade",
  org: "HMRC (His Majesty Revenue and Customs)",
  endpoints: [BASE + "/OTS"],
  cadence: "monthly",
  incremental: "monthly-step",
  windowNote: "$apply 月度聚合，按月尾取即可",
  fetch: async (src, start, end) => {
    const ids = src.commodity || GOLD_CN8;
    if (!ids.every((n) => Number.isInteger(n))) throw new Error("uk-trade: invalid commodity ids");
    const from = Number(start.slice(0, 7).replace("-", ""));
    const to = Number(end.slice(0, 7).replace("-", ""));
    const filter = "(" + ids.map((i) => "CommodityId eq " + i).join(" or ") + ") and MonthId ge " + from + " and MonthId le " + to;
    const apply = "filter(" + filter + ")/groupby((MonthId,FlowTypeId),aggregate(NetMass with sum as kg))";
    const j = await request(BASE + "/OTS?$apply=" + encodeURIComponent(apply) + "&$format=json", "json", { referer: "https://www.uktradeinfo.com/" });
    const rows = j?.value;
    if (!Array.isArray(rows)) throw new Error("uk-trade: unexpected payload");
    const flows = new Map();
    for (const r of rows) {
      if (!IMPORT_FLOWS.has(r.FlowTypeId) && !EXPORT_FLOWS.has(r.FlowTypeId)) continue;
      const p = String(r.MonthId);
      const d = p.slice(0, 4) + "-" + p.slice(4, 6) + "-01";
      const o = flows.get(d) || { imp: 0, exp: 0 };
      if (IMPORT_FLOWS.has(r.FlowTypeId)) o.imp += r.kg || 0;
      else o.exp += r.kg || 0;
      flows.set(d, o);
    }
    const measure = src.measure || "net";
    const m = new Map();
    for (const [d, o] of [...flows.entries()].sort()) {
      const kg = measure === "import" ? o.imp : measure === "export" ? o.exp : o.imp - o.exp;
      m.set(d, kg / 1000);
    }
    if (!m.size) throw new Error("uk-trade: no rows");
    return m;
  },
};
