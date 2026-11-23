import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
export const INDICATORS_DIR = path.join(ROOT, "indicators");
export const SHEETS_DIR = path.join(ROOT, "sheets");
export const SUMMARIES_DIR = path.join(ROOT, "summaries");
export const CHARTS_DIR = path.join(ROOT, "charts");
export const SPECS_DIR = path.join(ROOT, "specs");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");
export const SNAPSHOTS_DIR = path.join(ROOT, "snapshots");
export const FRONTEND_DIR = path.join(ROOT, "frontend");