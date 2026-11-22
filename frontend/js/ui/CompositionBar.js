import { h } from "../core/dom.js";
import { fmtTrillion } from "../core/derive.js";

const PALETTE = ["#ff8a2a", "#3aa6ff", "#2fd08c", "#e05fd0", "#ffb224", "#35e0a1", "#8fa3b0"];

export function CompositionBar({ segments, total }) {
  if (!segments?.length || !total) return h("div");
  const sum = segments.reduce((s, x) => s + x.value, 0);
  let x = 0;
  const rects = segments.map((sg, i) => {
    const w = (sg.value / sum) * 1000;
    const r = h("rect", {
      x: x.toFixed(2),
      y: 0,
      width: Math.max(w - 1.5, 0.5).toFixed(2),
      height: 30,
      fill: PALETTE[i % PALETTE.length],
    });
    x += w;
    return r;
  });
  return h(
    "section",
    { class: "panel comp-panel" },
    h(
      "div",
      { class: "bal-panel__head" },
      h("h2", null, "资产构成"),
      h("span", { class: "bal-panel__en" }, "Asset composition · 证券明细与其他净资产")
    ),
    h(
      "div",
      { class: "comp-bar", role: "img", "aria-label": "资产构成堆叠条" },
      h("svg", { viewBox: "0 0 1000 30", preserveAspectRatio: "none", width: "100%", height: "30" }, rects)
    ),
    h(
      "div",
      { class: "comp-legend" },
      segments.map((sg, i) =>
        h(
          "span",
          { class: "comp-chip", style: { "--era": PALETTE[i % PALETTE.length] }, title: `${sg.value.toLocaleString("en-US")} 百万美元` },
          h("i"),
          sg.label,
          h("b", null, `${((sg.value / total) * 100).toFixed(2)}%`),
          h("em", null, `${fmtTrillion(sg.value)}万亿`)
        )
      )
    )
  );
}