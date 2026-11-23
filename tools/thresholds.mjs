// 阈值定标与复算的唯一实现处：门禁 G2 与 CLI 共用这里的判据，不允许各写一套。
// 用法：node tools/thresholds.mjs          ⇒ 报告（不写文件）
//       node tools/thresholds.mjs --write  ⇒ 为 indicators/*.json 补写 source 溯源块（只加溯源，绝不改阈值本身）
// 原则：阈值被实测越带时不自动放宽，列成「须人裁决」；带内偏差没有实测时不猜（不造数）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const wr = (p, o) => fs.writeFileSync(path.join(ROOT, p), JSON.stringify(o, null, 2) + "\n");

const { PUBLICATION_LAG, PUBLICATION_PERIOD } = await import(pathToFileURL(path.join(ROOT, "backend/lib/integrity.js")).href);
const LAG_KEYS = Object.keys(PUBLICATION_LAG);
const r6 = (x) => (x == null ? null : Number(Number(x).toFixed(6)));
const near = (a, b, rel = 0.02) => a != null && b != null && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * rel);
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))] : null);
export const WINDOW_RE = /^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/;
export const STATISTICS = ["min,max", "p0.2,p99.8", "max", "p99.8", "manual-policy"];

export function measure(data) {
  const vals = data.points.map((p) => p.v).filter((v) => v != null);
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const abs = [];
  const rel = [];
  for (let i = 1; i < data.points.length; i++) {
    const a = data.points[i - 1].v;
    const b = data.points[i].v;
    if (a == null || b == null) continue;
    abs.push(Math.abs(b - a));
    if (a !== 0) rel.push(Math.abs((b - a) / a));
  }
  const js = [...abs].sort((a, b) => a - b);
  const rs = [...rel].sort((a, b) => a - b);
  return {
    n: data.points.length,
    window: `${data.points[0].d} ~ ${data.points[data.points.length - 1].d}`,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p02: pct(sorted, 0.002),
    p998: pct(sorted, 0.998),
    maxJump: js.length ? js[js.length - 1] : null,
    p998Jump: pct(js, 0.998),
    p998Rel: pct(rs, 0.998),
    devRange: data.validation?.devRange ?? null,
  };
}

export const measuredFor = (statistic, field, m) =>
  statistic === "min,max" ? [m.min, m.max]
  : statistic === "p0.2,p99.8" ? [m.p02, m.p998]
  : statistic === "max" ? m.maxJump
  : statistic === "p99.8" ? (field === "maxRelJump" ? m.p998Rel : m.p998Jump)
  : null;

// 声称的统计量必须能被今天的实测复算；manual-policy 是唯一允许「有意留宽」的口径，但仍要被包含关系约束
export function auditStat(statistic, declared, measuredValue) {
  if (!STATISTICS.includes(statistic)) return `statistic 非法：${statistic}`;
  if (statistic === "manual-policy") return null;
  if (measuredValue == null) return `无法复算（实测里没有 ${statistic} 对应的量）`;
  if (Array.isArray(declared) && Array.isArray(measuredValue)) {
    if (!near(declared[0], measuredValue[0]) || !near(declared[1], measuredValue[1]))
      return `声明 ${JSON.stringify(declared)} 与今日实测 ${JSON.stringify(measuredValue.map(r6))} 偏差 >2%（数据变了须重新定标）`;
  } else if (!near(declared, measuredValue)) return `声明 ${declared} 与今日实测 ${r6(measuredValue)} 偏差 >2%`;
  return null;
}

