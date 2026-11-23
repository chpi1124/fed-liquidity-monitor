// 颜色与图形几何的唯一出口：值全部来自 tokens.css，代码层不写字面色值。
// 浏览器用 getComputedStyle；无头（快照/门禁）用 setSource 注入 tokens.css 解析结果 —— 同一份数值，两种投影。
let source = null;
let memo = null;

function readVar(name) {
  if (source) return source(name);
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 自定义属性里再套 var() 时，计算值不会自动替换，这里做一次展开（仅一层，够用且可预期）。
function resolveName(name, depth = 0) {
  const v = readVar("--" + name);
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  if (m && depth < 3) return resolveName(m[1], depth + 1);
  return v;
}

export function reset() {
  memo = null;
}

export function setSource(fn) {
  source = fn;
  memo = null;
}

export function color(ref) {
  if (!ref) return undefined;
  const name = String(ref).replace(/^var\(--/, "").replace(/\)$/, "");
  const v = resolveName(name);
  // 引用不存在的令牌时不静默回退（否则图上会出现「看不见但没人报警」的线）
  if (!v) throw new Error(`颜色令牌未定义：--${name}（来源 ${ref}）`);
  return v;
}

// canvas 需要 rgba：全站只在这一处做 hex→rgba 合成
export function alpha(ref, a) {
  const c = color(ref);
  if (!c) throw new Error(`alpha 需要颜色令牌，收到 ${String(ref)}`);
  if (c.startsWith("#")) {
    const h = c.slice(1);
    const q = h.length === 3 ? h.split("").map((x) => x + x) : h.match(/../g);
    const [r, g, b] = q.map((x) => parseInt(x, 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  const nums = c.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`颜色令牌不是 hex/rgb：--${ref} → ${c}`);
  return `rgba(${nums[0]},${nums[1]},${nums[2]},${a})`;
}

export function num(name) {
  return parseFloat(resolveName(name)) || 0;
}

export function palette() {
  if (memo) return memo;
  memo = {
    line: color("line"),
    line2: color("line2"),
    ink: color("ink"),
    ink2: color("ink2"),
    muted: color("muted"),
    faint: color("faint"),
    surface: color("surface"),
    surface2: color("surface2"),
    bg1: color("bg1"),
    accent: color("accent"),
    ok: color("ok"),
    warn: color("warn"),
    danger: color("danger"),
    info: color("info"),
    magenta: color("magenta"),
    suspect: color("mark-suspect"),
    corrected: color("mark-corrected"),
    axisInactive: color("axis-inactive"),
    axisOffset: num("chart-axis-offset"),
    grid: {
      left: num("chart-grid-left"),
      right: num("chart-grid-right"),
      top: num("chart-grid-top"),
      bottom: num("chart-grid-bottom"),
    },
    slider: { height: num("chart-slider-height"), bottom: num("chart-slider-bottom") },
    lineWidth: num("chart-line-width"),
    barDay: num("chart-bar-day"),
    barSheet: num("chart-bar-sheet"),
    symbolSize: num("chart-symbol-size"),
    spark: { w: num("spark-w"), h: num("spark-h") },
    hueScale: ["hue-1", "hue-2", "hue-3", "hue-4", "hue-5", "hue-6", "hue-7", "hue-8", "hue-9", "hue-10"].map(color),
  };
  return memo;
}

// 内联 style 用的 CSS 值（DOM 侧唯一出口，与 canvas 的 color() 共用同一张 token 表）
export function css(ref) {
  return ref ? (String(ref).startsWith("var(") ? ref : `var(--${ref})`) : undefined;
}
