import { h } from "../core/dom.js";
import { SHEET_PRESETS } from "../core/derive.js";
import { Segmented } from "./Segmented.js";
import { Button } from "./Button.js";
import { Badge } from "./Badge.js";

export function SheetToolbar({ preset, onPreset, onRefresh, refreshing, validation, eras }) {
  return h(
    "div",
    { class: "toolbar" },
    Segmented({
      label: "区间定位",
      value: preset,
      onChange: onPreset,
      options: SHEET_PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.title })),
    }),
    Button({
      label: refreshing ? "更新中…" : "刷新数据",
      variant: "solid",
      onClick: onRefresh,
      disabled: refreshing,
    }),
    validation
      ? h(
          "div",
          { class: "identity-badges" },
          validation.identities.map((id) =>
            Badge({
              text: `${id.label} ${id.ok ? "✓" : "✗"}（差 ${id.diff >= 0 ? "+" : ""}${id.diff}）`,
              color: id.ok ? "var(--ok)" : "var(--danger)",
              title: `叶子合计 ${id.actual.toLocaleString("en-US")} vs 总资产 ${id.expected.toLocaleString("en-US")} 百万美元`,
            })
          )
        )
      : null,
    h(
      "div",
      { class: "era-legend", "aria-label": "历史时期图例" },
      (eras || []).map((e) => h("span", { class: "era-chip", style: { "--era": e.color } }, h("i"), e.label))
    )
  );
}