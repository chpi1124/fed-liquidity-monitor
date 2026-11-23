import { h } from "../core/dom.js";
import { deltaInfo, fmtVal, validationNote } from "../core/derive.js";
import { css } from "../core/theme.js";
import { Sparkline } from "./Sparkline.js";

export function RateTile({ cfg, status, active, onClick, index }) {
  const latest = status?.latest;
  const tail = status?.tail || [];
  const d = deltaInfo(tail, cfg.unit);
  const ok = latest?.ok;
  const dotColor = css(ok === true ? "ok" : ok === false ? "danger" : "muted");
  const hue = cfg.hue || "accent";
  return h(
    "button",
    {
      class: "tile" + (active ? " is-active" : ""),
      style: { "--hue": css(hue), "animation-delay": `${index * 70}ms` },
      onclick: onClick,
      title: `${cfg.name} · ${validationNote(status)}${cfg.validationNote ? " · " + cfg.validationNote : ""} · 点击查看历史`,
    },
    h(
      "span",
      { class: "tile__top" },
      h("span", { class: "tile__name" }, cfg.name),
      h("i", { class: "tile__dot", style: { background: dotColor, color: dotColor } })
    ),
    cfg.role ? h("span", { class: "tile__role" }, cfg.role) : null,
    h("span", { class: "tile__value" }, latest ? fmtVal(latest.v, cfg) : "—", h("small", null, cfg.unit)),
    h(
      "span",
      { class: "tile__meta" },
      h("span", null, latest ? latest.d : ""),
      d
        ? h(
            "span",
            { class: `tile__delta tile__delta--${d.dir}` },
            `${d.dir === "up" ? "▲" : d.dir === "down" ? "▼" : "•"} ${d.bp}bp`
          )
        : null
    ),
    Sparkline({ values: tail.map((p) => p.v), color: css(hue) }),
    h("span", { class: "tile__en" }, cfg.en || "")
  );
}