import { h } from "../core/dom.js";

export function Badge({ text, color, title }) {
  const style = color
    ? { color, borderColor: color.startsWith("#") ? `${color}66` : color }
    : null;
  return h("span", { class: "badge", style, title }, text);
}