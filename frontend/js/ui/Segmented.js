import { h } from "../core/dom.js";

export function Segmented({ options, value, onChange, label }) {
  return h(
    "div",
    { class: "seg", role: "group", "aria-label": label },
    options.map((o) =>
      h(
        "button",
        {
          class: "seg__btn" + (o.value === value ? " is-active" : ""),
          onclick: () => onChange(o.value),
          title: o.title,
        },
        o.label
      )
    )
  );
}