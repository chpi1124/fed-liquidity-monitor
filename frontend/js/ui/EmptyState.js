import { h } from "../core/dom.js";

export function EmptyState({ text }) {
  return h("div", { class: "empty" }, h("span", { class: "empty__pulse" }), text);
}