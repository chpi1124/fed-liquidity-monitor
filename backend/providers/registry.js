// provider 注册表：目录即清单（自动发现）。新增一个官方源 = 往本目录放一个文件，
// 主程序（cache/indicators/sheets/summaries）与这里都不需要改一行。
// 契约：每个 provider 文件默认导出 { id, org, endpoints, cadence, fetch(src,start,end) }，
// 且 id 必须等于文件名 —— 名字与身份不一致时直接拒绝启动，不允许「文件在但没生效」。
import fs from "node:fs";
import { STRATEGIES } from "../lib/db.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const providers = new Map();

for (const f of fs.readdirSync(DIR).sort()) {
  if (!f.endsWith(".js") || f.startsWith("_") || f === "registry.js") continue;
  const mod = await import(pathToFileURL(path.join(DIR, f)).href);
  const p = mod.default;
  const id = f.slice(0, -3);
  if (!p || typeof p.fetch !== "function") throw new Error(`provider ${id} 必须默认导出 { id, fetch }`);
  if (p.id !== id) throw new Error(`provider ${id} 的导出 id=${p.id} 与文件名不一致`);
  if (!p.org || !p.endpoints || !p.cadence) throw new Error(`provider ${id} 必须声明 org / endpoints / cadence（能力矩阵的唯一出处）`);
  if (!STRATEGIES.includes(p.incremental)) throw new Error(`provider ${id} 必须声明 incremental 策略（可选：${STRATEGIES.join("/")}）；探测未定论的源不得放宽为 tail`);
  if (p.incremental !== "tail" && !p.windowNote) throw new Error(`provider ${id} 非 tail 策略必须写 windowNote 说明原因`);
  if (providers.has(id)) throw new Error(`provider id 重复：${id}`);
  providers.set(id, p);
}

export function list() {
  return [...providers.values()];
}

export function strategyOf(id) {
  const p = providers.get(id);
  return p ? { strategy: p.incremental, note: p.windowNote || "", cadence: p.cadence } : null;
}

export function has(id) {
  return providers.has(id);
}

export async function fetchSeries(src, start, end) {
  const p = providers.get(src.provider);
  if (!p) throw new Error(`unknown provider: ${src.provider}（已注册：${[...providers.keys()].join(", ")}）`);
  return p.fetch(src, start, end);
}
