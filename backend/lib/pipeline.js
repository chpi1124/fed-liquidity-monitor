// 更新管道的唯一 owner：指标 → 政策事件 → 报表 → 汇总表。
// server.js（调度/API）与 tools/run-update.mjs（命令行）都只是它的调用方，不得各写一份循环。
import { loadIndicators, updateIndicator } from "./indicators.js";
import * as policy from "./policy.js";
import { loadSheets, updateSheet } from "./sheets.js";
import { loadSummaries, updateSummary } from "./summaries.js";
import * as store from "./store.js";
import { fetchWindow } from "./semantics.js";
import { drainUsage } from "../providers/_shared.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

// 自愈四（显式回放）：实取失败但存在已提交的官方导出（本管线此前从官方源实取的产物）⇒
// 回放入库，而不是静默缺数。这不是造数：数据本身来自真实官方取数，且「非本轮实取」
// 会如实写进五态（fetch=degraded + 出处文件与 updatedAt），下一轮水位线恢复后增量追平。
function replayFromExport(cfg, err) {
  const file = path.join(DATA_DIR, `${cfg.id}.json`);
  if (!fs.existsSync(file)) return null;
  let exported;
  try {
    exported = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!exported?.points?.length) return null;
  const provider = cfg.legs?.[0]?.primary?.provider || "";
  const today = new Date().toISOString().slice(0, 10);
  const plan = {
    ...fetchWindow(cfg, provider, today, cfg.start || "2015-01-01"),
    mode: "export-replay",
    reason: `实取失败（${String(err.message).slice(0, 70)}）⇒ 回放已入库导出 data/${cfg.id}.json；下一轮恢复后按水位线增量追平`,
  };
  const out = { ...exported, updatedAt: exported.updatedAt || new Date().toISOString() };
  Object.defineProperty(out, "runMeta", {
    value: {
      cfg,
      plan,
      usage: drainUsage(),
      startedAt: new Date().toISOString(),
      stages: {
        plan: { status: "ok", info: `${plan.mode} ${plan.start}→${plan.end}；${plan.reason}` },
        fetch: { status: "degraded", info: `本轮官方源实取失败；回放已提交导出 data/${cfg.id}.json（updatedAt ${exported.updatedAt}），非本轮实取` },
        validate: { status: "skipped", info: "回放沿用导出时的校验结论，本轮未重新校验" },
        correct: { status: "skipped", info: "回放未做新纠错" },
        commit: { status: "ok", info: `自检沿用导出结论 ${out.integrity?.verdict || "unknown"}` },
      },
      status: "degraded",
    },
    enumerable: false,
  });
  return out;
}

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
        const replayed = replayFromExport(cfg, e);
        if (replayed) {
          store.write(cfg.id, replayed);
          console.log(`[update] ${cfg.id} 导出回放: ${replayed.points.length} days（出处 data/${cfg.id}.json，本轮官方源实取失败，五态已标 degraded）`);
        } else {
          failedOnce.push(cfg);
        }
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
