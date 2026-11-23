// 存储端口（唯一持久层入口）。规范 B-1：读路径只认 SQLite，不从旧 JSON 兜底 ——
// 「库里没有但文件里有」必须暴露成未入库，而不是靠快照文件悄悄续命。
// JSON 文件仍然是产物：commit 之后导出，供 git 审阅与离线分享，但没有任何读取走它。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import * as db from "./db.js";

export function read(id) {
  return db.readSeries(id) || db.readArtifact(id);
}

// 报表树 / 周度汇总这类整份装配结果（不是点值序列）
export function write(id, obj) {
  if (obj?.points) {
    // 序列必须带 indicators 层算好的运行元数据（计划/用量/五态）；没带就是绕过取数链的写入 ⇒ 直接失败
    if (!obj.runMeta) throw new Error(`store.write 收到没有 runMeta 的序列 ${id}：不允许绕过水位线与事务`);
    return commitSeries(id, obj);
  }
  db.upsertArtifact(id, obj);
  return exportJson(id, db.readArtifact(id));
}

// 序列的一轮更新：单指标单事务落库（点值 upsert + 修订追加 + 纠错留痕 + 运行五态 + 水位线），提交后再导出快照
export function commitSeries(id, obj) {
  const res = db.commitRun({ ...obj.runMeta, data: obj });
  // 导出的是库里的完整序列（含本轮之前的历史），不是本轮窗口的局部结果
  exportJson(id, db.readSeries(id));
  return res;
}

function exportJson(id, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
  return file;
}

export { db };
