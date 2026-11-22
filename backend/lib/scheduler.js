export function prevBusinessDay(d) {
  const x = new Date(d);
  do {
    x.setDate(x.getDate() - 1);
  } while (x.getDay() === 0 || x.getDay() === 6);
  return x;
}

export function scheduleDecision(et, doneDay, latest) {
  const today = et.toDateString();
  const target = prevBusinessDay(et).toISOString().slice(0, 10);
  const h = et.getHours();
  const retryWindow = h >= 9 && h < 13;
  const run = h >= 9 && (doneDay !== today || (retryWindow && latest < target));
  return { run, today, target };
}

export function startScheduler(updateAll, intervalMs = 30 * 60 * 1000) {
  let doneDay = "";
  let latest = "";
  const etNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  async function tick(force) {
    const et = etNow();
    const { run, today, target } = scheduleDecision(et, doneDay, latest);
    if (!force && !run) return;
    try {
      const l = await updateAll();
      if (l) latest = l;
      // 官方 T+1 发布可能晚于 9 点首 tick：数据未到位则在 9–13 点窗口内每 30 分钟重试
      if (latest >= target || et.getHours() >= 13) doneDay = today;
    } catch (e) {
      console.error("[scheduler] update failed:", e.message);
    }
  }
  tick(true);
  setInterval(() => tick(false), intervalMs);
}