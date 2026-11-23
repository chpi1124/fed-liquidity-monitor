// 更新管道的唯一 owner：指标 → 政策事件 → 报表 → 汇总表。
// server.js（调度/API）与 tools/run-update.mjs（命令行）都只是它的调用方，不得各写一份循环。
import { loadIndicators, updateIndicator } from "./indicators.js";
import * as policy from "./policy.js";
import { loadSheets, updateSheet } from "./sheets.js";
import { loadSummaries, updateSummary } from "./summaries.js";
import * as store from "./store.js";

let updating = false;

export function isUpdating() {
  return updating;
}

// force=false：按水位线增量取数（每日调度与页面「更新」按钮走这条）
// only：按资产 id 收窄本轮，调试单个指标时不必重跑全站；"policy" 是政策事件的伪 id
export async function updateAll(force = false, { only } = {}) {
  if (updating) return "";
  updating = true;
  const pick = (id) => !only || !only.length || only.includes(id);
  let minLatest = "";
  try {
    const pending = loadIndicators().filter((cfg) => pick(cfg.id));
    const rerun = [];
    const failedOnce = [];
    for (const cfg of pending) {
      try {
        let data = await updateIndicator(cfg, { force, prev: store.read(cfg.id) });
        // 自愈一：参照序列本轮还没入库（冷启动依赖顺序）⇒ 补跑一次，不静默降级。
        if (data.validation.checkErrors.some((e) => /尚未入库|无重叠日期/.test(e))) {
          rerun.push(cfg);
        }
        // 自愈二：自检 fail ⇒ 绕过缓存向官方源重取一次，区分「源端真异常」与「缓存/半途响应」。
        if (data.integrity.verdict === "fail") {
          console.log(`[update] ${cfg.id}: 自检 fail，绕过缓存重取一次`);
          const retry = await updateIndicator(cfg, { force: true, prev: store.read(cfg.id) });
          if (retry.integrity.counts.range + retry.integrity.counts.jump + retry.integrity.counts.mismatch <=
              data.integrity.counts.range + data.integrity.counts.jump + data.integrity.counts.mismatch) data = retry;
        }
        store.write(cfg.id, data);
        const ld = data.points[data.points.length - 1]?.d ?? "";
        if ((cfg.region || "us") === "us" && ld && (!minLatest || ld < minLatest)) minLatest = ld;
        const ic = data.integrity;
        const v = data.validation;
        const bad = ic.counts.range + ic.counts.jump + ic.counts.cross + ic.counts.mismatch;
        console.log(
          `[update] ${cfg.id}: ${data.points.length} days, 交叉验证 ${v.matched}/${v.checked}${v.corrected ? ` 改值${v.corrected}` : ""}${v.mismatched ? ` 不符${v.mismatched}` : ""}${v.checkErrors.length ? ` 校验腿故障${v.checkErrors.length}` : ""}, 自检 ${ic.verdict}${bad ? ` 存疑${bad}` : ""}${ic.counts.stale ? ` 滞后${ic.counts.stale}` : ""}${ic.counts.revised ? ` 修订${ic.counts.revised}` : ""}${ic.counts.coverage ? ` 覆盖${ic.counts.coverage}` : ""}`
        );
      } catch (e) {
        console.error(`[update] ${cfg.id} failed:`, e.message);
        // 自愈三：瞬时取数异常（源端限流/机房 IP 被限/网络抖动）⇒ 本轮末尾再补跑一次。
        // 不带 force：水位线仍在，只重取缺失窗口，不会反复全量拉。
        failedOnce.push(cfg);
      }
    }
    // 依赖补跑：恒等式/带宽校验腿读取的是同批其他指标的入库结果，冷启动时第二轮才能对上。
    for (const cfg of rerun) {
      try {
        const data = await updateIndicator(cfg, { force, prev: store.read(cfg.id) });
        if (!data.validation.checkErrors.length) store.write(cfg.id, data);
        const v = data.validation;
        console.log(`[update] ${cfg.id} 依赖补跑: 交叉验证 ${v.matched}/${v.checked}, 自检 ${data.integrity.verdict}${v.checkErrors.length ? ` 仍有校验腿故障: ${v.checkErrors.join("; ")}` : ""}`);
      } catch (e) {
        console.error(`[update] ${cfg.id} 依赖补跑 failed:`, e.message);
      }
    }
    // 失败补跑：整轮跑完再给失败者一次机会（距离首次失败已有几分钟，瞬时限流多半已解除）
    for (const cfg of failedOnce) {
      try {
        const data = await updateIndicator(cfg, { force: false, prev: store.read(cfg.id) });
        store.write(cfg.id, data);
        const v = data.validation;
        console.log(`[update] ${cfg.id} 失败补跑: ${data.points.length} days, 交叉验证 ${v.matched}/${v.checked}, 自检 ${data.integrity.verdict}`);
      } catch (e) {
        console.error(`[update] ${cfg.id} 失败补跑 failed:`, e.message);
      }
    }
    // 政策事件按 regions.json 登记的源逐市场刷新（没登记源的市场不会被打扰，也不会静默产出空事件）
    if (!only || only.includes("policy")) {
      for (const region of policy.sourceRegions()) {
        try {
          const pr = await policy.refresh(region, { force: false });
          console.log(`[policy] ${region} 政策事件：本轮新增 ${pr.added} 条，库内共 ${pr.total} 条${pr.skipped.length ? `（${pr.skipped.length} 条未解析或取回失败）` : ""}`);
        } catch (e) {
          console.error(`[policy] ${region} 事件刷新失败（保留库内既有事件，不清空）:`, e.message);
        }
      }
    }
    for (const cfg of loadSheets().filter((c) => pick(c.id))) {
      try {
        const data = await updateSheet(cfg, { force });
        store.write(`sheet-${cfg.id}`, data);
        console.log(`[sheet] ${cfg.id}: asOf ${data.asOf}, ${data.history.length} weeks, validation ${data.validation.matched}/${data.validation.checked}`);
      } catch (e) {
        console.error(`[sheet] ${cfg.id} failed:`, e.message);
      }
    }
    for (const cfg of loadSummaries().filter((c) => pick(c.id))) {
      try {
        const data = await updateSummary(cfg, { force });
        store.write(`summary-${cfg.id}`, data);
        console.log(`[summary] ${cfg.id}: asOf ${data.asOf}, ${data.rows.length} rows, validation ${data.validation.matched}/${data.validation.checked}`);
      } catch (e) {
        console.error(`[summary] ${cfg.id} failed:`, e.message);
      }
    }
  } finally {
    updating = false;
  }
  return minLatest;
}
