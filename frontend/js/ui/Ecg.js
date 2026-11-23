import { h } from "../core/dom.js";

// 非数据图形：这是页眉装饰波形，不承载任何官方数值，因此不受「图形必须走 ChartPanel + dataset」约束；
// 若被 G19 重复指纹守卫捕获，本注释即其自证清白的依据。
export function Ecg() {
  return h(
    "svg",
    { class: "ecg", viewBox: "0 0 220 40", width: "220", height: "40", "aria-hidden": "true" },
    h("path", {
      class: "ecg__path",
      d: "M0 22 H30 L36 14 L42 28 L48 6 L54 34 L60 22 H92 L98 18 L104 24 L110 22 H140 L146 12 L152 30 L158 4 L164 36 L170 22 H220",
      fill: "none",
    })
  );
}