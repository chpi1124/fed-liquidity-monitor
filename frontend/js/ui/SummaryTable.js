import { h } from "../core/dom.js";
import { fmtVal } from "../core/derive.js";
import { Badge } from "./Badge.js";
import { css } from "../core/theme.js";

function okMark(row) {
  const cls = row.ok === true ? "is-ok" : row.ok === false ? "is-bad" : "is-na";
  const title = row.checkLabel && row.checkLabel !== "—"
    ? `交叉验证：${row.sourceLabel} × ${row.checkLabel}${row.ok === true ? " · 通过" : row.ok === false ? " · 不一致" : " · 窗口内无对照点"}`
    : "单一官方源，无第二源交叉验证";
  return h("span", { class: `bal-ok ${cls}`, title }, row.ok === true ? "✓" : row.ok === false ? "✗" : "·");
}

function deltaTag(row) {
  if (row.delta == null) return null;
  const dir = row.delta > 0 ? "up" : row.delta < 0 ? "down" : "flat";
  const arrow = row.delta > 0 ? "▲" : row.delta < 0 ? "▼" : "·";
  return h("span", { class: `sum-delta is-${dir}`, title: "较上周变化" }, `${arrow} ${row.delta > 0 ? "+" : ""}${fmtVal(row.delta, row)}`);
}

function numCell(row, key, isThis) {
  if (row.status === "no-source") return h("td", { class: "bal-num sum-na", title: row.note }, "—");
  if (row.status === "monthly-only") {
    if (!isThis) return h("td", { class: "bal-num sum-na" }, "—");
    const o = row.official;
    return h(
      "td",
      { class: "bal-num sum-v", title: `${row.sourceLabel} · 截至 ${o.asOf}` },
      h("span", { class: "sum-fig" }, fmtVal(o.level, row)),
      h("small", { class: "sum-unit" }, row.unit),
      h("span", { class: "sum-monthly" }, `月度 ${o.asOf}`)
    );
  }
  const kids = [h("span", { class: "sum-fig" }, fmtVal(row[key], row)), h("small", { class: "sum-unit" }, row.unit)];
  if (isThis) {
    const sub = [];
    if (row.extra?.min != null) sub.push(h("span", { class: "sum-extra", title: "本周窗口内最低值" }, `最低 ${fmtVal(row.extra.min, row)}`));
    sub.push(deltaTag(row), okMark(row));
    kids.push(h("span", { class: "sum-sub" }, sub));
  }
  return h("td", { class: "bal-num sum-v" + (isThis && row.highlight ? " is-hl" : ""), title: row.sourceLabel }, kids);
}

// 状态与走廊色都走 token；「无权威公开源」这类行必须看得见，不藏进脚注
function zoneCell(row) {
  if (row.status === "no-source")
    return h("td", { class: "sum-zone" }, Badge({ text: "无权威公开源", color: css("faint"), title: `${row.note}\n证据：\n${(row.evidence || []).join("\n")}` }));
  if (row.status === "pending-source")
    return h("td", { class: "sum-zone" }, Badge({ text: "官方源待接入", color: css("info"), title: `${row.note}\n官方源：\n${(row.evidence || []).join("\n")}` }));
  if (row.status === "monthly-only") return h("td", { class: "sum-zone" }, Badge({ text: "官方月度", color: css("info"), title: row.note }));
  if (row.status === "single-source") return h("td", { class: "sum-zone" }, Badge({ text: "单源代理", color: css("warn"), title: row.note }));
  if (row.zone) return h("td", { class: "sum-zone" }, Badge({ text: row.zone.label, color: css(row.zone.color), title: row.note }));
  return h("td", { class: "sum-zone sum-na" }, "—");
}

export function SummaryTable({ data }) {
  const lastCol = data.columns.length - 1;
  return h(
    "section",
    { class: "panel bal-panel sum-panel" },
    h(
      "div",
      { class: "bal-panel__head" },
      h("h2", null, data.name),
      h("span", { class: "bal-panel__asof", title: "H.4.1 最新周三锚点" }, `截至 ${data.asOf}`)
    ),
    h(
      "div",
      { class: "sum-meta" },
      Badge({ text: `本周 ${data.thisWeek.start} ~ ${data.thisWeek.end}`, color: css("info"), title: "截至 asOf 的 7 天窗口" }),
      Badge({ text: `上周 ${data.lastWeek.start} ~ ${data.lastWeek.end}` }),
      Badge({
        text: `交叉验证 ${data.validation.matched}/${data.validation.checked}${data.validation.mismatched ? ` · ${data.validation.mismatched} 不一致` : ""}`,
        color: data.validation.mismatched ? css("danger") : data.validation.checked ? css("ok") : css("faint"),
        title: "主源与校验源逐点比对；0/0 表示本表均为单源或无公开源行（透明标注）",
      })
    ),
    h(
      "div",
      { class: "bal-scroll" },
      h(
        "table",
        { class: "bal-table sum-table" },
        h(
          "thead",
          null,
          h("tr", null, data.columns.map((c, i) => h("th", { class: i === 0 ? "bal-th-name" : i === lastCol ? "sum-th-zone" : "" }, c)))
        ),
        h(
          "tbody",
          null,
          data.rows.map((row) =>
            h(
              "tr",
              { class: "bal-row sum-row" + (row.highlight ? " is-hl" : "") + (row.status === "no-source" ? " is-nosrc" : "") },
              h("td", { class: "bal-name sum-name", title: row.note }, h("span", { class: "bal-zh" }, row.zh), h("span", { class: "bal-en" }, row.en)),
              numCell(row, "lastWeek", false),
              numCell(row, "thisWeek", true),
              zoneCell(row)
            )
          )
        )
      )
    )
  );
}

export function SummaryTables({ items }) {
  return h("div", { class: "sum-stack" }, items.map((data) => SummaryTable({ data })));
}
