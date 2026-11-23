import * as store from "./core/store.js";
import * as ui from "./ui/index.js";
import { projectionOf } from "./views/index.js";
import { h, mount } from "./core/dom.js";

// 组合根：只做三件事——把市场与页面导航挂上、按 spec 声明的视图建骨架、把状态喂给视图。
// 本文件不出现任何 spec id、容器 id 或页面 id 字面量（G22 页面即数据）。
const slots = {
  region: document.getElementById("slot-region"),
  nav: document.getElementById("page-nav"),
  side: document.getElementById("slot-side"),
  main: document.getElementById("slot-main"),
};

const built = new Map();
let skeletonKey = "";
let chromeKey = "";
let regionKey = "";

const viewKeyOf = (s) => (s.payload?.views || []).map((v) => `${v.container}:${v.projection}`).join("|");
const skeletonKeyOf = (s) => `${s.region}#${s.page}#${viewKeyOf(s)}`;

function buildSkeleton(s) {
  for (const el of [slots.side, slots.main]) el.replaceChildren();
  built.clear();
  for (const view of s.payload?.views || []) {
    const p = projectionOf(view.projection);
    const refs = p.build(view, s);
    (view.slot === "side" ? slots.side : slots.main).append(refs.root);
    built.set(view.container, { p, refs });
  }
  // 骨架整体入文档后，才允许视图挂载需要真实尺寸的组件
  for (const [container, b] of built) b.p.attach?.(b.refs, (s.payload.views || []).find((v) => v.container === container), s);
  skeletonKey = skeletonKeyOf(s);
}

function updateViews(s) {
  for (const view of s.payload?.views || []) {
    const b = built.get(view.container);
    if (b) b.p.update(b.refs, view, s);
  }
}

function updateChrome(s) {
  const rkey = `${s.region}|${(s.charts.regions || []).map((r) => r.id).join(",")}`;
  if (rkey !== regionKey) {
    mount(
      slots.region,
      ui.Segmented({
        label: "市场",
        value: s.region,
        onChange: store.setRegion,
        options: (s.charts.regions || []).map((r) => ({ value: r.id, label: r.label, title: r.title })),
      })
    );
    regionKey = rkey;
  }
  const nkey = `${s.page}|${(s.charts.pages || []).map((p) => p.updatedAt).join(",")}`;
  if (nkey !== chromeKey) {
    mount(slots.nav, ui.PageNav({ pages: s.charts.pages || [], active: s.page, onPage: store.setPage }));
    chromeKey = nkey;
  }
}

function render(s) {
  updateChrome(s);
  if (!s.payload) {
    if (skeletonKey !== "pending") {
      slots.side.replaceChildren();
      slots.main.replaceChildren(h("section", { class: "panel chart-panel" }, ui.EmptyState({ text: s.error || "加载数据中…" })));
      built.clear();
      skeletonKey = "pending";
    }
    return;
  }
  if (skeletonKeyOf(s) !== skeletonKey) buildSkeleton(s);
  updateViews(s);
}

store.subscribe(render);
store.init();
setInterval(() => store.silentReload(), 10 * 60 * 1000);
