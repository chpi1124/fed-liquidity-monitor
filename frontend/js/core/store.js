import * as api from "./api.js";
import { seriesLabel } from "./derive.js";

const state = {
  region: "us",
  indicators: [],
  activeId: null,
  granularity: "day",
  preset: "1Y",
  series: null,
  loading: false,
  error: null,
  refreshing: false,
  ready: false,
  page: "monitor",
  sheets: [],
  sheetId: null,
  sheet: null,
  sheetLoading: false,
  sheetError: null,
  sheetPreset: "ALL",
  summaries: [],
  summaryData: {},
  summaryLoading: false,
  summaryError: null,
  gold: null,
  goldOn: {},
  goldLoading: false,
  goldError: null,
  goldPreset: "ALL",
};

const subs = new Set();
export const getState = () => state;
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit() {
  for (const fn of subs) fn(state);
}
export function set(patch) {
  Object.assign(state, patch);
  emit();
}

export async function loadSeries() {
  const id = state.activeId;
  const g = state.granularity;
  if (!id) return;
  set({ loading: true, error: null });
  try {
    const s = await api.getSeries(id, g);
    if (state.activeId !== id || state.granularity !== g) return;
    set({ series: s, loading: false });
  } catch (e) {
    if (state.activeId !== id || state.granularity !== g) return;
    set({ loading: false, error: e.message });
  }
}

export async function loadSheet() {
  const id = state.sheetId;
  if (!id) return;
  set({ sheetLoading: true, sheetError: null });
  for (let i = 0; i < 60; i++) {
    try {
      const d = await api.getSheet(id);
      if (state.sheetId !== id) return;
      set({ sheet: d, sheetLoading: false });
      return;
    } catch (e) {
      if (state.sheetId !== id) return;
      if (i === 59) {
        set({ sheetLoading: false, sheetError: e.message });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function loadSummaryPage() {
  const ids = state.summaries.map((s) => s.id);
  if (!ids.length) return;
  set({ summaryLoading: true, summaryError: null });
  for (let i = 0; i < 60; i++) {
    if (state.page !== "summary") return;
    try {
      const arr = await Promise.all(ids.map((id) => api.getSummary(id)));
      if (state.page !== "summary") return;
      const map = {};
      for (const d of arr) map[d.id] = d;
      set({ summaryData: map, summaryLoading: false });
      return;
    } catch (e) {
      if (state.page !== "summary") return;
      if (i === 59) {
        set({ summaryLoading: false, summaryError: e.message });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function pickDefault(inds) {
  return (inds.find((x) => x.surface !== "strip" && x.surface !== "gold") || inds.find((x) => x.surface !== "gold") || inds[0] || {}).id || null;
}

async function fetchLists(region) {
  const [indicators, sheets, summaries] = await Promise.all([
    api.getIndicators(region),
    api.getSheets(region).catch(() => []),
    api.getSummaries(region).catch(() => []),
  ]);
  return { indicators, sheets, summaries };
}

export async function loadGold() {
  const goldInds = state.indicators.filter((i) => i.surface === "gold");
  if (!goldInds.length) return;
  set({ goldLoading: true, goldError: null });
  try {
    const res = await Promise.allSettled(goldInds.map((cfg) => api.getSeries(cfg.id, "day").then((s) => ({ cfg, ...s }))));
    const settled = res.map((r, i) => (r.status === "fulfilled" ? r.value : { cfg: goldInds[i], points: [], error: r.reason?.message || String(r.reason) }));
    if (settled.every((s) => s.error)) throw new Error(settled.map((s) => s.error).join("；"));
    if (!Object.keys(state.goldOn).length) {
      const sel = {};
      for (const s of settled) if (s.cfg.defaultOn === false) sel[seriesLabel(s.cfg)] = false;
      set({ goldOn: sel });
    }
    set({ gold: { series: settled }, goldLoading: false });
  } catch (e) {
    set({ goldLoading: false, goldError: e.message });
  }
}

export function setGoldSelection(sel) {
  set({ goldOn: { ...sel } });
}

export function toggleGoldSeries(label) {
  set({ goldOn: { ...state.goldOn, [label]: state.goldOn[label] === false } });
}

export async function init() {
  for (let i = 0; i < 30; i++) {
    try {
      const { indicators, sheets, summaries } = await fetchLists(state.region);
      if (indicators.length) {
        set({ indicators, sheets, summaries, ready: true, activeId: state.activeId || pickDefault(indicators) });
        await loadSeries();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  set({ error: "后端未就绪，请稍后刷新" });
}

export async function setRegion(region) {
  if (region === state.region || !region) return;
  set({
    region, indicators: [], sheets: [], summaries: [], activeId: null, series: null,
    sheet: null, sheetId: null, summaryData: {}, page: "monitor", error: null,
    gold: null, goldOn: {},
  });
  for (let i = 0; i < 30; i++) {
    if (state.region !== region) return;
    try {
      const { indicators, sheets, summaries } = await fetchLists(region);
      if (state.region !== region) return;
      if (indicators.length) {
        set({ indicators, sheets, summaries, activeId: pickDefault(indicators) });
        await loadSeries();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (state.region === region) set({ error: "该区数据未就绪，请稍后重试" });
}

export function select(id) {
  if (id === state.activeId) return;
  set({ activeId: id, series: null });
  loadSeries();
}

export function setPage(page) {
  if (page === state.page) return;
  if (page === "monitor") {
    set({ page });
    return;
  }
  if (page === "summary") {
    set({ page, summaryData: {}, summaryError: null });
    loadSummaryPage();
    return;
  }
  if (page === "gold") {
    set({ page, gold: null, goldError: null });
    loadGold();
    return;
  }
  set({ page, sheetId: page, sheet: null });
  loadSheet();
}

export function setGranularity(g) {
  if (g === state.granularity) return;
  set({ granularity: g, series: null });
  loadSeries();
}

export function setPreset(p) {
  if (p === state.preset) return;
  set({ preset: p });
}

export function setSheetPreset(p) {
  if (p === state.sheetPreset) return;
  set({ sheetPreset: p });
}

export function setGoldPreset(p) {
  if (p === state.goldPreset) return;
  set({ goldPreset: p });
}

export async function refresh() {
  if (state.refreshing) return;
  set({ refreshing: true });
  const region = state.region;
  try {
    await api.refresh();
    const { indicators, sheets, summaries } = await fetchLists(region);
    if (state.region !== region) return set({ refreshing: false });
    set({ indicators, sheets, summaries, activeId: state.activeId || pickDefault(indicators) });
    await loadSeries();
    if (state.page === "summary") await loadSummaryPage();
    else if (state.page === "gold") await loadGold();
    else if (state.page !== "monitor") await loadSheet();
  } catch (e) {
    set({ error: e.message });
  }
  set({ refreshing: false });
}

export async function silentReload() {
  const region = state.region;
  try {
    const { indicators, sheets, summaries } = await fetchLists(region);
    if (state.region !== region) return;
    set({ indicators, sheets, summaries, activeId: state.activeId || pickDefault(indicators) });
    await loadSeries();
    if (state.page === "summary") await loadSummaryPage();
    else if (state.page === "gold") await loadGold();
    else if (state.page !== "monitor") await loadSheet();
  } catch {}
}