import { loadIndicators, updateIndicator } from "./backend/lib/indicators.js";
import * as store from "./backend/lib/store.js";

const ids = process.argv.slice(2);
for (const cfg of loadIndicators()) {
  if (ids.length && !ids.includes(cfg.id)) continue;
  const t0 = Date.now();
  try {
    const d = await updateIndicator(cfg, { force: true, prev: store.read(cfg.id) });
    store.write(cfg.id, d);
    const v = d.validation;
    const ic = d.integrity;
    console.log(
      `${cfg.id}: n=${d.points.length} ${d.points[0]?.d}..${d.points[d.points.length - 1]?.d} | 校验 ${v.matched}/${v.checked} 不符${v.mismatched} 无检查日${v.uncheckedDates} | 自检 ${ic.verdict} 存疑${ic.counts.range + ic.counts.jump + ic.counts.cross + ic.counts.mismatch} 滞后${ic.counts.stale} 覆盖${ic.counts.coverage} 修订${ic.counts.revised} | ${Date.now() - t0}ms`
    );
    if (v.checkErrors.length) console.log("   checkErrors:", v.checkErrors.join(" ; "));
    if (ic.flagged.length) console.log("   flagged[0..3]:", JSON.stringify(ic.flagged.slice(0, 4)));
    if (ic.notes.length) console.log("   notes:", ic.notes.join(" ; "));
  } catch (e) {
    console.log(`${cfg.id}: FAIL ${e.message}`);
  }
}
