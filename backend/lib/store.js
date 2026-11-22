import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

export function read(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function write(id, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}