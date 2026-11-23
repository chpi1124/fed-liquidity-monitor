import { h } from "../core/dom.js";
import { css } from "../core/theme.js";

// 叠加选择器：任意指标都能叠到同一张图上；同轴只用于真比较，异轴只用于看相关性——上限由后端 spec 判定，这里照实显示。
export function OverlayPicker({ options = [], selected = [], onToggle, limits = {} }) {
  const full = selected.length >= (limits.totalMax ?? 5) - 1;
  return h(
    "div",
    { class: "stoggles", role: "group", "aria-label": "叠加序列" },
    h("span", { class: "stoggle__name" }, "叠加"),
    options.map((o) => {
      const on = selected.includes(o.id);
      return h(
        "button",
        {
          class: "stoggle" + (on ? " is-active" : full && !on ? " is-off" : ""),
          type: "button",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          disabled: full && !on,
          title: `${o.name}（${o.unit || ""}）\n校验方式：${o.checkKind || "未声明"}\n同轴 ≤${limits.sharedMax ?? "—"} 条为直接比较，异轴只用于看相关性；合计 ≤${limits.totalMax ?? "—"} 条`,
          onclick: () => onToggle(o.id),
        },
        h("i", { class: "stoggle__dot", style: { background: on ? css(o.hue || "accent") : "transparent", borderColor: css(o.hue || "accent") } }),
        h("span", { class: "stoggle__name" }, o.name)
      );
    })
  );
}

export function EraChips({ eras = [] }) {
  return h(
    "div",
    { class: "era-legend", "aria-label": "历史时期图例" },
    eras.map((e) => h("span", { class: "era-chip", style: { "--era": css(e.color) } }, h("i"), e.label))
  );
}
