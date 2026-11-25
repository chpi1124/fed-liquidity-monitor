import { h } from "../core/dom.js";
import { Segmented } from "./Segmented.js";

// 日期参数唯一实现：时间粒度（日/周/月）+ 区间定位（近两周/1M/…/全部）。
// 每个图表面板左上方复用同一组件、同一份全局状态：任一切换，所有面板同步。
// 选项全部由调用方从 presets.json 下发的注册表传入，本组件不含任何预设 id 字面量。
export function DateRange({ granularity, granularities = [], preset, presets = [], onGranularity, onPreset }) {
  const kids = [];
  if (granularities.length) {
    kids.push(
      Segmented({
        label: "时间粒度",
        value: granularity,
        onChange: onGranularity,
        options: granularities.map((g) => ({ value: g.id, label: g.label })),
      })
    );
  }
  if (presets.length) {
    kids.push(
      Segmented({
        label: "区间定位",
        value: preset,
        onChange: onPreset,
        options: presets.map((x) => ({ value: x.id, label: x.label, title: x.title })),
      })
    );
  }
  return h("div", { class: "date-range", role: "group", "aria-label": "日期参数" }, kids);
}
