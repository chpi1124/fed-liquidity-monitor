import fs from "node:fs";
import path from "node:path";
import { SHEETS_DIR } from "./paths.js";
import { getSeries } from "./cache.js";

export function loadSheets(region) {
  if (!fs.existsSync(SHEETS_DIR)) return [];
  let list = fs
    .readdirSync(SHEETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SHEETS_DIR, f), "utf8")));
  if (region) list = list.filter((c) => (c.region || "us") === region);
  return list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

export async function updateSheet(cfg, { force = false } = {}) {
  const end = new Date().toISOString().slice(0, 10);
  const start = cfg.historyStart || "2002-12-18";
  const tol = cfg.tolerance ?? 1;
  const idTol = cfg.identityTolerance ?? 2;
  const [board, ...checkMaps] = await Promise.all([
    getSeries({ provider: "frb-h41" }, start, end, force),
    ...cfg.checkSeries.map((id) => getSeries({ provider: "fred", series: id }, start, end, force)),
  ]);
  const checks = new Map(cfg.checkSeries.map((id, i) => [id, checkMaps[i]]));
  const totalMap = checks.get(cfg.totalSeries);
  if (!totalMap || !totalMap.has(board.date)) throw new Error(`H.4.1 asOf ${board.date} missing in FRED ${cfg.totalSeries}`);
  const history = [...totalMap.keys()].sort().map((d) => ({ d, v: totalMap.get(d) }));
  const total = totalMap.get(board.date);
  const dates = [board.date, board.prevDate, board.yearAgoDate];

  let checked = 0, matched = 0, mismatched = 0;
  const groups = cfg.groups.map((g) => {
    const items = g.items.map((it) => {
      const row = board.rows.get(it.board);
      if (!row) throw new Error(`H.4.1 row not found: ${it.board}`);
      const { v, wc, yc } = row;
      let ok = null;
      if (it.check) {
        const cm = checks.get(it.check);
        const reconstructed = [v, wc == null ? null : v - wc, yc == null ? null : v - yc];
        ok = true;
        dates.forEach((d, i) => {
          const fv = cm?.get(d);
          const bv = reconstructed[i];
          if (fv == null || bv == null) return;
          checked++;
          if (Math.abs(bv - fv) <= tol) matched++;
          else { mismatched++; ok = false; }
        });
      }
      return { ...it, v, wc, yc, ok, share: total ? (v / total) * 100 : null };
    });
    return { ...g, items };
  });

  const leafSum = (keys) =>
    groups.filter((g) => keys.includes(g.key)).flatMap((g) => g.items).filter((it) => it.leaf)
      .reduce((s, it) => s + it.v, 0);
  const assetSum = leafSum(["assets"]);
  const lcSum = leafSum(["liabilities", "capital"]);
  const identities = [
    { key: "assets", label: "资产叶子合计 = 总资产", actual: assetSum, expected: total, diff: assetSum - total, ok: Math.abs(assetSum - total) <= tol },
    { key: "liabilities-capital", label: "负债 + 资本 = 总资产", actual: lcSum, expected: total, diff: lcSum - total, ok: Math.abs(lcSum - total) <= idTol },
  ];
  for (const id of identities) {
    checked++;
    if (id.ok) matched++;
    else mismatched++;
  }
  const sideOk = { assets: identities[0].ok, liabilities: identities[1].ok, capital: identities[1].ok };
  for (const g of groups) for (const it of g.items) if (it.ok == null) it.ok = sideOk[g.key];

  const totalRow = groups.flatMap((g) => g.items).find((it) => it.total && it.check === cfg.totalSeries);
  return {
    updatedAt: new Date().toISOString(),
    asOf: board.date,
    prevDate: board.prevDate,
    yearAgoDate: board.yearAgoDate,
    total,
    totalWc: totalRow?.wc ?? null,
    groups,
    history,
    validation: { checked, matched, mismatched, identities },
  };
}