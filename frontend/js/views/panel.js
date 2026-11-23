import { h } from "../core/dom.js";
import * as panels from "../core/chart-panel.js";
import * as store from "../core/store.js";
import { EmptyState } from "../ui/index.js";

// 图例事件 → store：渲染层不认识选中状态，只把「哪条被关掉」交回唯一状态源
function relayLegend(container) {
  return (e) => {
    const s = store.getState();
    const view = (s.payload?.views || []).find((v) => v.container === container);
    if (!view?.ds?.layers) return;
    const byLabel = new Map(view.ds.layers.map((l) => [l.label, l.id]));
    const next = {};
    for (const [label, on] of Object.entries(e.selected || {})) {
      const id = byLabel.get(label);
      if (id) next[id] = on;
    }
    store.setSelected(view.specId, next);
  };
}

export const panelView = {
  // 入文档之后再挂载：ECharts 需要真实尺寸，脱离文档时 init 只会得到 0x0 画布
  attach(built, view) {
    if (built.attached) return;
    panels.mount(view.container, built.chart, view.spec);
    panels.on(view.container, "legendselectchanged", relayLegend(view.container));
    built.attached = true;
  },

  build(view) {
    const chart = h("div", { class: `chart${view.size ? ` chart--${view.size}` : ""}`, id: view.container });
    const empty = h("div", { class: "chart-empty", hidden: true });
    return { root: h("section", { class: "panel chart-panel" }, chart, empty), chart, empty, keys: {}, attached: false };
  },

  update(built, view, s) {
    const ds = view.ds;
    if (!ds || ds.error || !ds.layers?.some((l) => l.values?.length || l.ohlc?.length)) {
      built.chart.hidden = true;
      built.empty.hidden = false;
      built.empty.replaceChildren(EmptyState({ text: ds?.error || view.empty || s.error || "等待数据…" }));
      built.keys = {};
      return;
    }
    // 叠加上限只在后端判定一次，前端照实说明并拒绝画成「挤成一团」
    if (ds.overflow?.length) {
      built.chart.hidden = true;
      built.empty.hidden = false;
      built.empty.replaceChildren(EmptyState({ text: `${ds.overflow.join("；")}——请关闭部分序列或另开一页，本站不把可读性牺牲给堆叠。` }));
      return;
    }
    built.chart.hidden = false;
    built.empty.hidden = true;

    const selected = s.selected[view.specId] || {};
    // policyOn 进 dataKey：政策开关变化时走整-option 重建（竖线在 markLine、文字在 tooltip，必须一起换）
    const dataKey = [view.specId, s.granularity, ds.updatedAt, ds.layers.map((l) => `${l.id}:${l.updatedAt || ""}:${l.values?.length || 0}`).join("|"), ds.overlayIds?.join(",") || "", s.policyOn].join("#");
    const windowKey = s.preset;
    const selectKey = JSON.stringify(selected);

    if (built.keys.dataKey !== dataKey) {
      panels.update(view.container, { spec: view.spec, ds, preset: windowKey, selected, policyOn: s.policyOn });
      built.keys = { dataKey, windowKey, selectKey };
      return;
    }
    if (built.keys.windowKey !== windowKey) {
      panels.setWindow(view.container, { preset: windowKey });
      built.keys.windowKey = windowKey;
    }
    if (built.keys.selectKey !== selectKey) {
      panels.setSelected(view.container, selected);
      built.keys.selectKey = selectKey;
    }
  },
};
