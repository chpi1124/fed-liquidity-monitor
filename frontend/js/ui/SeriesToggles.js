import { h } from "../core/dom.js";
import { fmtPoint, seriesLabel, validationNote } from "../core/derive.js";

export function SeriesToggles({ series, selected = {}, onToggle }) {
  return h(
    "div",
    { class: "stoggles", role: "group", "aria-label": "趋势图序列开关" },
    (series || []).map((s) => {
      const label = seriesLabel(s.cfg);
      const broken = !!s.error;
      const on = !broken && selected[label] !== false;
      const last = s.points?.[s.points.length - 1];
      return h(
        "button",
        {
          class: "stoggle" + (on ? "" : " is-off"),
          type: "button",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          title: `${s.cfg.formula || s.cfg.name}\n来源：${s.cfg.sourceNote || ""} · ${validationNote(s)}${broken ? `\n取数失败：${s.error}` : ""}\n点击${on ? "关闭" : "开启"}该序列`,
          onclick: () => onToggle(label),
        },
        h("i", {
          class: "stoggle__dot",
          style: { background: on ? s.cfg.hue : "transparent", borderColor: s.cfg.hue },
        }),
        h("span", { class: "stoggle__name" }, label),
        h("b", { class: "stoggle__val" }, broken ? "取数失败" : fmtPoint(s.cfg, last?.v)),
        h("span", { class: "stoggle__date" }, broken ? "" : last ? last.date.slice(0, 7) : "")
      );
    })
  );
}
