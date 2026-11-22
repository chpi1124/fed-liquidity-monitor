import { h } from "../core/dom.js";
import { PRESETS } from "../core/derive.js";
import { Segmented } from "./Segmented.js";
import { Button } from "./Button.js";
import { Legend } from "./Legend.js";

export function Toolbar({ granularity, onGranularity, preset, onPreset, onRefresh, refreshing, zones, unit }) {
  return h(
    "div",
    { class: "toolbar" },
    Segmented({
      label: "时间粒度",
      value: granularity,
      onChange: onGranularity,
      options: [
        { value: "day", label: "日" },
        { value: "week", label: "周" },
        { value: "month", label: "月" },
      ],
    }),
    Segmented({
      label: "区间定位",
      value: preset,
      onChange: onPreset,
      options: PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.title })),
    }),
    Button({
      label: refreshing ? "更新中…" : "刷新数据",
      variant: "solid",
      onClick: onRefresh,
      disabled: refreshing,
    }),
    Legend({ zones, unit })
  );
}