import { h } from "../core/dom.js";
import { hintText } from "../core/derive.js";

// 页面导航完全由 charts/*.json 派生：新增一页只写 spec，这里不需要改。
export function PageNav({ pages = [], active, onPage }) {
  return h(
    "nav",
    { class: "page-nav", "aria-label": "页面切换" },
    pages.map((p) =>
      h(
        "button",
        {
          class: "page-btn" + (p.id === active ? " is-active" : ""),
          type: "button",
          "aria-current": p.id === active ? "page" : null,
          onclick: () => onPage(p.id),
          title: p.updatedAt ? `最近入库 ${new Date(p.updatedAt).toLocaleString("zh-CN")}` : "等待入库",
        },
        h("span", { class: "page-btn__name" }, p.label),
        h("span", { class: "page-btn__sub" }, `${hintText(p.hint) || "加载中"}${p.sub ? " · " + p.sub : ""}`)
      )
    )
  );
}
