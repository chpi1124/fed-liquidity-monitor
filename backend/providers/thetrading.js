// ICE BofA MOVE 指数的公开转载源（TheTrading.tools）：ICE 官方 API 需商业许可，
// Yahoo/WSJ/Investing/Cboe 等公开分发渠道全部反爬拦截（2026-11-24 实测 403/401），
// 该转载 CSV 是唯一可编程获得的日频全史（2002-11 起，与公开行情页互证）。
// 口径与局限在 specs/degraded-sources.json 登记，指标描述同步如实标注——不是 ICE 官方一手源。
import { request } from "./_shared.js";

export default {
  id: "thetrading",
  org: "TheTrading.tools (redistribution of ICE BofA index closes)",
  endpoints: ["https://www.thetrading.tools/data/indicators/"],
  cadence: "daily-close",
  incremental: "tail",
  windowNote: "转载 CSV 直接给全序列，窄窗实测 ~1 行",
  note: "非官方转载源：ICE 官方需许可；值与公开行情页抽样互证后使用，绝不冒充 ICE 一手源",
  fetch: async (src) => {
    if (!src.file || !/^[\w-]+$/.test(src.file)) throw new Error("thetrading: invalid file");
    const t = await request("https://www.thetrading.tools/data/indicators/" + src.file + ".csv", "text");
    const m = new Map();
    const lines = t.trim().split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim());
    const di = head.indexOf("date");
    const vi = head.indexOf(src.valueCol || "value");
    if (di < 0 || vi < 0) throw new Error("thetrading: unexpected header " + head.join(","));
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const d = (c[di] || "").trim();
      const v = Number((c[vi] || "").trim());
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v)) m.set(d, v);
    }
    if (!m.size) throw new Error("thetrading " + src.file + ": no rows");
    return m;
  },
};
