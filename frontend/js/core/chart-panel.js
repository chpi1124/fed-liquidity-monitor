// 全站唯一的 ECharts 出口。模块级可变状态为零：实例与最近一次渲染输入都存在 panels 注册表的条目里，
// 状态（区间、图层开关、粒度）的唯一 owner 是 core/store.js，本文件只按 store 的指令重投影。
import { buildOption, buildWindow } from "./chart-option.js";
import { palette } from "./theme.js";
import { panelSummary } from "./derive.js";

const panels = new Map();
const runtime = { resizeBound: false };

function bindResize() {
  if (runtime.resizeBound) return;
  runtime.resizeBound = true;
  window.addEventListener("resize", () => resizeAll());
}

export function mount(id, el, spec) {
  const existing = panels.get(id);
  if (existing && existing.el === el) return existing.inst;
  if (existing) dispose(id);
  const inst = window.echarts.init(el);
  bindResize();
  el.setAttribute("role", "img");
  panels.set(id, { id, el, inst, spec, last: null });
  return inst;
}

export function update(id, { spec, ds, preset, selected = {}, policyOn = true }) {
  const p = panels.get(id);
  if (!p || !ds?.x?.values?.length) return false;
  p.spec = spec;
  p.last = { ds, preset, selected, policyOn };
  const theme = palette();
  p.inst.setOption(buildOption({ spec, ds, preset, selected, theme, policyOn }), { notMerge: true });
  p.el.setAttribute("aria-label", panelSummary(spec, ds, selected));
  return true;
}

// 只改区间：不重建 option，也不重取数据
export function setWindow(id, { preset }) {
  const p = panels.get(id);
  if (!p || !p.last) return false;
  p.last = { ...p.last, preset };
  p.inst.setOption({ dataZoom: buildWindow(p.last.ds.x.values, preset, p.last.ds, palette()) });
  return true;
}

export function setSelected(id, selected) {
  const p = panels.get(id);
  if (!p || !p.last) return false;
  return update(id, { spec: p.spec, ds: p.last.ds, preset: p.last.preset, selected, policyOn: p.last.policyOn });
}

export function on(id, evt, handler) {
  const p = panels.get(id);
  if (p) p.inst.on(evt, handler);
}

export function dispose(id) {
  const p = panels.get(id);
  if (!p) return;
  p.inst.dispose();
  panels.delete(id);
}

export function instances() {
  return [...panels.keys()];
}

export function resizeAll() {
  for (const p of panels.values()) p.inst.resize();
}
