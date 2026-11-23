import { h } from "../core/dom.js";
import { fmtVal, validationNote } from "../core/derive.js";
import { css } from "../core/theme.js";
import { Badge } from "./Badge.js";
import { Ecg } from "./Ecg.js";

// 页眉徽章的唯一生成处：有什么数据就说什么话，缺数据不编（单源、校验腿故障都直说）。
function badges(hdr, { refreshing }) {
  const out = [];
  if (hdr.latest) {
    out.push(
      Badge({
        text: `最新 ${fmtVal(hdr.latest.v, hdr)}${hdr.unit || ""}${hdr.zone ? " · " + hdr.zone.label : ""}`,
        color: css(hdr.zone?.color),
      })
    );
  }
  if (hdr.validation) {
    out.push(
      Badge({
        text: validationNote({ validation: hdr.validation }),
        color: hdr.validation.mismatched ? css("danger") : css("ok"),
        title:
          (hdr.validation.kind ? `校验方式：${hdr.validation.kind}\n` : "") +
          "主源与校验源逐点比对；校验腿故障时降级为「本期未获并行确认」，不用主源数值冒充双源确认。",
      })
    );
  }
  if (hdr.integrity) {
    const ic = hdr.integrity.counts || hdr.integrity;
    const bad = (ic.range || 0) + (ic.jump || 0) + (ic.cross || 0) + (ic.mismatch || 0);
    const soft = (ic.stale || 0) + (ic.coverage || 0) + (ic.gap || 0) + (ic.revised || 0);
    out.push(
      Badge({
        text:
          hdr.integrity.verdict === "ok"
            ? `自检通过${ic.corrected ? ` · 已改值 ${ic.corrected}` : ""}`
            : `自检 ${hdr.integrity.verdict === "fail" ? "存疑" : "提醒"} ${bad || soft} 项`,
        color: hdr.integrity.verdict === "fail" ? css("danger") : hdr.integrity.verdict === "warn" ? css("warn") : css("ok"),
        title:
          "区间 / 单期跳变 / 断档 / 发布滞后 / 覆盖度 / 交叉带宽 / 官方修订七类不变量逐点自检，与是否存在第二出版方无关。" +
          "存疑点只标记并留痕，不删除、不静默替换；仅在「主源值通不过不变量而校验源值通得过」时才改值，并逐点保留改前值、改后值与依据。" +
          ((hdr.integrity.notes || []).length ? `\n\n${hdr.integrity.notes.join("\n")}` : "") +
          ((hdr.integrity.flagged || []).length
            ? `\n\n示例：\n${hdr.integrity.flagged.map((f) => `${f.d ?? "—"} ${f.code}：${f.detail}`).join("\n")}`
            : ""),
      })
    );
  }
  if (hdr.rowCheck) {
    const rc = hdr.rowCheck;
    out.push(
      Badge({
        text:
          rc.verdict === "ok"
            ? `行级自检通过 ${rc.selfChecked}/${rc.rows}${rc.unthresholded ? ` · 金额行 ${rc.unthresholded} 走双源` : ""}`
            : `行级自检存疑 ${rc.bad.length} 行`,
        color: rc.verdict === "fail" ? css("danger") : css("ok"),
        title:
          "利率型行（%、bp）的本期值要过与指标同一套不变量（合理区间、单周跳变，阈值由十年实测分布定标）；" +
          "金额型行的量级取决于单位与财政收支节奏，未经逐行定标不套通用带，其正确性由 H.4.1 ↔ FRED 双源逐点比对负责。" +
          "存疑只标记说明，不删行、不改值。" +
          (rc.bad.length ? `\n\n${rc.bad.map((b) => `${b.zh}：${b.codes.join("；")}`).join("\n")}` : ""),
      })
    );
  }
  if (hdr.asOf) out.push(Badge({ text: `数据截至 ${hdr.asOf}`, title: hdr.asOfNote || "官方报表期次（每周四发布，数值截至上一周三）" }));
  else if (hdr.latest)
    out.push(
      Badge({
        text: `数据截至 ${hdr.latest.d}`,
        color: hdr.publication === "T+1" ? css("info") : undefined,
        title:
          hdr.publication === "T+1"
            ? "官方 T+1 发布：每个工作日的利率于次一工作日美东上午公布，并非数据缺失"
            : "官方源已发布的最新日期",
      })
    );
  out.push(
    Badge({
      text: hdr.error ? hdr.error : refreshing ? "更新中…" : hdr.updatedAt ? `更新 ${new Date(hdr.updatedAt).toLocaleString("zh-CN")}` : "…",
    })
  );
  return out;
}

export function HeaderBar({ header, refreshing, policyOn = true, onTogglePolicy }) {
  const hdr = header || {};
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top__title" },
      h("h1", null, hdr.title ?? "…"),
      h("span", { class: "top__formula" }, hdr.formula ? (hdr.formula.includes("=") ? hdr.formula : `= ${hdr.formula}`) : "")
    ),
    Ecg(),
    h("div", { class: "top__status" },
      h(
        "button",
        {
          class: "seg__btn",
          type: "button",
          role: "switch",
          "aria-checked": policyOn ? "true" : "false",
          onclick: onTogglePolicy,
          title: "全局开关：控制所有面板的政策事件竖线与悬停文字（加息/降息/按兵不动/缩表/扩表）。",
        },
        `政策事件 ${policyOn ? "开" : "关"}`
      ),
      badges(hdr, { refreshing })
    )
  );
}
