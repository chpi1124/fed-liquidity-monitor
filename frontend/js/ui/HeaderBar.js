import { h } from "../core/dom.js";
import { fmtVal } from "../core/derive.js";
import { Badge } from "./Badge.js";
import { Ecg } from "./Ecg.js";

export function HeaderBar({ cfg, latest, zone, validation, integrity, updatedAt, error }) {
  const bad = integrity ? integrity.counts.range + integrity.counts.jump + integrity.counts.cross + integrity.counts.mismatch : 0;
  const soft = integrity ? integrity.counts.stale + integrity.counts.coverage + integrity.counts.gap + integrity.counts.revised : 0;
  const selfCheck =
    integrity === undefined
      ? null
      : integrity === null
      ? Badge({ text: "自检 …" })
      : Badge({
        text:
          integrity.verdict === "ok"
            ? `自检通过${integrity.counts.corrected ? ` · 已改值 ${integrity.counts.corrected}` : ""}`
            : `自检 ${integrity.verdict === "fail" ? "存疑" : "提醒"} ${bad || soft} 项`,
        color: integrity.verdict === "fail" ? "var(--danger)" : integrity.verdict === "warn" ? "var(--warn)" : "var(--ok)",
        title:
          `区间 / 单期跳变 / 断档 / 发布滞后 / 覆盖度 / 交叉带宽 / 官方修订七类不变量逐点自检，与是否存在第二出版方无关。` +
          `存疑点只标记并留痕，不删除、不静默替换；仅在「主源值通不过不变量而校验源值通得过」时才改值，并逐点保留改前值、改后值与依据。` +
          (integrity.notes?.length ? `\n\n${integrity.notes.join("\n")}` : "") +
          (integrity.flagged?.length ? `\n\n示例：\n${integrity.flagged.map((f) => `${f.d ?? "—"} ${f.code}：${f.detail}`).join("\n")}` : ""),
      });
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top__title" },
      h("h1", null, cfg?.name ?? "…"),
      h("span", { class: "top__formula" }, cfg?.formula ? (cfg.formula.includes("=") ? cfg.formula : `= ${cfg.formula}`) : "")
    ),
    Ecg(),
    h(
      "div",
      { class: "top__status" },
      Badge({
        text: latest ? `最新 ${fmtVal(latest.v, cfg)}${cfg.unit}${zone ? " · " + zone.label : ""}` : "…",
        color: zone?.color,
      }),
      Badge({
        text: validation
          ? `交叉验证 ${validation.matched}/${validation.checked} 通过${validation.mismatched ? ` · ${validation.mismatched} 不一致` : ""}`
          : "…",
        color: validation && validation.mismatched ? "var(--danger)" : "var(--ok)",
        title:
          (validation?.kind ? `校验方式：${validation.kind}\n` : "") +
          "主源与校验源逐点比对；校验腿故障时降级为「本期未获并行确认」，不用主源数值冒充双源确认。",
      }),
      selfCheck,
      Badge({
        text: latest ? `数据截至 ${latest.d}` : "…",
        color: cfg?.publication === "T+1" ? "var(--info)" : undefined,
        title:
          cfg?.publication === "T+1"
            ? "官方 T+1 发布：每个工作日的利率于次一工作日美东上午公布，并非数据缺失"
            : "官方源已发布的最新日期",
      }),
      Badge({
        text: error ? error : updatedAt ? `更新 ${new Date(updatedAt).toLocaleString("zh-CN")}` : "…",
      })
    )
  );
}