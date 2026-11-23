// 存储端口（唯一取数/写数入口之外的唯一持久层）。零依赖：Node 自带 node:sqlite（本机实测 SQLite 3.51.3）。
// 规范落点：docs/后端与数据库架构规范.html §4（DDL 与 D-1…D-5 运维纪律）。要点：
//  · D-1 PRAGMA 三项固定，且启动时读回 journal_mode 必须等于 wal —— 设置失败是静默的，所以必须断言；
//  · D-2 事务边界 = 单指标单事务（点值 upsert + 修订追加 + 纠错留痕 + 运行记录 + 水位线，一起成败）；
//  · D-4 迁移只向前，schema_version 不匹配直接拒绝启动；
//  · D-5 能用 CHECK/NOT NULL/FOREIGN KEY 表达的约束一律写进 DDL，让脏数据写不进去。
// JSON 文件按规范降级为「导出快照」：读路径只认 SQLite，写路径在事务提交后再落快照。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./paths.js";

const DB_FILE = path.join(DATA_DIR, "monitor.db");
export const SCHEMA_VERSION = 1;
export const STAGES = ["plan", "fetch", "validate", "correct", "commit"];
export const RUN_STATUSES = ["ok", "degraded", "failed"];
export const STAGE_STATUSES = ["ok", "skipped", "degraded", "failed"];
// 增量策略：由 provider 声明，禁止用「一律全量」这种省事口径（表 2 的实测矩阵是唯一出处）
export const STRATEGIES = ["tail", "windowed", "rolling-guard", "whole-file", "monthly-step", "snapshot-only"];

const DDL = `
CREATE TABLE IF NOT EXISTS series_point (
  indicator_id TEXT NOT NULL,
  d TEXT NOT NULL,
  v REAL,
  ok INTEGER CHECK (ok IN (0,1) OR ok IS NULL),
  suspect TEXT,
  PRIMARY KEY (indicator_id, d)
);
CREATE INDEX IF NOT EXISTS point_by_date ON series_point(d, indicator_id);

CREATE TABLE IF NOT EXISTS revision (
  indicator_id TEXT NOT NULL,
  d TEXT NOT NULL,
  old_v REAL,
  new_v REAL,
  run_id INTEGER NOT NULL REFERENCES fetch_run(id),
  detected_at TEXT NOT NULL,
  PRIMARY KEY (indicator_id, d, run_id)
);

CREATE TABLE IF NOT EXISTS correction (
  indicator_id TEXT NOT NULL,
  d TEXT NOT NULL,
  from_v REAL NOT NULL,
  to_v REAL NOT NULL,
  by TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES fetch_run(id),
  PRIMARY KEY (indicator_id, d, run_id)
);

CREATE TABLE IF NOT EXISTS fetch_run (
  id INTEGER PRIMARY KEY,
  indicator_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  http_calls INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  revised INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok','degraded','failed')),
  error TEXT
);

CREATE TABLE IF NOT EXISTS run_stage (
  run_id INTEGER NOT NULL REFERENCES fetch_run(id),
  stage TEXT NOT NULL CHECK (stage IN ('plan','fetch','validate','correct','commit')),
  status TEXT NOT NULL CHECK (status IN ('ok','skipped','degraded','failed')),
  info TEXT,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS run_stat (
  run_id INTEGER NOT NULL REFERENCES fetch_run(id),
  indicator_id TEXT NOT NULL,
  checked INTEGER NOT NULL,
  matched INTEGER NOT NULL,
  mismatched INTEGER NOT NULL,
  corrected INTEGER NOT NULL,
  unchecked INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  PRIMARY KEY (run_id, indicator_id)
);

CREATE TABLE IF NOT EXISTS watermark (
  indicator_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL CHECK (strategy IN ('tail','windowed','rolling-guard','whole-file','monthly-step','snapshot-only')),
  last_observed TEXT,
  last_fetched_to TEXT NOT NULL,
  overlap_days INTEGER NOT NULL CHECK (overlap_days >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series_head (
  indicator_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  points INTEGER NOT NULL,
  validation_json TEXT NOT NULL,
  integrity_json TEXT NOT NULL
);

-- 政策事件（加息/降息/按由不动/缩表/扩表）：一行一次官方动作，URL 即证据，NOT NULL 使无据事件写不进来
CREATE TABLE IF NOT EXISTS policy_event (
  event_date TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'us',
  action TEXT NOT NULL CHECK (action IN ('hike','cut','hold','qt','qt-slow','qt-end','qe','other')),
  delta_bp REAL,
  delta_source TEXT NOT NULL DEFAULT '',
  range_lo REAL,
  range_hi REAL,
  monthly_cap_billion REAL,
  bs_action TEXT,
  title TEXT NOT NULL,
  quote TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (event_date, region, action)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 报表与周度汇总的装配结果不是点值序列（H.4.1 是「一期一张表」），
-- 规范 §4 的 DDL 只覆盖了时序部分；这里补一张工件表，使读路径仍然只有 SQLite 一个来源。
-- 原子的逐期数值仍进 series_point / sheet_point，本表只存装配快照，可随时由官方一期文件重算。
CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sheet','summary')),
  updated_at TEXT NOT NULL,
  rows INTEGER NOT NULL CHECK (rows >= 0),
  json TEXT NOT NULL
);
`;

