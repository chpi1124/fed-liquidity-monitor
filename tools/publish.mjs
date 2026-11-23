// 规范投影发布器：specs/capability.json 与 specs/gates.md 都由代码派生，人不手写这两份文件。
// 唯一实现处在这里，门禁 G9 拿同一函数重算后与文件比对，因此「忘了重新发布」会直接变红。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wr = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

// provider 能力矩阵：谁能取什么数、多久发布一次、被哪些指标使用
export async function capability() {
  const { list } = await import(pathToFileURL(path.join(ROOT, "backend/providers/registry.js")).href);
  const out = {};
  const indicators = fs
    .readdirSync(path.join(ROOT, "indicators"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "indicators", f), "utf8")));
  for (const p of list()) {
    out[p.id] = {
      org: p.org,
      endpoints: p.endpoints,
      cadence: p.cadence,
      note: p.note || "",
      usedBy: indicators
        .flatMap((c) => (c.legs || []).flatMap((l) => [l.primary, l.check].filter(Boolean)))
        .filter((s) => s.provider === p.id)
        .map((s) => s.id || s.series || s.tenor || s.file || p.id)
        .filter((v, i, a) => a.indexOf(v) === i),
      indicatorCount: indicators.filter((c) => (c.legs || []).some((l) => l.primary?.provider === p.id || l.check?.provider === p.id)).length,
    };
  }
  return out;
}

// 门禁登记表：runner 是唯一事实，md 只是给人读的那一份
export function gatesProjection() {
  const src = fs.readFileSync(path.join(ROOT, "tools/gates.mjs"), "utf8");
  const rows = [...src.matchAll(/gate\("(G\d+)",\s*"([^"]+)",/g)].map((m) => ({ id: m[1], name: m[2] }));
  const lines = [
    "# 门禁登记表（自动生成）",
    "",
    "本文件由 `node tools/publish.mjs` 从 `tools/gates.mjs` 派生，请勿手改：改了会被 G9 判成漂移。",
    "每条门禁都必须可证红（负向对照见 `tools/selftest.mjs`），BLOCKED 状态一律按红处理。",
    "",
    "| 编号 | 判据 | 失败含义 |",
    "| --- | --- | --- |",
  ];
  for (const r of rows) lines.push(`| ${r.id} | ${r.name} | ${WHY[r.id] || "见 tools/gates.mjs 对应实现"} |`);
  lines.push("");
  return lines.join("\n");
}

const WHY = {
  G0: "源码不可解析 / 引入了依赖 / 仓库留下实验残件",
  G1: "指标缺校验腿或缺 checkKind，或汇总行既无校验也无单源声明",
  G2: "阈值没有可复算的来源声明，或实测已越带、带太松/太紧",
  G3: "出现造数字段、无痕改值、绕 WAF 逻辑或未登记的降级源",
  G4: "注入错误值却没被纠错层抓到（需 --net 出网实跑）",
  G5: "取数/图表出口越界，或 tokens.css 之外出现字面色值",
  G6: "对比度不达 WCAG AA、动效超长或存在发光令牌",
  G7: "端到端未经浏览器实测（须 browser-use 留判据）",
  G8: "无 db.js 水位线，增量拉取正确性无从判定",
  G9: "契约文件与代码漂移：schema 违例、能力矩阵过期、门禁未登记",
  G10: "存储断言未落地",
  G11: "仍有按 provider/surface/page 字符串分派的中心开关",
  G12: "变更面清单缺失，或某类资产变更被证明要改主程序",
  G13: "令牌之外出现字面量（hex / 栅格外 px）",
  G14: "同一事实（措辞、换算）出现第二个 owner",
  G15: "内核反向依赖外层（纯函数层 import I/O）",
  G16: "管道五态记录未落地",
  G17: "provider 缺录制响应 fixture，插件无法离线验证",
  G18: "ECharts 实例或 setOption 出现第二个出口",
  G19: "图形层出现同构函数 / 重复对象字面量 / 重复骨架",
  G20: "spec 声明的配方或 tooltip 列与注册表不双向相等",
  G21: "渲染核做算数或写色值，或图形层 hex 超基线",
  G22: "主程序硬编码 spec id / 逐个点名图表容器",
  G23: "tooltip、区间或 slider 构造点出现第二处",
  G24: "快照覆盖不全或内容与基线漂移",
};

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/publish.mjs")) {
  const cap = await capability();
  wr("specs/capability.json", JSON.stringify(cap, null, 2) + "\n");
  wr("specs/gates.md", gatesProjection());
  console.log(`已发布 specs/capability.json（${Object.keys(cap).length} 个 provider）与 specs/gates.md`);
}
