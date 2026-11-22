import { h } from "../core/dom.js";

export function Sparkline({ values, color, width = 104, height = 30 }) {
  if (!values || values.length < 2) return h("span", { class: "spark" });
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * (width - 6) + 3,
    height - 4 - ((v - min) / span) * (height - 9),
  ]);
  const line = pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");
  const last = pts[pts.length - 1];
  return h(
    "svg",
    { class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" },
    h("polyline", {
      points: line,
      fill: "none",
      stroke: color,
      "stroke-width": "1.6",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      opacity: "0.9",
    }),
    h("circle", { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: "2.2", fill: color })
  );
}