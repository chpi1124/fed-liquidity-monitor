// 契约校验器（零依赖）：实现 JSON Schema 的一个明确子集，够用且可预期。
// 支持：type（含类型数组）、required、properties、items、definitions+$ref、enum、pattern、
// minimum/maximum、minItems/maxItems。不支持组合关键字——若契约需要组合语义，请改代码而不是悄悄放宽校验。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadSchema(rel = "specs/indicator.schema.json") {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

const TYPES = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

function resolve(node, schema) {
  if (!node || !node.$ref) return node;
  const parts = node.$ref.replace(/^#\//, "").split("/");
  let cur = schema;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) throw new Error(`schema $ref 指向不存在的路径：${node.$ref}`);
  }
  return cur;
}

export function validate(value, schema, node = schema, at = "$") {
  const errs = [];
  node = resolve(node, schema);
  if (!node) return [`路径 ${at} 在 schema 里找不到定义`];
  const push = (m) => errs.push(`${at}: ${m}`);

  if (node.type) {
    const list = Array.isArray(node.type) ? node.type : [node.type];
    if (!list.some((t) => (TYPES[t] || (() => false))(value))) {
      push(`类型应为 ${list.join("|")}，实际 ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
      return errs;
    }
  }
  if (node.enum && !node.enum.includes(value)) push(`取值须属于 ${JSON.stringify(node.enum)}`);
  if (typeof value === "string" && node.pattern && !new RegExp(node.pattern).test(value)) push(`不匹配 pattern ${node.pattern}`);
  if (typeof value === "number") {
    if (node.minimum != null && value < node.minimum) push(`小于 minimum ${node.minimum}`);
    if (node.maximum != null && value > node.maximum) push(`大于 maximum ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems != null && value.length < node.minItems) push(`元素数 ${value.length} < minItems ${node.minItems}`);
    if (node.maxItems != null && value.length > node.maxItems) push(`元素数 ${value.length} > maxItems ${node.maxItems}`);
    if (node.items) value.forEach((v, i) => errs.push(...validate(v, schema, node.items, `${at}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const k of node.required || []) {
      if (!(k in value)) push(`缺必填字段 ${k}${node[k]?.description ? `（${node[k].description}）` : ""}`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (node.properties?.[k]) errs.push(...validate(v, schema, node.properties[k], `${at}.${k}`));
    }
  }
  return errs;
}

// 供门禁与跑批共用：一次校验一批配置文件，返回「文件 → 违例清单」
export function validateDir(dir, schema, relFilter) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [{ file: dir, errors: ["目录不存在"] }];
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith(".json") && (!relFilter || relFilter.test(x)))) {
    const errors = validate(JSON.parse(fs.readFileSync(path.join(abs, f), "utf8")), schema);
    if (errors.length) out.push({ file: `${dir}/${f}`, errors });
  }
  return out;
}
