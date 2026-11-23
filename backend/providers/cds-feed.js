// 可插拔的授权 CDS 快照：data/cds/<file> 一份 CSV（行格式 date,spread_bp）。
// 用于接入需付费/授权的单名 CDS（经纪商或终端导出，以及 2029 年后 Reg SBSR 公开分发数据），
// 使管道能自动算周度高点并对两份独立文件交叉验证。缺文件/空文件一律抛错降级为透明缺口，绝不造数。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.js";

export default {
  id: "cds-feed",
  org: "Licensed CDS dissemination (operator-supplied snapshot)",
  endpoints: ["file://data/cds/"],
  cadence: "weekly",
  incremental: "snapshot-only",
  windowNote: "授权快照文件由运维投放，逐日累积不回补",
  fetch: (src) => {
    if (!src.file || !/^[\w.-]+$/.test(src.file)) throw new Error("cds-feed: invalid file");
    const p = path.join(DATA_DIR, "cds", src.file);
    if (!fs.existsSync(p)) throw new Error("cds-feed: no entitled snapshot at data/cds/" + src.file);
    const m = new Map();
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1)) {
      const [d, v] = line.split(",");
      if (!d || !v || v.trim() === "" || v === ".") continue;
      const n = Number(v);
      if (!Number.isNaN(n)) m.set(d.trim(), n);
    }
    if (!m.size) throw new Error("cds-feed: data/cds/" + src.file + " has no rows");
    return m;
  },
};
