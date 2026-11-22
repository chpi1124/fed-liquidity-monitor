// 通用纠错层（SSOT）：所有序列在入库前都要过同一套不变量检查，
// 与「是否存在第二出版方」无关。原则：只标记、只留痕、只并列数值，
// 绝不静默删除、绝不静默替换、绝不用主源数值冒充双源确认。

const DAY = 86400000;

// 按单位与频率推导默认阈值；指标 JSON 里的 integrity 字段可逐项覆盖。
export function thresholdsFor(cfg) {
  const unit = (cfg.unit || "").trim();
  const freq = cfg.freq || (cfg.surface === "gold" && unit.includes("吨") ? "month" : "day");
  const steps = { day: 1, week: 7, month: 31 }[freq] || 1;
  let t;
  if (unit === "%") t = { abs: true, range: [-10, 40], maxAbsJump: 5 * Math.max(1, steps / 30), maxRelJump: null };
  else if (unit === "bp") t = { abs: true, range: [-3000, 3000], maxAbsJump: 400 * Math.max(1, steps / 7), maxRelJump: null };
  else if (unit.includes("oz") || unit.includes("股")) t = { abs: false, range: [0, 200000], maxAbsJump: null, maxRelJump: 0.3 * Math.max(1, steps / 30) };
  else if (unit.includes("吨")) t = { abs: true, range: [-4000, 4000], maxAbsJump: 1800 * Math.max(1, steps / 30), maxRelJump: null };
  else t = { abs: true, range: [0, 20000], maxAbsJump: 8000 * Math.max(1, steps / 30), maxRelJump: null };
  const lag = { T: 7, "T+1": 9, W: 14, "M+1": 45, "M+2": 75, M: 45 }[cfg.publication] || 30;
  return { ...t, maxLagDays: lag, maxGapDays: Math.max(45, steps * 8), minPoints: 10 };
}

function overlap(a, b) {
  const out = [];
  for (const [d, v] of a) {
    const w = b.get(d);
    if (v != null && w != null) out.push([d, v, w]);
  }
  return out;
}

// 单个数值是否通得过不变量（区间 + 相对上一点的跳变）。纠错判定「该不该改用校验值」用的就是它。
export function plausible(th, v, prevV) {
  if (v == null || Number.isNaN(v)) return false;
  if (th.range && (v < th.range[0] || v > th.range[1])) return false;
  if (prevV != null && !Number.isNaN(prevV)) {
    if (th.maxAbsJump != null && Math.abs(v - prevV) > th.maxAbsJump) return false;
    if (th.maxRelJump != null && prevV !== 0 && Math.abs((v - prevV) / prevV) > th.maxRelJump) return false;
  }
  return true;
}

