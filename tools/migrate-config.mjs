// 一次性配置迁移：把「图形呈现属性」从数据配置里剥出来，颜色改引用 token 名。
// 依据 docs/核心数据面板组件规范与守卫.html C-2/C-3/C-9；跑完即可核对计数，不作为常驻脚本。
import fs from "node:fs";
import path from "node:path";

const COLORS = {
  "#3aa6ff": "info",
  "#2fd08c": "ok",
  "#ffb224": "warn",
  "#ff8a2a": "accent",
  "#ff4757": "danger",
  "#35e0a1": "ecg",
  "#e05fd0": "magenta",
  "#ef4444": "risk-1",
  "#e5e7eb": "risk-2",
  "#eab308": "risk-3",
  "#22c55e": "risk-4",
  "#f472b6": "hue-5",
  "#38bdf8": "hue-2",
  "#c084fc": "hue-4",
  "#a78bfa": "hue-3",
  "#6b8ba3": "hue-6",
  "#ff6b5b": "flow-in",
  "#4aa3ff": "flow-out",
};
const RECIPE = { bar: "signedBar", line: "line", "month-line": "line" };
const AXIS_GROUP = { left: "real-rate", right: "gld-share", oz: "gold-oz", flow: "flow-tonnes" };
const AXIS_PRESENTATION = ["axisPos", "axisName", "axisPrefix", "axisSuffix", "barWidth", "area"];

const ref = (v) => COLORS[String(v).toLowerCase()] || v;

function migrate(file, transform) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const next = transform(raw);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return { id: raw.id || path.basename(file), next };
}

let recolors = 0;
function colorize(obj) {
  if (Array.isArray(obj)) return obj.map(colorize);
  if (!obj || typeof obj !== "object") {
    if (typeof obj === "string" && COLORS[obj.toLowerCase()]) {
      recolors++;
      return ref(obj);
    }
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (["hue", "color", "posColor", "negColor"].includes(k) && typeof v === "string" && COLORS[v.toLowerCase()]) {
      recolors++;
      out[k] = ref(v);
    } else out[k] = colorize(v);
  }
  return out;
}

for (const f of fs.readdirSync("indicators")) {
  migrate(path.join("indicators", f), (c) => {
    if (c.render) {
      c.recipe = RECIPE[c.render] || c.render;
      delete c.render;
    }
    if (c.axis) {
      c.axisGroup = AXIS_GROUP[c.axis] || c.axis;
      delete c.axis;
    }
    for (const k of AXIS_PRESENTATION) delete c[k];
    return colorize(c);
  });
}

for (const dir of ["sheets", "summaries"]) {
  for (const f of fs.readdirSync(dir)) {
    migrate(path.join(dir, f), (c) => {
      if (c.groups) for (const g of c.groups) if (g.hue) g.hue = ref(g.hue);
      return colorize(c);
    });
  }
}

console.log(`配置色值改引用 token：${recolors} 处`);