export function audit(cfg, data) {
  const errs = [];
  const m = measure(data);
  if (!m) return [`${cfg.id}: 无有效观测点，阈值无从复算`];
  const src = cfg.integrity?.source || {};
  for (const field of ["range", "maxAbsJump", "maxRelJump", "maxLagDays"]) {
    const declared = cfg.integrity?.[field];
    if (declared == null) continue;
    const s = src[field];
    if (!s) {
      errs.push(`${cfg.id}/integrity.${field}: 缺 source（阈值须写明统计量与实测窗口）`);
      continue;
    }
    if (!WINDOW_RE.test(String(s.window || ""))) errs.push(`${cfg.id}/integrity.${field}: window 不可解析：${s.window}`);
    if (!s.note || String(s.note).length < 12) errs.push(`${cfg.id}/integrity.${field}: note 未说明定标依据`);
    if (s.statistic !== "manual-policy" && !s.measured) errs.push(`${cfg.id}/integrity.${field}: 未记录定标实测值 measured`);
    const e = auditStat(s.statistic, declared, measuredFor(s.statistic, field, m));
    if (e) errs.push(`${cfg.id}/integrity.${field}: ${e}`);
    if (field === "maxLagDays") {
      const need = PUBLICATION_LAG[cfg.publication];
      if (need == null) errs.push(`${cfg.id}/integrity.maxLagDays: publication 未声明或不在官方节奏表（${LAG_KEYS.join(",")}）里，无法推导下限`);
      else {
        if (declared < need) errs.push(`${cfg.id}/integrity.maxLagDays: 声明 ${declared} 小于官方节奏推导下限 ${need} 天`);
        if (declared > need + (PUBLICATION_PERIOD[cfg.publication] ?? 0))
          errs.push(`${cfg.id}/integrity.maxLagDays: 声明 ${declared} 超过「官方节奏 ${need} 天 + 一个发布周期 ${PUBLICATION_PERIOD[cfg.publication]} 天」的宽余上限`);
        const last = dataLast(cfg);
        const observed = last ? Math.round((Date.now() - Date.parse(last + "T00:00:00Z")) / 86400000) : null;
        if (observed != null && declared < observed) errs.push(`${cfg.id}/integrity.maxLagDays: 实测已滞后 ${observed} 天（最新 ${last}），声明 ${declared} 已被越出，须人裁决`);
        if (s.measured?.publication !== cfg.publication) errs.push(`${cfg.id}/integrity.maxLagDays: source.measured.publication 应与指标声明的发布节奏一致`);
      }
    }
    if (s.statistic === "manual-policy") {
      if (Array.isArray(declared)) {
        if (declared[0] > m.min + 1e-9 || declared[1] < m.max - 1e-9)
          errs.push(`${cfg.id}/integrity.${field}: 政策带 [${declared}] 已被实测越出 [${r6(m.min)}, ${r6(m.max)}]`);
      } else if (field === "maxAbsJump" || field === "maxRelJump") {
        const ref = field === "maxRelJump" ? m.p998Rel : m.p998Jump;
        if (ref == null) errs.push(`${cfg.id}/integrity.${field}: 序列不足，无法实测跳变分布`);
        else if (declared < ref - 1e-9)
          errs.push(`${cfg.id}/integrity.${field}: 声明 ${declared} 低于实测 99.8 分位 ${r6(ref)}：会把正常波动全判成存疑`);
      }
    }
  }
  for (const leg of cfg.legs || []) {
    if (!leg.check?.band) continue;
    const s = leg.check.source;
    if (!s) {
      errs.push(`${cfg.id}/${leg.key}.check.band: 缺 source（校验带须写明它覆盖的实测偏差）`);
      continue;
    }
    if (!WINDOW_RE.test(String(s.window || ""))) errs.push(`${cfg.id}/${leg.key}.check.band: window 不可解析：${s.window}`);
    if (!m.devRange) {
      errs.push(`${cfg.id}/${leg.key}.check.band: 本期数据没有 validation.devRange，无法复算带内偏差（须跑一轮更新）`);
      continue;
    }
    const [dlo, dhi] = m.devRange;
    const [lo, hi] = leg.check.band;
    if (lo > dlo + 1e-9 || hi < dhi - 1e-9) errs.push(`${cfg.id}/${leg.key}.check.band: 实测偏差 [${r6(dlo)}, ${r6(dhi)}] 越出带 [${lo}, ${hi}]`);
    const observed = Math.abs(dhi - dlo) || Math.abs(dhi) || Math.abs(dlo);
    if (observed && hi - lo > observed * 12) errs.push(`${cfg.id}/${leg.key}.check.band: 带宽 ${hi - lo} 大于 12× 实测跨度 ${r6(observed)}（太松等于没校验）`);
  }
  return errs;
}

