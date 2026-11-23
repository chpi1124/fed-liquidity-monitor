// provider 由目录自动发现（backend/providers/registry.js）：接入新官方源不改本文件，也不改主程序
import { fetchSeries } from "../providers/registry.js";

const TTL = 10 * 60 * 1000;
const cache = new Map();

export async function getSeries(src, start, end, force = false) {
  const key = JSON.stringify([src, start, end]);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.t < TTL) return hit.m;
  const m = await fetchSeries(src, start, end);
  cache.set(key, { t: Date.now(), m });
  return m;
}