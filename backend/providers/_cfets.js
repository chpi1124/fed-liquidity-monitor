// 中国外汇交易中心（CFETS，央行下属官方发布机构）共享取数细节。下划线前缀 = 不是 provider。
// ⚠ 实测：ag 接口的日期过滤只在 lang=CN 下生效；lang=zh_CN 会被静默忽略并只回最近一页
// （FrrHis 22 行、LprHis 12 行），历史被截断且不报错。加分页类参数（pageSize/pageNum 等）
// 同样会退回「最新一页」，因此只用日期分窗取数。参数写法取自官方页面脚本。
import { request, dayRange } from "./_shared.js";

// 发布机构署名的唯一出处（4 个 CFETS provider 共用，避免同一事实写四遍）
export const ORG = "中国外汇交易中心（全国银行间同业拆借中心）";
export const AG = "https://www.chinamoney.com.cn/ags/ms";
export const CMS = "https://www.chinamoney.com.cn/r/cms/www/chinamoney";
export const LANG = "lang=CN";
const STEP = 180 * 86400000;

export async function windows(path, referer, start, end, extract) {
  const m = new Map();
  for (const [s, e] of dayRange(start, end, STEP)) {
    const j = await request(`${AG}${path}&startDate=${s}&endDate=${e}`, "json", referer);
    extract(j, m);
  }
  if (!m.size) throw new Error(`cfets ${path}: no rows`);
  return m;
}

export const pickTenor = (tenor, dateKey) => (j, m) => {
  for (const r of j.records ?? []) {
    const d = r[dateKey];
    const v = r[tenor];
    if (d && v != null && v !== "") m.set(d, Number(v));
  }
};
