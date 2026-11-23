// 手动跑一遍更新管道。管道本体只有一个 owner：backend/lib/pipeline.js（页面「更新」按钮与调度器用的也是它）。
// 默认增量（按各序列水位线只取新数据）；--force 才全量重建。
// 用法：node tools/run-update.mjs [--force] [资产id...]   例：node tools/run-update.mjs gold policy
import { loadIndicators } from "../backend/lib/indicators.js";
import { updateAll } from "../backend/lib/pipeline.js";
import { loadSheets } from "../backend/lib/sheets.js";
import { loadSummaries } from "../backend/lib/summaries.js";
import { db } from "../backend/lib/store.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));
const known = new Set([
  ...loadIndicators().map((c) => c.id),
  ...loadSheets().map((c) => c.id),
  ...loadSummaries().map((c) => c.id),
  "policy",
]);
// 打错一个 id 会静默什么都不做，输出还是一片绿 ⇒ 直接拒绝，不让人误以为更新过了
const unknown = only.filter((id) => !known.has(id));
if (unknown.length) {
  console.error(`未知资产 id：${unknown.join(", ")}（可选：${[...known].join(", ")}）`);
  process.exit(1);
}

const t0 = Date.now();
const latest = await updateAll(force, { only: only.length ? only : undefined });
console.log(`\n${force ? "全量重建" : "增量更新"}${only.length ? `（${only.join(", ")}）` : "（全站）"}完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s${latest ? `，与官方对齐到 ${latest}` : ""}`);
db.close();
