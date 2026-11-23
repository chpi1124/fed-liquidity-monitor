// 港交所 AI 指数：官方只提供 Factsheet PDF（无历史端点），取最新一期指数点位与截止日
import { request, pdfText } from "./_shared.js";

const PAGE = "https://www.hkex.com.hk/Services/Market-Data-Services/Index-Services/HKEX-Artificial-Intelligence-Index?sc_lang=en";
const MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };

export default {
  id: "hkex-factsheet",
  org: "HKEX (Hong Kong Exchanges and Clearing Limited)",
  endpoints: [PAGE],
  cadence: "monthly",
  incremental: "snapshot-only",
  windowNote: "官方只有最新一期 Factsheet PDF",
  fetch: async () => {
    const page = await request(PAGE, "html");
    const links = [...page.matchAll(/href="([^"]*HKEXAI[^"]*Factsheet[^"]*\.pdf)"/gi)].map((m) => m[1]);
    const rel = links.find((l) => !/Methodology/i.test(l));
    if (!rel) throw new Error("HKEX AI factsheet PDF link not found");
    const url = rel.startsWith("http") ? rel : "https://www.hkex.com.hk" + (rel.startsWith("/") ? "" : "/") + rel;
    const buf = await request(url, "buffer");
    const text = pdfText(buf);
    const lm = text.match(/Index Level[\s\S]{0,160}?HKEX AI ([\d,]+\.\d+)/i);
    if (!lm) throw new Error("HKEX AI index level not parsed from factsheet");
    const level = Number(lm[1].replace(/,/g, ""));
    const folder = url.match(/(\d{4})(\d{2})(\d{2})-HKEXAI-Factsheet/i);
    let asOf;
    if (folder) asOf = folder[1] + "-" + folder[2] + "-" + folder[3];
    else {
      const mm = text.match(/Index Factsheet (\w+) (20\d[\d ]*)/i);
      if (!mm || !(mm[1] in MONTHS)) throw new Error("HKEX AI factsheet month not parsed");
      const year = Number(mm[2].replace(/\s/g, ""));
      asOf = new Date(Date.UTC(year, MONTHS[mm[1]] + 1, 0)).toISOString().slice(0, 10);
    }
    const m = new Map();
    m.set(asOf, level);
    return m;
  },
};
