import { h } from "../core/dom.js";
import { rangeText } from "../core/derive.js";

export function Legend({ zones, unit }) {
  if (!zones) return null;
  return h(
    "span",
    { class: "legend" },
    zones.map((z, i) =>
      h("span", { class: "legend__item" }, h("i", { style: { background: z.color } }), `${z.label} ${rangeText(zones, i)}${unit || ""}`)
    )
  );
}