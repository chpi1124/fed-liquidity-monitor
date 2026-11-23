// UN Comtrade 月度净环流（校验腿）：净重 netWgt 单位为 kg，除以 1000 得公吨。
// 公共预览端点每次只能查一个 period，且限流严格，故逐月取数并主动节流；
// 只取最近 maxMonths 个月（默认 6），个别月份失败则跳过（该月不计入校验，不造数）。
import { request } from "./_shared.js";

const ENDPOINT = "https://comtradeapi.un.org/public/v1/preview/C/M/HS";

export default {
  id: "uncomtrade",
  org: "UN Statistics Division (Comtrade)",
  endpoints: [ENDPOINT],
  cadence: "monthly",
  incremental: "monthly-step",
  windowNote: "公共预览逐月一次请求且限流；只请求新月份",
  fetch: async (src, start, end) => {
    const reporter = src.reporterCode || 826;
    const cmd = src.cmdCode || "7108";
    const months = [];
    let y = Number(start.slice(0, 4));
    let mo = Number(start.slice(5, 7));
    const ey = Number(end.slice(0, 4));
    const em = Number(end.slice(5, 7));
    while (y < ey || (y === ey && mo <= em)) {
      months.push(y + String(mo).padStart(2, "0"));
      if (++mo > 12) {
        mo = 1;
        y++;
      }
    }
    const take = months.slice(-(src.maxMonths || 6));
    const one = async (flow, period) => {
      const j = await request(ENDPOINT + "?reporterCode=" + reporter + "&cmdCode=" + cmd + "&flowCode=" + flow + "&partnerCode=0&period=" + period + "&format=JSON", "json");
      const row = (j?.data || [])[0];
      return row && row.netWgt != null ? Number(row.netWgt) : null;
    };
    const m = new Map();
    for (const p of take) {
      try {
        const [mi, mx] = await Promise.all([one("M", p), one("X", p)]);
        if (mi == null && mx == null) continue;
        m.set(p.slice(0, 4) + "-" + p.slice(4) + "-01", ((mi || 0) - (mx || 0)) / 1000);
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, src.paceMs || 2500));
    }
    if (!m.size) throw new Error("uncomtrade: 无可比月份（限流或官方尚未发布）");
    return m;
  },
};
