// 迁移器：把既有的 data/*.json 一次性导入 SQLite，并逐值断言「读回 = 原文件」。
// 用法：node tools/migrate-db.mjs
// 这不是「搬完就宣布成功」：导入后必须逐序列比对点数、末值、校验计数，任何一条不一致就退出非零，
// 因为此后 JSON 只是导出快照，读路径已经只认库。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { loadIndicators } = await import(pathToFileURL(path.join(ROOT, "backend/lib/indicators.js")).href);
const db = await import(pathToFileURL(path.join(ROOT, "backend/lib/db.js")).href);
const semantics = await import(pathToFileURL(path.join(ROOT, "backend/lib/semantics.js")).href);

const today = new Date().toISOString().slice(0, 10);
const bad = [];
let pointsIn = 0;

for (const cfg of loadIndicators()) {
  const file = path.join(ROOT, "data", `${cfg.id}.json`);
  if (!fs.existsSync(file)) {
    bad.push(`${cfg.id}: 没有 data/${cfg.id}.json，无法迁移`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const strategy = cfg.incremental || "tail";
  const res = db.commitRun({
    cfg: { ...cfg, incremental: strategy },
    data,
    plan: {
      mode: "migrate",
      start: data.points[0]?.d || today,
      end: data.points[data.points.length - 1]?.d || today,
      strategy,
      overlap: semantics.overlapDays(cfg),
      reason: "一次性导入既往 JSON 快照",
    },
    usage: { calls: 0, bytes: 0 },
    stages: {
      plan: { status: "ok", info: "migrate" },
      fetch: { status: "skipped", info: "数据来自本地既有快照，未出网" },
      validate: { status: "ok", info: `校验 ${data.validation?.matched ?? 0}/${data.validation?.checked ?? 0}` },
      correct: { status: (data.validation?.corrected ?? 0) > 0 ? "ok" : "skipped", info: `改值 ${data.validation?.corrected ?? 0} 点` },
      commit: { status: "ok", info: `${data.points.length} 点` },
    },
    startedAt: data.updatedAt,
    status: "ok",
    error: null,
  });
  pointsIn += data.points.length;

  const back = db.readSeries(cfg.id);
  if (!back) {
    bad.push(`${cfg.id}: 库里读不回来`);
    continue;
  }
  if (back.points.length !== data.points.length) bad.push(`${cfg.id}: 点数 ${back.points.length} ≠ 原 ${data.points.length}`);
  for (let i = 0; i < data.points.length; i++) {
    const a = data.points[i];
    const b = back.points[i];
    if (!b || a.d !== b.d || a.v !== b.v) {
      bad.push(`${cfg.id}: 第 ${i} 行不一致（${a.d}/${a.v} vs ${b?.d}/${b?.v}）`);
      break;
    }
    if (JSON.stringify(a.corrected || null) !== JSON.stringify(b.corrected || null)) {
      bad.push(`${cfg.id}: 第 ${i} 行改值留痕不一致`);
      break;
    }
  }
  if (JSON.stringify(back.validation || {}) !== JSON.stringify(data.validation || {})) bad.push(`${cfg.id}: validation 不一致`);
  console.log(`${cfg.id.padEnd(16)} ${String(res.added).padStart(5)} 点入库 run#${res.runId} 末值 ${back.points.at(-1)?.d}=${back.points.at(-1)?.v}`);
}

for (const f of fs.readdirSync(path.join(ROOT, "data")).filter((x) => /^(sheet|summary)-.+\.json$/.test(x))) {
  const id = f.replace(/\.json$/, "");
  const obj = JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  db.upsertArtifact(id, obj);
  const back = db.readArtifact(id);
  const same = JSON.stringify(back) === JSON.stringify(obj);
  if (!same) bad.push(`${id}: 工件读回不一致`);
  console.log(`${id.padEnd(24)} ${(obj.history || obj.rows || []).length} 行工件入库 ${same ? "一致" : "不一致"}`);
}

db.checkpoint();
console.log(`\n合计入库 ${pointsIn} 点；库内 ${JSON.stringify(db.counts())}`);
console.log(`外键违例 ${db.foreignKeyViolations()} 条`);
if (bad.length) {
  console.log(`不一致 ${bad.length}：\n  ` + bad.slice(0, 8).join("\n  "));
  process.exit(1);
}
console.log("迁移后逐值一致：读路径可以只认 SQLite。");
