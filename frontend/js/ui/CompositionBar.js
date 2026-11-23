import { h } from "../core/dom.js";
import { fmtTrillion } from "../core/derive.js";
import { share } from "../core/dataset.js";
import { css, palette } from "../core/theme.js";

// 构成条 = part-to-whole 投影：几何与配色同样来自 dataset/theme，不再自带色表与千分位布局。
export function CompositionBar({ segments, total }) {
  if (!segments?.length || !total) return h("div");
  const theme = palette();
  const pcts = share(segments.map((s) => s.value));
  let x = 0;
  const rects = pcts.map((p, i) => {
    const w = p * 1000;
    const r = h("rect", {
      x: x.toFixed(2),
      y: 0,
      width: (w - 1.5 > 0.5 ? w - 1.5 : 0.5).toFixed(2),
      height: theme.spark.h,
      fill: theme.hueScale[i % theme.hueScale.length],
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
      { class: "comp-bar", role: "img", "aria-label": `资产构成堆叠条：共 ${segments.length} 段，合计 ${fmtTrillion(total)} 万亿美元` },
      h("svg", { viewBox: `0 0 1000 ${theme.spark.h}`, preserveAspectRatio: "none", width: "100%", height: theme.spark.h }, rects)
    ),
    h(
      "div",
      { class: "comp-legend" },
      segments.map((sg, i) =>
        h(
          "span",
          {
            class: "comp-chip",
            style: { "--era": css(`hue-${(i % theme.hueScale.length) + 1}`) },
            title: `${sg.value.toLocaleString("en-US")} 百万美元`,
          },
          h("i"),
          sg.label,
          h("b", null, `${(pcts[i] * 100).toFixed(2)}%`),
          h("em", null, `${fmtTrillion(sg.value)}万亿`)
        )
      )
    )
  );
}