function rangeSource(declared, m) {
  const [lo, hi] = declared;
  if (lo > m.min + 1e-9 || hi < m.max - 1e-9)
    return { error: `实测 [${r6(m.min)}, ${r6(m.max)}] 越出声明带 [${lo}, ${hi}]：须人裁决，工具不自动放宽` };
  const isEnds = near(lo, m.min) && near(hi, m.max);
  const isPct = near(lo, m.p02) && near(hi, m.p998);
  const stat = isEnds ? "min,max" : isPct ? "p0.2,p99.8" : "manual-policy";
  const measured = { min: r6(m.min), max: r6(m.max), p02: r6(m.p02), p998: r6(m.p998), n: m.n };
  if (stat === "manual-policy")
    return { statistic: stat, window: m.window, measured, note: `声明带 [${lo}, ${hi}] 由实测 [${r6(m.min)}, ${r6(m.max)}] 向外取整而得；外扩是有意冗余，越带即报警（门禁复算包含关系）` };
  return { statistic: stat, window: m.window, measured, note: `声明带等于同窗口实测${stat === "min,max" ? "端点" : "0.2/99.8 分位"}，门禁逐轮复算，漂移超 2% 报警` };
}

// 跳变带：等于实测最大值 ⇒ max；等于 99.8 分位 ⇒ p99.8；比 99.8 分位更宽 ⇒ 有意留宽的政策带（manual-policy）
function jumpSource(declared, m, field) {
  const ref = field === "maxRelJump" ? m.p998Rel : m.p998Jump;
  const top = field === "maxRelJump" ? null : m.maxJump;
  if (ref == null) return { error: "序列不足两点，无法实测跳变" };
  if (declared < ref - 1e-9) return { error: `声明 ${field} ${declared} 小于实测 99.8 分位 ${r6(ref)}：会把正常波动全判成存疑，须人裁决` };
  const stat = near(declared, top) ? "max" : near(declared, ref) ? "p99.8" : "manual-policy";
  const measured = field === "maxRelJump" ? { p998Rel: r6(ref), n: m.n } : { maxJump: r6(m.maxJump), p998Jump: r6(ref), n: m.n };
  const note =
    stat === "max"
      ? "等于同窗口实测最大单期跳变"
      : stat === "p99.8"
      ? `取实测单期跳变的 99.8 分位（${r6(ref)}）；更大跳变 ${r6(top)} 属真实事件，允许报警但不判错`
      : `声明 ${declared} 高于实测 99.8 分位 ${r6(ref)}：有意留宽的保守带，低于该分位即判太紧`;
  return { statistic: stat, window: m.window, measured, note };
}

function bandSource(declared, m, legKey) {
  const [lo, hi] = declared;
  if (!m.devRange) return { pending: `${legKey}: 旧数据没有 validation.devRange，跑一轮更新后由本工具补写 check.source` };
  const [dlo, dhi] = m.devRange;
  if (lo > dlo + 1e-9 || hi < dhi - 1e-9) return { error: `${legKey} 实测偏差 [${r6(dlo)}, ${r6(dhi)}] 越出校验带 [${lo}, ${hi}]：带太紧会误杀` };
  const observed = Math.abs(dhi - dlo) || Math.abs(dhi) || Math.abs(dlo);
  if (observed && hi - lo > observed * 12) return { error: `${legKey} 校验带宽 ${hi - lo} 大于实测跨度 ${r6(observed)} 的 12 倍：太松等于没校验` };
  return {
    statistic: "manual-policy",
    window: m.window,
    measured: { devLo: r6(dlo), devHi: r6(dhi), checked: m.n },
    note: `带 [${lo}, ${hi}] 覆盖同窗口实测偏差 [${r6(dlo)}, ${r6(dhi)}]；门禁每轮复算包含关系与松紧上限（12 倍）`,
  };
}

