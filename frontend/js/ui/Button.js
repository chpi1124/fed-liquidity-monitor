import { h } from "../core/dom.js";

export function Button({ label, variant = "ghost", onClick, disabled = false, title, children }) {
  return h(
    "button",
    { class: `btn btn--${variant}`, onclick: onClick, disabled, title },
    children ?? label
  );
}