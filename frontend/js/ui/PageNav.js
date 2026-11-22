import { h } from "../core/dom.js";
import { fmtTrillion } from "../core/derive.js";

export function PageNav({ sheets, summaries = [], gold = false, page, onPage }) {
  const sumReady = summaries.length && summaries.every((s) => s.status?.ready);
  const sumRows = summaries.reduce((n, s) => n + (s.status?.rowCount ?? 0), 0);
  return h(
    "nav",
    { class: "page-nav", "aria-label": "页面切换" },
    h(
      "button",
      { class: "page-btn" + (page === "monitor" ? " is-active" : ""), onclick: () => onPage("monitor") },
      h("span", { class: "page-btn__name" }, "指标监控"),
      h("span", { class: "page-btn__sub" }, "LIQUIDITY RATES")
    ),
    h(
      "button",
      { class: "page-btn" + (page === "summary" ? " is-active" : ""), onclick: () => onPage("summary") },
      h("span", { class: "page-btn__name" }, "周度汇总"),
      h("span", { class: "page-btn__sub" }, sumReady ? `${sumRows} 项 · WEEKLY DIGEST` : "WEEKLY DIGEST · 加载中")
    ),
    gold
      ? h(
          "button",
          { class: "page-btn" + (page === "gold" ? " is-active" : ""), onclick: () => onPage("gold") },
          h("span", { class: "page-btn__name" }, "黄金 · 实际利率"),
          h("span", { class: "page-btn__sub" }, "REAL YIELD vs GOLD")
        )
      : null,
    sheets.map((s) =>
      h(
        "button",
        { class: "page-btn" + (page === s.id ? " is-active" : ""), onclick: () => onPage(s.id) },
        h("span", { class: "page-btn__name" }, s.name),
        h("span", { class: "page-btn__sub" }, s.status?.ready ? `${fmtTrillion(s.status.total)} 万亿` : "H.4.1 · 加载中")
      )
    )
  );
}