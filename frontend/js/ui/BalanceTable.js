import { h } from "../core/dom.js";
import { fmtTrillion, fmtYi } from "../core/derive.js";

function okMark(it) {
  const cls = it.ok === true ? "is-ok" : it.ok === false ? "is-bad" : "is-na";
  const title = it.check
    ? `校验源 FRED ${it.check}：最新 / 上周 / 去年同期三个周三比对${it.ok === true ? "通过" : it.ok === false ? "不一致" : ""}`
    : "以「资产 = 负债 + 资本」会计恒等式校验";
  return h("span", { class: `bal-ok ${cls}`, title }, it.ok === true ? "✓" : it.ok === false ? "✗" : "·");
}

function wcCell(wc) {
  if (wc == null) return h("td", { class: "bal-num bal-wc" }, "—");
  const dir = wc > 0 ? "up" : wc < 0 ? "down" : "flat";
  const arrow = wc > 0 ? "▲" : wc < 0 ? "▼" : "·";
  return h(
    "td",
    { class: `bal-num bal-wc is-${dir}`, title: `${wc.toLocaleString("en-US")} 百万美元（周环比）` },
    `${arrow} ${wc > 0 ? "+" : ""}${fmtYi(wc)}`
  );
}

export function BalanceTable({ group, asOf, prevDate, yearAgoDate }) {
  return h(
    "section",
    { class: "panel bal-panel", style: { "--ghue": group.hue || "#ff8a2a" } },
    h(
      "div",
      { class: "bal-panel__head" },
      h("h2", null, group.label),
      h("span", { class: "bal-panel__en" }, group.en),
      h("span", { class: "bal-panel__asof", title: `环比对照 ${prevDate} · 同比对照 ${yearAgoDate}` }, `截至 ${asOf}`)
    ),
    h(
      "div",
      { class: "bal-scroll" },
      h(
        "table",
        { class: "bal-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { class: "bal-th-name" }, "项目"),
            h("th", null, "规模·万亿"),
            h("th", null, "占比"),
            h("th", { title: "较上周变化，亿美元" }, "周环比·亿"),
            h("th", null, "校验")
          )
        ),
        h(
          "tbody",
          null,
          group.items.map((it) =>
            h(
              "tr",
              { class: "bal-row" + (it.total ? " is-total" : it.subtotal ? " is-subtotal" : "") },
              h(
                "td",
                { class: "bal-name", style: { paddingLeft: `${12 + (it.depth || 0) * 16}px` } },
                h("span", { class: "bal-zh" }, it.zh),
                h("span", { class: "bal-en" }, it.en),
                it.note ? h("span", { class: "bal-note" }, it.note) : null
              ),
              h(
                "td",
                { class: "bal-num bal-v", title: `${it.v.toLocaleString("en-US")} 百万美元` },
                fmtTrillion(it.v)
              ),
              h("td", { class: "bal-num bal-share" }, it.share == null ? "—" : `${it.share.toFixed(2)}%`),
              wcCell(it.wc),
              h("td", { class: "bal-check" }, okMark(it))
            )
          )
        )
      )
    )
  );
}

export function BalanceTables({ groups, asOf, prevDate, yearAgoDate }) {
  const assets = groups.filter((g) => g.key === "assets");
  const rest = groups.filter((g) => g.key !== "assets");
  const props = { asOf, prevDate, yearAgoDate };
  return h(
    "div",
    { class: "tables" },
    h("div", { class: "tables__col" }, assets.map((g) => BalanceTable({ group: g, ...props }))),
    h("div", { class: "tables__col" }, rest.map((g) => BalanceTable({ group: g, ...props })))
  );
}