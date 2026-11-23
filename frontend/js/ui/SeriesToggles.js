import { h } from "../core/dom.js";
import { fmtPoint, validationNote } from "../core/derive.js";
import { css } from "../core/theme.js";

export function SeriesToggles({ layers = [], selected = {}, onToggle }) {
  return h(
    "div",
    { class: "stoggles", role: "group", "aria-label": "趋势图序列开关" },
    layers.map((l) => {
      const on = selected[l.id] !== false;
      const latest = l.latest;
      const v = latest?.v ?? latest?.c;
      return h(
        "button",
        {
          class: "stoggle" + (on ? "" : " is-off"),
          type: "button",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          title: `${l.meta?.formula || l.name}\n来源：${l.meta?.sourceNote || ""} · ${validationNote(l)}\n点击${on ? "关闭" : "开启"}该序列`,
          onclick: () => onToggle(l.id),
        },
        h("i", { class: "stoggle__dot", style: { background: on ? css(l.hue) : "transparent", borderColor: css(l.hue) } }),
        h("span", { class: "stoggle__name" }, l.label),
        h("b", { class: "stoggle__val" }, fmtPoint(l, v)),
        h("span", { class: "stoggle__date" }, latest?.date ? latest.date.slice(0, 7) : "")
      );
    })
  );
}