function dataLast(cfg) {
  try {
    const d = rd(`data/${cfg.id}.json`);
    return d.points[d.points.length - 1]?.d ?? null;
  } catch {
    return null;
  }
}

export function calibrate() {
  let written = 0;
  const errors = [];
  const pending = [];
  for (const f of fs.readdirSync(path.join(ROOT, "indicators")).filter((x) => x.endsWith(".json"))) {
    const cfg = rd(`indicators/${f}`);
    if (!fs.existsSync(path.join(ROOT, `data/${cfg.id}.json`))) {
      pending.push(`${cfg.id}: 数据未入库`);
      continue;
    }
    const m = measure(rd(`data/${cfg.id}.json`));
    if (!m) {
      pending.push(`${cfg.id}: 无有效观测点`);
      continue;
    }
    const rep = [];
    if (cfg.integrity?.range) {
      const r = rangeSource(cfg.integrity.range, m);
      if (r.error) errors.push(`${cfg.id}/range ${r.error}`);
      else {
        rep.push(`range⇒${r.statistic}`);
        if (WRITE) cfg.integrity.source = { ...(cfg.integrity.source || {}), range: r };
      }
    }
    for (const field of ["maxAbsJump", "maxRelJump"]) {
      if (cfg.integrity?.[field] == null) continue;
      const r = jumpSource(cfg.integrity[field], m, field);
      if (r.error) errors.push(`${cfg.id}/${field} ${r.error}`);
      else {
        rep.push(`${field}⇒${r.statistic}`);
        if (WRITE) cfg.integrity.source = { ...(cfg.integrity.source || {}), [field]: r };
      }
    }
    if (cfg.integrity?.maxLagDays != null) {
      const need = PUBLICATION_LAG[cfg.publication];
      const r = { statistic: "manual-policy", window: m.window, measured: { publication: cfg.publication ?? null, lagFloorDays: need ?? null, lastDate: dataLast(cfg) }, note: need == null ? "发布节奏未声明，无法推导" : `官方节奏 ${cfg.publication} ⇒ 下限 ${need} 天，宽余上限 ${need + (PUBLICATION_PERIOD[cfg.publication] ?? 0)} 天（一个发布周期）；声明 ${cfg.integrity.maxLagDays} 天落在其间，门禁同时复算实测滞后（最新 ${dataLast(cfg)}）` };
      if (r.measured.lagFloorDays == null) errors.push(`${cfg.id}/maxLagDays 无法推导（publication 未声明）`);
      else {
        rep.push("maxLagDays⇒manual-policy");
        if (WRITE) cfg.integrity.source = { ...(cfg.integrity.source || {}), maxLagDays: r };
      }
    }
    for (const leg of cfg.legs || []) {
      if (!leg.check?.band) continue;
      const r = bandSource(leg.check.band, m, leg.key);
      if (r.error) errors.push(r.error);
      else if (r.pending) pending.push(r.pending);
      else {
        rep.push(`${leg.key} 带可复算`);
        if (WRITE) leg.check.source = r;
      }
    }
    if (rep.length) console.log(`${cfg.id.padEnd(16)} ${m.window} n=${String(m.n).padEnd(5)} 偏差${m.devRange ? ` [${m.devRange}]` : " 未实测"} ⇒ ${rep.join(" / ")}`);
    if (WRITE && rep.length) {
      wr(`indicators/${f}`, cfg);
      written += rep.length;
    }
  }
  console.log(`\n${WRITE ? `已写入 source 块 ${written} 个` : "（试算，未写文件）"}`);
  if (pending.length) console.log(`待实测 ${pending.length}：\n  ` + pending.join("\n  "));
  if (errors.length) console.log(`须人裁决 ${errors.length}：\n  ` + errors.join("\n  "));
  return { written, errors, pending };
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/thresholds.mjs")) {
  process.exit(calibrate().errors.length ? 1 : 0);
}