let db = null;

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const handle = new DatabaseSync(DB_FILE);
  // D-1：WAL 是库头属性，只需建库时设一次；读回断言不等则拒绝启动
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA synchronous = NORMAL;");
  handle.exec("PRAGMA busy_timeout = 5000;");
  handle.exec("PRAGMA foreign_keys = ON;");
  const mode = handle.prepare("PRAGMA journal_mode").get().journal_mode;
  if (String(mode).toLowerCase() !== "wal") throw new Error(`D-1 违例：journal_mode 实际为 ${mode}，必须是 wal（SQLite 设置失败是静默的，故此处断言而非容忍）`);
  handle.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    handle.exec("BEGIN");
    try {
      handle.exec(DDL);
      handle.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
      handle.exec("COMMIT");
    } catch (e) {
      handle.exec("ROLLBACK");
      throw e;
    }
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`D-4 违例：库内 schema_version=${row.value}，代码要求 ${SCHEMA_VERSION}；迁移只向前，请补迁移脚本而不是放宽断言`);
  }
  return handle;
}

function handle() {
  if (!db) db = open();
  return db;
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// D-3：更新链结束时收敛 WAL，避免 -wal 无限增长
export function checkpoint() {
  return handle().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
}

// D-3：备份只走 VACUUM INTO，禁止直接拷 monitor.db（会丢最近的 WAL 提交）
export function backupTo(target) {
  const abs = path.resolve(target);
  handle().exec(`VACUUM INTO '${abs.replace(/'/g, "''")}'`);
  return abs;
}

export function pragmaJournalMode() {
  return String(handle().prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
}

export function metaValue(key) {
  const r = handle().prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return r ? r.value : null;
}

export function correctionsOf(id) {
  return handle().prepare("SELECT d, from_v, to_v, by FROM correction WHERE indicator_id = ?").all(id);
}

export function foreignKeyViolations() {
  return handle().prepare("PRAGMA foreign_key_check").all().length;
}

export function counts() {
  const h = handle();
  const one = (sql) => h.prepare(sql).get().n;
  return {
    points: one("SELECT COUNT(*) n FROM series_point"),
    revisions: one("SELECT COUNT(*) n FROM revision"),
    corrections: one("SELECT COUNT(*) n FROM correction"),
    runs: one("SELECT COUNT(*) n FROM fetch_run"),
    stages: one("SELECT COUNT(*) n FROM run_stage"),
    stats: one("SELECT COUNT(*) n FROM run_stat"),
    watermarks: one("SELECT COUNT(*) n FROM watermark"),
    heads: one("SELECT COUNT(*) n FROM series_head"),
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const minusDays = (dateStr, days) => iso(new Date(Date.parse(`${dateStr}T00:00:00Z`) - days * 86400000));

// 水位线读取：区间的决定在 semantics，这里只提供游标本体的读与写
export function getWatermark(id) {
  return handle().prepare("SELECT * FROM watermark WHERE indicator_id = ?").get(id) || null;
}

// 修订捕获窗（overlap）与取数区间的决定处只有一个：backend/lib/semantics.js（它读这里的水位线）。
// 本文件只负责落库与提交，不再自己算 overlap，防止「运行期窗口」与「门禁复算窗口」分家。

// D-2：单指标单事务。points 已经过校验与纠错，这里只负责忠实落库 + 追加修订与纠错留痕。
export function commitRun({ cfg, data, plan, usage, stages, startedAt, status, error }) {
  const h = handle();
  h.exec("BEGIN IMMEDIATE");
  let added = 0;
  let revised = 0;
  try {
    const run = h
      .prepare(
        "INSERT INTO fetch_run(indicator_id, mode, range_start, range_end, started_at, finished_at, http_calls, bytes, added, revised, status, error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(cfg.id, plan.mode, plan.start, plan.end, startedAt, new Date().toISOString(), usage.calls, usage.bytes, 0, 0, status, error || null);
    const runId = Number(run.lastInsertRowid);

    const insStage = h.prepare("INSERT INTO run_stage(run_id, stage, status, info) VALUES(?,?,?,?)");
    for (const st of STAGES) {
      const rec = stages[st] || { status: "skipped", info: "本轮未涉及" };
      insStage.run(runId, st, rec.status, rec.info || "");
    }

    const upsert = h.prepare(
      "INSERT INTO series_point(indicator_id, d, v, ok, suspect) VALUES(?,?,?,?,?) ON CONFLICT(indicator_id, d) DO UPDATE SET v=excluded.v, ok=excluded.ok, suspect=excluded.suspect"
    );
    const selectPoint = h.prepare("SELECT v, ok, suspect FROM series_point WHERE indicator_id = ? AND d = ?");
    const insRev = h.prepare("INSERT INTO revision(indicator_id, d, old_v, new_v, run_id, detected_at) VALUES(?,?,?,?,?,?)");
    const insCor = h.prepare("INSERT INTO correction(indicator_id, d, from_v, to_v, by, run_id) VALUES(?,?,?,?,?,?)");
    let lastObserved = null;
    for (const p of data.points) {
      if (p.d > (lastObserved || "")) lastObserved = p.d;
      const prev = selectPoint.get(cfg.id, p.d);
      const before = upsert.run(
        cfg.id,
        p.d,
        p.v ?? null,
        p.ok === true ? 1 : p.ok === false ? 0 : null,
        p.suspect == null ? null : typeof p.suspect === "string" ? p.suspect : JSON.stringify(p.suspect)
      );
      if (!before.changes || prev == null) {
        added++;
      } else if (prev.v !== (p.v ?? null)) {
        revised++;
        insRev.run(cfg.id, p.d, prev.v ?? null, p.v ?? null, runId, data.updatedAt);
      }
      if (p.corrected && p.corrected.from != null && p.corrected.to != null) {
        insCor.run(cfg.id, p.d, p.corrected.from, p.corrected.to, String(p.corrected.by || ""), runId);
      }
    }

    // 序列头 = 累计事实（点值数以库为准）+ 本轮窗口信息：
    // 增量轮次只取回窗口，若把窗口的 validation 直接当成全量事实，门禁与页面都会误读为「本期没校验」或「历史只有 12 天」。
    const prevHead = h.prepare("SELECT validation_json FROM series_head WHERE indicator_id = ?").get(cfg.id);
    const pv = prevHead ? JSON.parse(prevHead.validation_json) : {};
    const lifetime = h
      .prepare("SELECT COUNT(*) n, SUM(CASE WHEN ok IS NOT NULL THEN 1 ELSE 0 END) checked, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) matched, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) mismatched FROM series_point WHERE indicator_id = ?")
      .get(cfg.id);
    const devLo = [pv.devRange?.[0], data.validation?.devRange?.[0]].filter((v) => v != null);
    const devHi = [pv.devRange?.[1], data.validation?.devRange?.[1]].filter((v) => v != null);
    const validation = {
      ...data.validation,
      window: [plan.start, plan.end],
      devRange: devLo.length ? [Math.min(...devLo), Math.max(...devHi)] : null,
      lifetime: {
        points: lifetime.n,
        checked: lifetime.checked || 0,
        matched: lifetime.matched || 0,
        mismatched: lifetime.mismatched || 0,
      },
    };
    h.prepare(
      "INSERT OR REPLACE INTO series_head(indicator_id, updated_at, points, validation_json, integrity_json) VALUES(?,?,?,?,?)"
    ).run(cfg.id, data.updatedAt, lifetime.n, JSON.stringify(validation), JSON.stringify(data.integrity || {}));

    h.prepare(
      "INSERT INTO run_stat(run_id, indicator_id, checked, matched, mismatched, corrected, unchecked, verdict, flags_json) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run(
      runId,
      cfg.id,
      data.validation?.checked ?? 0,
      data.validation?.matched ?? 0,
      data.validation?.mismatched ?? 0,
      data.validation?.corrected ?? 0,
      data.validation?.uncheckedDates ?? 0,
      data.integrity?.verdict ?? "unknown",
      JSON.stringify(data.integrity?.counts ?? {})
    );

    // 水位线只前进不回退：官方本期缺最晚一天时（节假日/延迟），保留已知的最大观测日
    const prevWm = getWatermark(cfg.id);
    const merged = prevWm && prevWm.last_observed > (lastObserved || "") ? prevWm.last_observed : lastObserved;
    h.prepare(
      "INSERT OR REPLACE INTO watermark(indicator_id, strategy, last_observed, last_fetched_to, overlap_days, updated_at) VALUES(?,?,?,?,?,?)"
    ).run(cfg.id, plan.strategy, merged, plan.end, plan.overlap, new Date().toISOString());

    h.prepare("UPDATE fetch_run SET added = ?, revised = ? WHERE id = ?").run(added, revised, runId);
    h.exec("COMMIT");
    return { runId, added, revised };
  } catch (e) {
    h.exec("ROLLBACK");
    throw e;
  }
}

// 读路径：从 SQLite 组装出与既往 JSON 完全同形的对象（面板/汇总只用这个形状）
export function readSeries(id) {
  const h = handle();
  const head = h.prepare("SELECT * FROM series_head WHERE indicator_id = ?").get(id);
  if (!head) return null;
  const rows = h.prepare("SELECT d, v, ok, suspect FROM series_point WHERE indicator_id = ? ORDER BY d").all(id);
  const corrections = new Map(
    h
      .prepare("SELECT d, from_v, to_v, by FROM correction WHERE indicator_id = ? ORDER BY run_id")
      .all(id)
      .map((c) => [c.d, c])
  );
  const points = rows.map((r) => {
    const p = { d: r.d, v: r.v };
    if (r.ok === 1) p.ok = true;
    else if (r.ok === 0) p.ok = false;
    else p.ok = null;
    if (r.suspect) p.suspect = /^[[{]/.test(r.suspect) ? JSON.parse(r.suspect) : r.suspect;
    const c = corrections.get(r.d);
    if (c) p.corrected = { from: c.from_v, to: c.to_v, by: c.by };
    return p;
  });
  return {
    updatedAt: head.updated_at,
    points,
    validation: JSON.parse(head.validation_json),
    pointsTotal: head.points,
    integrity: JSON.parse(head.integrity_json),
  };
}

// 报表/汇总工件：整份装配结果进出 SQLite，读路径与序列一致（只认库，不认文件）
export function upsertArtifact(id, obj) {
  const kind = id.startsWith("sheet-") ? "sheet" : id.startsWith("summary-") ? "summary" : null;
  if (!kind) throw new Error(`artifact ${id} 不属于已登记的种类（sheet-/summary- 前缀）`);
  const rows = (obj.history || obj.rows || []).length;
  handle()
    .prepare("INSERT OR REPLACE INTO artifact(id, kind, updated_at, rows, json) VALUES(?,?,?,?,?)")
    .run(id, kind, obj.updatedAt || new Date().toISOString(), rows, JSON.stringify(obj));
  return rows;
}

export function readArtifact(id) {
  const r = handle().prepare("SELECT json FROM artifact WHERE id = ?").get(id);
  return r ? JSON.parse(r.json) : null;
}

export function artifactIds() {
  return handle().prepare("SELECT id, kind, rows, updated_at FROM artifact ORDER BY id").all();
}

// 政策事件读写：一行一次官方动作；重复运行按 (日期,市场,动作) 覆盖同一行，保证幂等
export function upsertPolicyEvent(ev, region) {
  handle()
    .prepare(
      "INSERT OR REPLACE INTO policy_event(event_date, region, action, delta_bp, delta_source, range_lo, range_hi, monthly_cap_billion, bs_action, title, quote, url, source, recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      ev.date,
      region || "us",
      ev.action,
      ev.deltaBp ?? null,
      ev.deltaSource || "",
      ev.rangeLo ?? null,
      ev.rangeHi ?? null,
      ev.monthlyCapBillion ?? null,
      ev.bsAction || null,
      String(ev.title || "").slice(0, 160),
      String(ev.quote || "").slice(0, 300),
      ev.url,
      ev.source,
      new Date().toISOString()
    );
}

// 政策事件行的唯一映射处：按区域取与全站取都走它，避免两处各写一遍字段名
const mapEvent = (r) => ({
  region: r.region,
  date: r.event_date,
  action: r.action,
  deltaBp: r.delta_bp,
  deltaSource: r.delta_source,
  range: r.range_lo == null ? null : [r.range_lo, r.range_hi],
  monthlyCapBillion: r.monthly_cap_billion,
  bsAction: r.bs_action,
  title: r.title,
  quote: r.quote,
  url: r.url,
  source: r.source,
});

export function policyEvents(region) {
  return handle()
    .prepare("SELECT * FROM policy_event WHERE region = ? ORDER BY event_date")
    .all(region || "us")
    .map(mapEvent);
}

export function policyEventsAll() {
  return handle().prepare("SELECT * FROM policy_event ORDER BY event_date").all().map(mapEvent);
}

export function policyEventCount(region) {
  return handle().prepare("SELECT COUNT(*) n FROM policy_event WHERE region = ?").get(region || "us").n;
}

// 非序列类的一轮运行（政策事件等）也要留五态与用量：同一张 fetch_run，避免「只有序列才有运行史」
export function commitRunRecord({ cfg, plan, usage, startedAt, status, error, added, stages }) {
  const h = handle();
  h.exec("BEGIN IMMEDIATE");
  try {
    const run = h
      .prepare(
        "INSERT INTO fetch_run(indicator_id, mode, range_start, range_end, started_at, finished_at, http_calls, bytes, added, revised, status, error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(cfg.id, plan.mode, plan.start, plan.end, startedAt, new Date().toISOString(), usage.calls, usage.bytes, added || 0, 0, status, error || null);
    const insStage = h.prepare("INSERT INTO run_stage(run_id, stage, status, info) VALUES(?,?,?,?)");
    for (const st of STAGES) {
      const rec = stages[st] || { status: "skipped", info: "本轮未涉及" };
      insStage.run(Number(run.lastInsertRowid), st, rec.status, rec.info || "");
    }
    h.exec("COMMIT");
    return { runId: Number(run.lastInsertRowid) };
  } catch (e) {
    h.exec("ROLLBACK");
    throw e;
  }
}

export function lastRun(id) {
  const h = handle();
  const run = h.prepare("SELECT * FROM fetch_run WHERE indicator_id = ? ORDER BY id DESC LIMIT 1").get(id);
  if (!run) return null;
  return { ...run, stages: h.prepare("SELECT stage, status, info FROM run_stage WHERE run_id = ? ORDER BY stage").all(run.id) };
}

// 导出快照：JSON 仍是 git 里的可审阅产物，但它是「导出」，不是读取来源
export function snapshotFile(id, file) {
  const data = readSeries(id);
  if (!data) return null;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  return file;
}
