const BASE = location.protocol === "file:" ? "http://localhost:3000" : "";

async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export const getIndicators = (region) => req(`/api/indicators?region=${region}`);
export const getSeries = (id, g) => req(`/api/indicators/${id}?granularity=${g}`);
export const getSheets = (region) => req(`/api/sheets?region=${region}`);
export const getSheet = (id) => req(`/api/sheets/${id}`);
export const getSummaries = (region) => req(`/api/summaries?region=${region}`);
export const getSummary = (id) => req(`/api/summaries/${id}`);
export const refresh = () => req("/api/refresh", { method: "POST" });