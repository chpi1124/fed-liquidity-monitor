import { h } from "../core/dom.js";
import * as ui from "../ui/index.js";
import * as store from "../core/store.js";

function activeId(s) {
  const p = (s.payload?.views || []).find((v) => v.projection === "panel");
  return s.primary || p?.ds?.primary || null;
}

export const navView = {
  build: (view) => ({ root: h("div", { class: "side__nav", id: view.container }) }),
  update(built, view, s) {
    built.root.replaceChildren(
      ui.Sidebar({
        indicators: view.members || [],
        activeId: activeId(s),
        onSelect: store.selectPrimary,
      })
    );
  },
};

export const tilesView = {
  build: (view) => ({ root: h("div", { class: "strip", id: view.container, "aria-label": view.ariaLabel || view.title || "序列速览" }) }),
  update(built, view, s) {
    const active = activeId(s);
    built.root.replaceChildren(
      ...(view.members || []).map((cfg, i) =>
        ui.RateTile({ cfg, status: cfg.status, active: cfg.id === active, onClick: () => store.selectPrimary(cfg.id), index: i })
      )
    );
  },
};
