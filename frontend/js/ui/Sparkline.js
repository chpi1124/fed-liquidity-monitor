import { h } from "../core/dom.js";
import { geometry } from "../core/dataset.js";
import { palette } from "../core/theme.js";

// 微型折线：几何来自 dataset.geometry（与主图同一把尺子），颜色来自 token，本组件不再自己算 min/max。
export function Sparkline({ values, color, width, height }) {
  const theme = palette();
  const w = width ?? theme.spark.w;
  const hh = height ?? theme.spark.h;
  const geo = geometry(values || [], w, hh);
  if (!geo) return h("span", { class: "spark" });
  const line = geo.pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");
  return h(
    "svg",
    { class: "spark", width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, "aria-hidden": "true" },
    h("polyline", {
      points: line,
      fill: "none",
      stroke: color,
      "stroke-width": "1.6",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      opacity: "0.9",
    }),
    h("circle", { cx: geo.last[0].toFixed(1), cy: geo.last[1].toFixed(1), r: "2.2", fill: color })
  );
}
