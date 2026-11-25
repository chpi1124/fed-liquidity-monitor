import * as api from "./api.js";
import { layerLabel } from "./recipe-meta.js";

const state = {
  region: "us",
  page: "monitor",
  granularity: "day",
  view: null,
  // 全局政策事件开关：一处切换，所有面板的竖线与 tooltip 政策文字同步显隐。
  // 默认开——与既有行为等价，视觉回归基线不漂移。
  policyOn: true,
  preset: null,
  primary: null,
  sheet: null,
  overlay: "",
  selected: {},
  charts: { specs: [], presets: {}, pages: [] },
  payload: null,
  loading: false,
  error: null,
  refreshing: false,
  ready: false,
  stamp: 0,
};

const subs = new Set();
export const getState = () => state;
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit() {
  state.stamp++;
  for (const fn of subs) fn(state);
}
export function set(patch) {
  Object.assign(state, patch);
  emit();
}

// 序列标签只在进入状态时生成一次：图例、开关、tooltip 读同一份 label
function decorate(payload) {
  for (const v of payload.views || []) for (const l of v.ds?.layers || []) l.label = layerLabel(l);
  return payload;
}

const notReady = (payload) =>
  (payload.views || []).some((v) => v.ds?.error && /未入库|未就绪|not ready/.test(v.ds.error));

function query() {
  const q = new URLSearchParams({ region: state.region, granularity: state.granularity });
  if (state.view) q.set("view", state.view);
  if (state.overlay) q.set("overlay", state.overlay);
  if (state.primary) q.set("primary", state.primary);
  if (state.sheet) q.set("sheet", state.sheet);
  return q.toString();
}

export async function loadPage(retry = 0) {
  set({ loading: true, error: null });
  try {
    const payload = decorate(await api.getPage(state.page, query()));
    if (notReady(payload) && retry < 20) {
      await new Promise((r) => setTimeout(r, 2000));
      return loadPage(retry + 1);
    }
    const preset = state.preset ?? (payload.views.find((v) => v.projection === "panel")?.ds?.defaultPreset || null);
    set({ payload, loading: false, ready: true, preset });
    return payload;
  } catch (e) {
    if (retry < 20) {
      await new Promise((r) => setTimeout(r, 2000));
      return loadPage(retry + 1);
    }
    set({ loading: false, error: e.message });
    return null;
  }
}

export async function init() {
  await loadCharts();
  await loadPage();
}

async function loadCharts() {
  try {
    set({ charts: await api.getCharts(state.region) });
  } catch (e) {
    set({ error: e.message });
  }
}

export async function setRegion(region) {
  if (!region || region === state.region) return;
  set({ region, primary: null, overlay: "", preset: null, sheet: null, selected: {}, payload: null, error: null });
  await loadCharts();
  await loadPage();
}

export function setPage(page) {
  if (!page || page === state.page) return;
  // 页间不共享区间预设：切页回到该页 spec 声明的默认区间
  set({ page, preset: null, payload: null, selected: {} });
  loadPage();
}

export function selectPrimary(id) {
  if (!id) return;
  // 选指标 = 回到该指标的基础看法；不清 view 会被 replace 视图吞掉（SRF 等 9 个指标「无法显示」同类根因）
  const changed = id !== state.primary || !!state.view;
  if (!changed) return;
  set({ primary: id, view: null });
  loadPage();
}

export function setGranularity(g) {
  if (!["day", "week", "month"].includes(g) || g === state.granularity) return;
  set({ granularity: g });
  loadPage();
}

// 视图切换（如「梗差」页的走廊横线 / SOFR 柱）：模式由 spec 声明，切换只是换一套装配参数
export function setView(v) {
  if (!v || v === state.view) return;
  set({ view: v });
  loadPage();
}

// 区间与图层开关是纯视图状态：不惊动后端，也不重画数据管道
// 政策事件显隐是纯视图状态：不惊动后端，也不重取数据。
// 各面板在 option 装配时读这一个开关，一处切换、全站生效。
export function setPolicyOn(on) {
  const v = !!on;
  if (v === state.policyOn) return;
  set({ policyOn: v });
}

export function setPreset(p) {
  if (!p || p === state.preset) return;
  set({ preset: p });
}

export function setSelected(specId, selected) {
  set({ selected: { ...state.selected, [specId]: { ...selected } } });
}

export function toggleLayer(specId, id) {
  const cur = state.selected[specId] || {};
  set({ selected: { ...state.selected, [specId]: { ...cur, [id]: cur[id] === false } } });
}

export function toggleOverlay(id) {
  const list = state.overlay ? state.overlay.split(",").filter(Boolean) : [];
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const panel = (state.payload?.views || []).find((v) => v.projection === "panel");
  const max = panel?.ds?.limits?.totalMax ?? 5;
  if (next.length + 1 > max) return;
  set({ overlay: next.join(",") });
  loadPage();
}

export async function refresh() {
  if (state.refreshing) return;
  set({ refreshing: true });
  try {
    await api.refresh();
    await loadCharts();
    await loadPage();
  } catch (e) {
    set({ error: e.message });
  }
  set({ refreshing: false });
}

export async function silentReload() {
  try {
    await loadCharts();
    await loadPage();
  } catch {}
}

export function panelViews(s = state) {
  return (s.payload?.views || []).filter((v) => v.projection === "panel");
}
