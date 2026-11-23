// 纽约联储 Markets（官方）共享细节：回购/逆回购操作结果按年分窗。下划线前缀 = 不是 provider。
import { request, yearRange } from "./_shared.js";

export const RP_RESULTS = "https://markets.newyorkfed.org/api/rp/results/search.json";
export const RATES = "https://markets.newyorkfed.org/api/rates";
// 官方利率端点的序列路径（新增序列 = 在这里加一行数据，不改 provider 逻辑）
export const RATE_PATHS = { sofr: "secured/sofr", effr: "unsecured/effr" };

export async function rpChunks(start, end, visit) {
  for (const y of yearRange(start, end)) {
    const s = y === Number(start.slice(0, 4)) ? start : `${y}-01-01`;
    const e = y === Number(end.slice(0, 4)) ? end : `${y}-12-31`;
    const j = await request(`${RP_RESULTS}?startDate=${s}&endDate=${e}`, "json");
    for (const op of j.repo?.operations ?? []) visit(op);
  }
}
