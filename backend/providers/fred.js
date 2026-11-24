// FRED（圣路易斯联储）公开 CSV 端点：无需密钥，用作官方第二源逐点交叉验证
// 两个端点：
//   · fredgraph（默认）：实时序列，值列固定第 2 列；
//   · alfredgraph（src.alfred: true）：ALFRED 老数据镜像，表头列名带 vintage 后缀
//     （如 VIXCLS_20261123，每次重录都会变），因此同样按列序号（第 2 列）取值。
// ALFRED 与 FRED 的当前 vintage 同值 ⇒ 用作「同源双端点一致性校验」（验证取数与
// 解析正确性），配置里必须如实标注这不是独立双源。
import { request } from "./_shared.js";

function parse(t) {
  const m = new Map();
  for (const line of t.split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    if (!d || !v || v.trim() === "." || v.trim() === "") continue;
    m.set(d.trim(), Number(v));
  }
  return m;
}

export default {
  id: "fred",
  org: "Federal Reserve Bank of St. Louis (FRED)",
  endpoints: ["https://fred.stlouisfed.org/graph/fredgraph.csv", "https://alfred.stlouisfed.org/graph/alfredgraph.csv"],
  cadence: "daily-varies",
  incremental: "tail",
  windowNote: "官方 CSV 直接给全序列，窄窗实测 7 行；校验腿同样受益",
  note: "多序列时逐条取回后按日期相加（官方分量合成口径，指标配置里声明 series 数组）；src.alfred 走 ALFRED vintage 端点",
  fetch: async (src) => {
    const ids = Array.isArray(src.series) ? src.series : [src.series];
    const maps = await Promise.all(
      ids.map(async (id) => {
        const host = src.alfred ? "https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=" : "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
        return parse(await request(host + id, "text"));
      })
    );
    const m = new Map();
    for (const mm of maps) for (const [d, v] of mm) m.set(d, (m.get(d) || 0) + v);
    return m;
  },
};
