import { h } from "../core/dom.js";
import { colorOf, fmtVal } from "../core/derive.js";
import { css } from "../core/theme.js";

export function Sidebar({ indicators, activeId, onSelect }) {
  return h(
    "nav",
    { class: "ind-nav", "aria-label": "指标切换" },
    indicators.map((ind, i) =>
      h(
        "button",
        {
          class: "ind-btn" + (ind.id === activeId ? " is-active" : ""),
          style: { "animation-delay": `${i * 60}ms` },
          onclick: () => onSelect(ind.id),
        },
        h("span", { class: "ind-btn__name" }, ind.name),
        h(
          "span",
          { class: "ind-btn__val" },
          ind.status?.latest ? `${fmtVal(ind.status.latest.v, ind)}${ind.unit}` : "…",
          h("i", {
            class: "ind-btn__dot",
            style: { background: css(colorOf(ind.zones, ind.status?.latest?.v, ind.hue)) },
          })
        )
      )
    )
  );
}