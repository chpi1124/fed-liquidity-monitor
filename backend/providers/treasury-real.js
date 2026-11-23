// 美国财政部每日实际（通胀挂钩）收益率曲线：按年 CSV 分文件，期限列由配置声明
import { request, usDate, yearRange } from "./_shared.js";

const BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";

export default {
  id: "treasury-real",
  org: "U.S. Department of the Treasury",
  endpoints: [BASE],
  cadence: "daily-1730",
  incremental: "windowed",
  windowNote: "按年一个 CSV 文件；水位线推进可把一年 12 次请求降到 1 次",
  note: "缺年份文件直接跳过（官方尚未发布即不回补），全部窗口无行才报错",
  fetch: async (src, start, end) => {
    const tenor = src.tenor || "10 YR";
    const key = tenor.replace(/\s/g, "");
    const m = new Map();
    for (const y of yearRange(start, end)) {
      let txt;
      try {
        txt = await request(BASE + "/" + y + "/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=" + y + "&_format=csv", "text");
      } catch {
        continue;
      }
      const lines = txt.trim().split(/\r?\n/);
      if (lines.length < 2) continue;
      const head = lines[0].split(",").map((s) => s.replace(/"/g, "").trim());
      const col = head.findIndex((h) => h.replace(/\s/g, "") === key);
      if (col < 0) continue;
      for (const line of lines.slice(1)) {
        const cells = line.split(",");
        const d = usDate(cells[0]);
        const v = cells[col] == null ? "" : cells[col].replace(/"/g, "").trim();
        if (!d || v === "" || v === "." || v === "N/A") continue;
        if (d >= start && d <= end) m.set(d, Number(v));
      }
    }
    if (!m.size) throw new Error("treasury-real tenor " + tenor + ": no rows");
    return m;
  },
};
