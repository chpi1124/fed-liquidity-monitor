// 世界银行大宗商品价格数据（Pink Sheet）月度 XLSX：官方国际组织，金价以美元/金衡盎司计。
// 下载链接从官方页面自动发现，不写死带哈希的 URL（该哈希随发布批次变化）。
import { request, xlsxSheet } from "./_shared.js";

const PAGE = "https://www.worldbank.org/en/research/commodity-markets";

export default {
  id: "worldbank",
  org: "World Bank Commodity Markets",
  endpoints: [PAGE],
  cadence: "monthly",
  incremental: "whole-file",
  windowNote: "Pink Sheet 月度 XLSX 是整文件；仍下整文件，但只对新增/变化月份 upsert",
  fetch: async (src, start, end) => {
    const page = await request(PAGE, "html");
    const rel = (page.match(/href="([^"]*CMO-Historical-Data-Monthly[^"]*\.xlsx)"/i) || [])[1];
    if (!rel) throw new Error("worldbank: monthly XLSX link not found on the commodity-markets page");
    const url = rel.startsWith("http") ? rel : "https:" + rel;
    const buf = await request(url, "buffer");
    const { rows, cell } = xlsxSheet(buf, src.sheet || "Monthly Prices");
    const label = String(src.column || "Gold").trim().toLowerCase();
    const periodCol = src.periodCol || "A";
    let col = null;
    for (const [, rowXml] of rows.slice(0, 15)) {
      for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const v = cell(rowXml, m[1]);
        if (v != null && String(v).trim().toLowerCase() === label) col = m[1];
      }
      if (col) break;
    }
    if (!col) throw new Error("worldbank: column " + (src.column || "Gold") + " not found");
    const lo = start.slice(0, 7);
    const hi = end.slice(0, 7);
    const m = new Map();
    for (const [, rowXml] of rows) {
      const per = String(cell(rowXml, periodCol) || "");
      const pm = per.match(/^(\d{4})M(\d{2})$/);
      if (!pm) continue;
      const ym = pm[1] + "-" + pm[2];
      if (ym < lo || ym > hi) continue;
      const raw = cell(rowXml, col);
      const v = raw == null ? NaN : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(v)) continue;
      m.set(ym + "-01", v);
    }
    if (!m.size) throw new Error("worldbank: no rows for column " + col);
    return m;
  },
};
