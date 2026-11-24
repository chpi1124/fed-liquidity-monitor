// 每日调度：每天固定两轮拉数——中午 12 点与午夜 0 点（本机时区）。
// 一轮 = 走水位线增量取数（与页面「更新」按钮同一条路径），不是全量重建。
// 「必须两次」的实现口径：
//   · 槽位 = 日期 + 槽点（0 / 12）；30 分钟一次的 tick 里，只有落在槽位小时才触发；
//   · 槽位成功（updateAll 正常返回）才记账，失败在槽位小时内下一 tick 自动重试；
//   · 错过槽位（服务当时没开）由启动时的一次强制 tick 补上，当天数据不会悬空。
export function prevBusinessDay(d) {
  const x = new Date(d);
  do {
    x.setDate(x.getDate() - 1);
  } while (x.getDay() === 0 || x.getDay() === 6);
  return x;
}

export const SLOTS = [0, 12];

export function scheduleDecision(now, doneSlots) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const h = now.getHours();
  const key = `${today}-${h}`;
  return { run: SLOTS.includes(h) && !doneSlots.has(key), key, today };
}

export function startScheduler(updateAll, intervalMs = 30 * 60 * 1000) {
  const doneSlots = new Set();
  async function tick(force) {
    const { run, key } = scheduleDecision(new Date(), doneSlots);
    if (!force && !run) return;
    try {
      await updateAll();
      // 只有整轮成功才记账：失败留在槽位小时内重试，绝不静默吞掉一轮
      if (key) doneSlots.add(key);
    } catch (e) {
      console.error("[scheduler] update failed:", e.message);
    }
  }
  // 启动即拉一轮：补上服务未开时错过的槽位（不计入槽位账，槽位照常触发）
  tick(true);
  setInterval(() => tick(false), intervalMs);
}
