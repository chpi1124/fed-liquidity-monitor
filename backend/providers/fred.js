// FRED（圣路易斯联储）公开 CSV 端点：无需密钥，用作官方第二源逐点交叉验证
import { request } from "./_shared.js";

function parse(t) {
  const m = new Map();
  for (const line of t.split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    if (!d || !v || v === ".") continue;
    m.set(d, Number(v));
  }
  return m;
}

export default {
  id: "fred",
  org: "Federal Reserve Bank of St. Louis (FRED)",
  endpoints: ["https://fred.stlouisfed.org/graph/fredgraph.csv"],
  cadence: "daily-varies",
  incremental: "tail",
  windowNote: "官方 CSV 直接给全序列，窄窗实测 7 行；校验腿同样受益",
  note: "多序列时逐条取回后按日期相加（官方分量合成口径，指标配置里声明 series 数组）",
  fetch: async (src) => {
    const ids = Array.isArray(src.series) ? src.series : [src.series];
    const maps = await Promise.all(ids.map(async (id) => parse(await request("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id, "text"))));
    const m = new Map();
    for (const mm of maps) for (const [d, v] of mm) m.set(d, (m.get(d) || 0) + v);
    return m;
  },
};
