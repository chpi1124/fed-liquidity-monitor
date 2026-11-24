import fs from "node:fs";
import path from "node:path";
import { INDICATORS_DIR } from "./paths.js";
import { getSeries } from "./cache.js";
import { read as readStore } from "./store.js";
import { checkIntegrity, thresholdsFor, plausible } from "./integrity.js";
import { drainUsage } from "../providers/_shared.js";
import { fetchWindow } from "./semantics.js";

// 浮点噪声的唯一清理口径：官方给的是 6 位小数级别的利率，比较与写回都先量化到这里
const q6 = (x) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(6)));

export function loadIndicators(region) {
  if (!fs.existsSync(INDICATORS_DIR)) return [];
  let list = fs
    .readdirSync(INDICATORS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(INDICATORS_DIR, f), "utf8")));
  if (region) list = list.filter((c) => (c.region || "us") === region);
  return list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

export function zoneOf(zones, v) {
  if (!zones || v == null) return null;
  for (const z of zones) {
    if (z.max == null) return z;
    if (z.includeMax === false ? v < z.max : v <= z.max) return z;
  }
  return zones[zones.length - 1];
}

export async function updateIndicator(cfg, { force = false, prev = null } = {}) {
  // 本轮用量水位：取数前后各读一次，差值就是这次真正花了多少请求与字节（写进 fetch_run）
  drainUsage();
  const startedAt = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const earliest = cfg.start || "2015-01-01";
  const primaryProvider = (cfg.legs || [])[0]?.primary?.provider || "";
  const plan = force
    // 强制重取只是把窗口拉回全历史，修订窗（overlap）仍必须按发布节奏登记：否则水位线会被写成 0 天，
    // 之后的增量轮次就再也看不到官方修订（G8 判这条为红）
    ? { ...fetchWindow(cfg, primaryProvider, today, earliest), mode: "full", start: earliest, reason: "强制全量重取（修订窗照常登记）" }
    : fetchWindow(cfg, primaryProvider, today, earliest);
  const start = plan.start;
  const end = plan.end;
  const tol = cfg.tolerance ?? 0.011;
  let checked = 0, matched = 0, mismatched = 0;
  // 带内偏差的实际包络：校验带的阈值是否定得合理，只能拿它对账（G2 复算的就是这一项）
  let devLo = null, devHi = null;
  const noteDev = (x) => {
    if (x == null || Number.isNaN(x)) return;
    devLo = devLo === null ? x : Math.min(devLo, x);
    devHi = devHi === null ? x : Math.max(devHi, x);
  };
  const checkErrors = [];
  // 校验腿既可以是「另一个官方出版方」(直接取数)，也可以是「另一条官方序列」(provider:"series"，
  // 读取已入库并各自校验过的指标)，后者用于比值/差值带宽型交叉验证。
  // minus:"<id>" 把参照序列变成「A−B」恒等式：用于校验派生指标是否等于其分量之差。
  const legSeries = async (src) => {
    if (src.provider !== "series") return getSeries(src, start, end, force);
    const load = (id) => {
      const d = readStore(id);
      if (!d?.points?.length) throw new Error(`参照序列 ${id} 尚未入库`);
      return new Map(d.points.map((p) => [p.d, p.v]));
    };
    const a = load(src.id);
    if (!src.minus) return a;
    const b = load(src.minus);
    const out = new Map();
    for (const [d, x] of a) {
      const y = b.get(d);
      if (x != null && y != null) out.set(d, q6(x - y));
    }
    if (!out.size) throw new Error(`恒等式参照 ${src.id}−${src.minus} 无重叠日期`);
    return out;
  };
  const legs = await Promise.all(
    cfg.legs.map(async (leg) => {
      const [primary, check] = await Promise.all([
        legSeries(leg.primary),
        // 校验腿失败不得阻塞主源入库：降级为「本期无并行确认」并留痕，绝不用主源数值冒充双源确认。
        leg.check
          ? legSeries(leg.check).catch((e) => {
              checkErrors.push(`${leg.check.id || leg.check.provider || leg.check.series}: ${e.message}`);
              return null;
            })
          : Promise.resolve(null),
      ]);
      const offset = leg.check?.offset ?? 0;
      const mode = leg.check?.mode || "abs";
      const band = leg.check?.band || null;
      const cScale = leg.check?.scale ?? 1;
      // align:"month-mean"：日频与月频比对时，两侧各自先按月取均值再对齐（日频交易所价 vs
      // 月频官方均价；反向同理，月频主序列 vs 日频参照）。
      const monthify = (src) => {
        const g = new Map();
        for (const [d, v] of src) {
          if (typeof v !== "number") continue;
          const k = d.slice(0, 7);
          const o = g.get(k) || [];
          o.push(v);
          g.set(k, o);
        }
        return new Map([...g].map(([k, a]) => [k, a.reduce((x, y) => x + y, 0) / a.length]));
      };
      const alignMonth = leg.check?.align === "month-mean";
      const monthMean = alignMonth ? monthify(primary) : null;
      const checkMonthMean = alignMonth && check ? monthify(check) : null;
      const stat = (pv, cv) =>
        mode === "ratio" ? (cv === 0 ? null : pv / cv) : mode === "diff" ? pv - cv : Math.abs(pv - (cv * cScale + offset));
      const pass = (s) => (band ? s >= band[0] && s <= band[1] : s <= tol);
      const structured = [...primary.values()].some((e) => e && typeof e === "object");
      let bucketOk = null;
      if (structured) {
        const buckets = new Map();
        for (const e of primary.values()) {
          for (const [sd, amt] of e.settle ?? []) buckets.set(sd, (buckets.get(sd) || 0) + amt);
        }
        bucketOk = new Map();
        const keys = new Set([
          ...buckets.keys(),
          ...(check ? [...check.keys()].filter((k) => k >= start && k <= end) : []),
        ]);
        for (const kd of [...keys].sort()) {
          const c0 = check ? check.get(kd) : undefined;
          if (c0 == null) {
            bucketOk.set(kd, null);
            continue;
          }
          const a = buckets.get(kd) || 0;
          noteDev(a - (c0 + offset));
          checked++;
          if (Math.abs(a - (c0 + offset)) <= tol) {
            matched++;
            bucketOk.set(kd, true);
          } else {
            mismatched++;
            bucketOk.set(kd, false);
          }
        }
      }
      return {
        primary,
        check,
        structured,
        bucketOk,
        offset,
        monthMean,
        checkMonthMean,
        alignMonth,
        cScale,
        mode,
        stat,
        pass,
        checkOnValue: leg.check?.checkOn === "value",
        src: leg.check,
      };
    })
  );
  const dates = [...legs[0].primary.keys()].sort();
  const points = [];
  let uncheckedDates = 0;
  // 判定腿：若某腿声明 checkOn:"value"，它校验的是整个指标的派生值（如 3M−O/N 恒等式），
  // 此时其余只提供分量的腿不参与「是否获并行确认」的判定，否则单腿校验会被误记为未确认。
  const judgeLegs = legs.some((L) => L.checkOnValue) ? legs.filter((L) => L.checkOnValue) : legs;
  for (const d of dates) {
    const entries = legs.map((L) => L.primary.get(d));
    const vals = entries.map((e) => (e == null ? null : typeof e === "object" ? e.v : e));
    if (vals.some((v) => v == null || Number.isNaN(v))) continue;
    // 运算只认两种：diff（差值恒等式）与 ratio（比值恒等式）。分母为 0/NaN 时派生值
    // 会落入完整性层判为越带存疑，不会被静默写库。
    const raw = cfg.operation === "diff" ? vals[0] - vals[1] : cfg.operation === "ratio" ? vals[0] / vals[1] : vals[0];
    const f = 10 ** (cfg.precision ?? 2);
    const v = Math.round(raw * (cfg.scale ?? 1) * f) / f;
    let ok = true, hasCheck = true, alt = null, altBy = null;
    judgeLegs.forEach((L) => {
      const li = legs.indexOf(L);
      const e = entries[li];
      if (L.structured) {
        if (!e || !e.settle || e.settle.size === 0) {
          hasCheck = false;
          return;
        }
        for (const kd of e.settle.keys()) {
          const r = L.bucketOk.get(kd);
          if (r === false) ok = false;
          else if (r == null) hasCheck = false;
        }
      } else {
        // 月频对齐：主序列取当月均值，参照值取当月（日频参照同样按月取均值）
        const mk = L.alignMonth ? d.slice(0, 7) : null;
        const pv = mk ? L.monthMean.get(mk) : L.checkOnValue ? v : vals[li];
        const c0 = L.check ? (L.checkMonthMean ? L.checkMonthMean.get(mk) : L.check.get(d)) : undefined;
        const s = pv == null || c0 == null ? null : L.stat(pv, c0);
        if (s == null) {
          hasCheck = false;
          return;
        }
        checked++;
        noteDev(s);
        if (L.pass(s)) matched++;
        else {
          mismatched++;
          ok = false;
          // alt 一律换算到主序列口径（乘 check.scale、去 offset），供纠错与并列展示
          alt = L.mode === "ratio" ? null : q6(c0 * (L.cScale ?? 1) + (L.offset ?? 0));
          altBy = L.src?.id || L.src?.provider || L.src?.series || "check";
        }
      }
    });
    if (!hasCheck) uncheckedDates++;
    points.push(alt == null ? { d, v, ok: ok ? (hasCheck ? true : null) : false } : { d, v, ok: false, alt, altBy });
  }
  const effCheck = legs.find((L) => L.check && !L.structured);
  const checkMap = effCheck ? (effCheck.checkMonthMean || effCheck.check) : null;
  const cs = cfg.integrity?.cross?.with ? readStore(cfg.integrity.cross.with) : null;
  const refMap = cs?.points?.length ? new Map(cs.points.map((p) => [p.d, p.v])) : null;
  const prevMap = prev?.points?.length ? new Map(prev.points.map((p) => [p.d, p.v])) : null;
  // 纠错：主源与校验源不一致的点，只在「主源值通不过不变量、而校验值通得过」时才改用校验值，
  // 并把改前值/改后值/依据三项留在数据点上（透明改值，不是静默替换）。两值都通得过而彼此
  // 不一致时保留主源、标记存疑，由自检结论如实报告「未获确认」，绝不擅自判定谁对。
  const th = { ...thresholdsFor(cfg), ...(cfg.integrity || {}) };
  let corrected = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ok !== false || p.alt == null) continue;
    const prevV = i > 0 ? points[i - 1].v : null;
    if (plausible(th, p.v, prevV)) continue;
    if (!plausible(th, p.alt, prevV)) continue;
    p.corrected = { from: p.v, to: p.alt, by: p.altBy };
    p.v = p.alt;
    p.ok = true;
    delete p.alt;
    delete p.altBy;
    mismatched--;
    corrected++;
  }
  const integrity = checkIntegrity({
    cfg,
    points,
    checkMap,
    refMap,
    prevMap,
    // 月频对齐时，比对说明要用「按月均值后的主序列」作基准，否则日期键对不上会误报无重叠
    alignMap: effCheck?.checkMonthMean ? [...effCheck.monthMean.entries()].map(([k, v]) => ({ d: k, v })) : null,
  });
  integrity.counts.corrected = corrected;
  if (corrected) integrity.notes.push(`依校验源改值 ${corrected} 点（逐点留有改前/改后/依据）`);
  // 分子/分母腿最新实数快照：展示层只读这份快照，不自行重算（派生口径唯一 owner 是本函数）。
  // 结构化腿（对象值，如回购分桶）没有单一实数，如实跳过。
  const legsMeta = (cfg.legs || [])
    .map((leg, i) => {
      const src = legs[i]?.primary;
      if (!src?.size) return null;
      let asOf = null, latest = null;
      for (const [d, x] of src) {
        if (typeof x === "number" && !Number.isNaN(x)) {
          asOf = d;
          latest = x;
        }
      }
      if (asOf == null) return null;
      return { key: leg.key, label: leg.label, series: leg.primary.series || leg.primary.id || null, unit: leg.unit || null, latest, asOf };
    })
    .filter(Boolean);
  const out = {
    updatedAt: new Date().toISOString(),
    points,
    ...(legsMeta.length ? { legs: legsMeta } : {}),
    validation: {
      checked,
      matched,
      mismatched,
      devRange: devLo === null ? null : [q6(devLo), q6(devHi)],
      corrected,
      uncheckedDates,
      totalDates: points.length,
      checkErrors,
      kind: cfg.checkKind || (legs.some((L) => L.src?.band) ? "关系带宽校验" : "数值逐点校验"),
    },
    integrity,
  };
  // runMeta 是非枚举属性：JSON 快照里看不到，写库时由 store 取用（避免多一份持久化事实）
  Object.defineProperty(out, "runMeta", {
    value: {
      cfg,
      plan,
      usage: drainUsage(),
      startedAt,
      stages: {
        plan: { status: "ok", info: `${plan.mode} ${plan.start}→${plan.end}；${plan.reason}` },
        fetch: { status: (out.validation.checkErrors || []).length ? "degraded" : "ok", info: `${out.validation.checkErrors.length ? out.validation.checkErrors.join(" ; ").slice(0, 160) : "全部腿取回成功"}` },
        validate: { status: "ok", info: `交叉验证 ${out.validation.matched}/${out.validation.checked}，偏差包络 ${JSON.stringify(out.validation.devRange)}` },
        correct: { status: out.validation.corrected ? "ok" : "skipped", info: `依校验源改值 ${out.validation.corrected} 点（逐点留 from/to/by）` },
        commit: { status: out.integrity.verdict === "fail" ? "degraded" : "ok", info: `自检 ${out.integrity.verdict}` },
      },
      status: out.integrity.verdict === "fail" ? "degraded" : "ok",
    },
    enumerable: false,
  });
  return out;
}