function mondayOf(d) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

// 存疑点不删除、不隐藏：日频原样带出 suspect；周/月频仅在「该桶存在至少一个已确认点」时
// 把存疑点排除出 OHLC（否则仍以其为准并整桶标记存疑），避免出现静默空洞。
export function aggregate(points, g) {
  if (g === "day") return points.map((p) => ({ date: p.d, v: p.v, ok: p.ok, suspect: p.suspect ?? null, corrected: p.corrected ?? null }));
  const groups = new Map();
  for (const p of points) {
    const k = g === "week" ? mondayOf(p.d) : p.d.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.entries()].map(([date, ps]) => {
    const good = ps.filter((p) => !p.suspect);
    const use = good.length ? good : ps;
    return {
      date,
      o: use[0].v,
      c: use[use.length - 1].v,
      h: Math.max(...use.map((p) => p.v)),
      l: Math.min(...use.map((p) => p.v)),
      ok: use[use.length - 1].ok,
      n: ps.length,
      suspect: good.length ? (ps.length - good.length) : use[0].suspect ?? null,
      corrected: ps.filter((p) => p.corrected).length || null,
    };
  });
}