// points: [{d, v, ok}]；checkMap: Map<date, number>（第二来源，可为校验腿或参照序列）
export function checkIntegrity({ cfg, points, checkMap, refMap, prevMap, alignMap, today = new Date() }) {
  const th = { ...thresholdsFor(cfg), ...(cfg.integrity || {}) };
  const counts = { range: 0, jump: 0, gap: 0, stale: 0, coverage: 0, cross: 0, revised: 0, mismatch: 0 };
  const flagged = [];
  const push = (p, code, detail) => {
    counts[code]++;
    if (code === "range" || code === "jump" || code === "mismatch") p.suspect = code;
    if (flagged.length < 24) flagged.push({ d: p.d, v: p.v, code, detail });
  };
  const notes = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.v == null || Number.isNaN(p.v)) continue;
    if (th.range && (p.v < th.range[0] || p.v > th.range[1])) push(p, "range", `超出合理区间 ${th.range.join(" ~ ")}`);
    if (i > 0) {
      const q = points[i - 1];
      if (q.v != null) {
        const d = p.v - q.v;
        if (th.maxAbsJump != null && Math.abs(d) > th.maxAbsJump) push(p, "jump", `单期变动 ${d.toFixed(2)} 超过上限 ${th.maxAbsJump}`);
        if (th.maxRelJump != null && q.v !== 0 && Math.abs(d / q.v) > th.maxRelJump) push(p, "jump", `单期变动 ${(100 * d / q.v).toFixed(1)}% 超过上限 ${(100 * th.maxRelJump).toFixed(0)}%`);
        const span = (Date.parse(p.d) - Date.parse(q.d)) / DAY;
        if (span > th.maxGapDays) push(p, "gap", `与上一点相隔 ${Math.round(span)} 天`);
      }
    }
    if (checkMap && p.ok === false) push(p, "mismatch", "主源与校验源逐点比对不一致");
    if (prevMap) {
      const old = prevMap.get(p.d);
      if (old != null && Math.abs(old - p.v) > (th.reviseTolerance ?? 1e-9)) push(p, "revised", `官方修订 ${old} → ${p.v}`);
    }
  }

  // 参照序列交叉校验：可用同日期直接比对，也可先把主序列按月求均值再比对
  // （日频交易所价 vs 月频官方均价就走后者）。
  let refOverlap = 0;
  if (th.cross && refMap) {
    const cs = th.cross;
    const pairs = [];
    if (cs.agg === "month-mean") {
      const g = new Map();
      for (const p of points) {
        if (p.v == null) continue;
        const k = p.d.slice(0, 7);
        const o = g.get(k) || [];
        o.push(p.v);
        g.set(k, o);
      }
      for (const [k, arr] of g) {
        const w = refMap.get(`${k}-01`);
        if (w != null && w !== 0) pairs.push([`${k}-01`, arr.reduce((a, b) => a + b, 0) / arr.length, w]);
      }
    } else {
      pairs.push(...overlap(new Map(points.map((p) => [p.d, p.v])), refMap));
    }
    refOverlap = pairs.length;
    const bad = new Set();
    for (const [d, v, w] of pairs) {
      const x = cs.mode === "ratio" ? v / w : v - w;
      if (x < cs.band[0] || x > cs.band[1]) {
        counts.cross++;
        if (flagged.length < 24) flagged.push({ d, v, code: "cross", detail: `与参照序列 ${cs.with} 的${cs.mode === "ratio" ? "比值" : "差值"} ${x.toFixed(4)} 出界 [${cs.band.join(", ")}]` });
        bad.add(d);
      }
    }
    for (const p of points) if (bad.has(p.d) || bad.has(`${p.d.slice(0, 7)}-01`)) p.suspect = "cross";
  }

  const last = points[points.length - 1];
  if (last) {
    const lag = Math.round((today - new Date(`${last.d}T00:00:00Z`)) / DAY);
    if (lag > th.maxLagDays) push(last, "stale", `最新点滞后 ${lag} 天，超过该发布节奏的 ${th.maxLagDays} 天上限`);
  }
  if (points.length < th.minPoints) {
    counts.coverage++;
    flagged.push({ d: last?.d ?? null, v: null, code: "coverage", detail: `仅 ${points.length} 个点，少于 ${th.minPoints}` });
  }

  const basis = alignMap || points.map((p) => ({ d: p.d, v: p.v }));
  const ov = checkMap ? overlap(new Map(basis.map((p) => [p.d, p.v])), checkMap) : [];
  if (checkMap && !ov.length) notes.push("校验源与主源无重叠日期（可能限流或官方尚未发布），本期未获并行确认");
  if (checkMap && ov.length) notes.push(`第二来源并行比对重叠 ${ov.length} 点`);
  if (th.cross && refMap) {
    if (!refOverlap) notes.push(`参照序列 ${th.cross.with} 无重叠日期，交叉校验未生效`);
    else notes.push(`参照序列 ${th.cross.with} 重叠 ${refOverlap} 点，带宽 [${th.cross.band.join(", ")}]${th.cross.agg ? "（主序列按月均值比对）" : ""}`);
  }

  const hard = counts.range + counts.jump + counts.cross + counts.mismatch;
  const soft = counts.stale + counts.coverage + counts.gap + counts.revised;
  return {
    verdict: hard ? "fail" : soft ? "warn" : "ok",
    thresholds: th,
    counts,
    flagged,
    notes,
    checkedAt: today.toISOString(),
  };
}
