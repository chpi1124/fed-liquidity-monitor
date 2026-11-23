const BASE = location.protocol === "file:" ? "http://localhost:3000" : "";

async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// 前端唯一的出网点：页面与图形一律「一页一次请求」，不再逐指标并发取数。
export const getCharts = (region) => req(`/api/charts?region=${encodeURIComponent(region)}`);
export const getPage = (page, params) => req(`/api/page/${encodeURIComponent(page)}?${params}`);
export const refresh = () => req("/api/refresh", { method: "POST" });
