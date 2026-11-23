import { h } from "../core/dom.js";
import { Badge } from "./Badge.js";
import { css } from "../core/theme.js";

// 工具栏只有一条：把视图声明的控件按顺序排进来，不再每页各造一个 toolbar。
export function Toolbar({ children = [], identities }) {
  // 无报表恒等式的页面（监控台/黄金/汇总）identities 为空：空数组也是一种答案，不是缺参数
  const ids = identities || [];
  return h(
    "div",
    { class: "toolbar" },
    ...children.filter(Boolean),
    ids.length
      ? h(
          "div",
          { class: "identity-badges" },
          ids.map((id) =>
            Badge({
              text: `${id.label} ${id.ok ? "✓" : "✗"}（差 ${id.diff >= 0 ? "+" : ""}${id.diff}）`,
              color: id.ok ? css("ok") : css("danger"),
              title: `叶子合计 ${id.actual.toLocaleString("en-US")} vs 总资产 ${id.expected.toLocaleString("en-US")} 百万美元`,
            })
          )
        )
      : null
  );
}
