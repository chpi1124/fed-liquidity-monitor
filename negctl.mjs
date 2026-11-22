// 反向对照：故意污染官方响应，证明交叉验证与纠错真的会触发（本脚本只调用 updateIndicator，不写 data/）
import { loadIndicators, updateIndicator } from "./backend/lib/indicators.js";

const realFetch = globalThis.fetch;
let tamper = null; // (url, json) => json

globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (!tamper) return res;
  const u = String(url);
  if (!tamper.matches(u)) return res;
  const body = await res.text();
  try {
    return new Response(JSON.stringify(tamper.mutate(JSON.parse(body))), {
      status: res.status,
      headers: res.headers,
    });
  } catch {
    return new Response(body, { status: res.status, headers: res.headers });
  }
};

const cfgOf = (id) => loadIndicators().find((c) => c.id === id);
const show = (label, d, want) => {
  const v = d.validation;
  const ic = d.integrity;
  const touched = d.points.filter((p) => p.corrected || p.suspect || p.ok === false).slice(0, 3);
  console.log(
    `\n[${label}] 校验 ${v.matched}/${v.checked} 不符${v.mismatched} 改值${v.corrected} | 自检 ${ic.verdict} 存疑${ic.counts.range + ic.counts.jump + ic.counts.cross + ic.counts.mismatch} 区间${ic.counts.range} 跳变${ic.counts.jump} 交叉${ic.counts.cross}`
  );
  console.log(`  被标记点：${JSON.stringify(touched)}`);
  console.log(`  期望 ${want.pass ? "应触发" : "不应触发"} ⇒ ${want.pass && (v.corrected > 0 || ic.counts.range + ic.counts.jump + ic.counts.cross + ic.counts.mismatch > 0) ? "通过 ✅" : want.pass ? "未触发 ❌" : v.corrected === 0 && ic.verdict === "ok" ? "未误报 ✅" : "误报 ❌"}`);
};

// 对照 1：把某一交易日的 Shibor 3M 改成 9.99%（明显越界）。主源通不过不变量、恒等式参照值通得过 ⇒ 应自动改值并留痕。
{
  const BAD = "2024-06-05";
  tamper = {
    matches: (u) => u.includes("cm-u-bk-shibor/ShiborHis"),
    mutate: (j) => {
      for (const r of j.records ?? []) if (r.showDateCN === BAD) r["3M"] = "9.9900";
      return j;
    },
  };
  const d = await updateIndicator(cfgOf("cn-shibor-spread"), { force: true });
  show(`污染 Shibor 3M @${BAD} ⇒ 恒等式应改值`, d, { pass: true });
  const p = d.points.find((x) => x.d === BAD);
  console.log(`  该点现值 v=${p?.v} corrected=${JSON.stringify(p?.corrected)} suspect=${p?.suspect} ok=${p?.ok}`);
}

// 对照 2：把 GLD 某日收盘价改成 9999（比值越界）。校验为比值型，无法反解出应改为多少
// ⇒ 只应标记存疑、判 fail，绝不擅自改值。
{
  const BAD = "2026-03-03";
  tamper = {
    matches: (u) => u.includes("api.nasdaq.com/api/quote"),
    mutate: (j) => {
      const rows = j?.data?.tradesTable?.rows;
      let hits = 0;
      if (Array.isArray(rows)) for (const r of rows) if (r?.date === "03/03/2026") { r.close = "$9999.00"; hits++; }
      console.log(`  ↳ 注入命中 ${hits} 行（必须 >0，否则本对照只是在测自己的注入是否生效）`);
      return j;
    },
  };
  const d = await updateIndicator(cfgOf("gold"), { force: true });
  show(`污染 GLD 收盘 @${BAD} ⇒ 应存疑但不改值`, d, { pass: true });
  const p = d.points.find((x) => x.d === BAD);
  console.log(`  该点 v=${p?.v} ok=${p?.ok} alt=${p?.alt} suspect=${p?.suspect} corrected=${JSON.stringify(p?.corrected)}`);
  console.log(`  flagged 示例：${JSON.stringify(d.integrity.flagged.slice(0, 2))}`);
}

// 对照 3：干净数据不得误报（阴性对照）
tamper = null;
{
  const d = await updateIndicator(cfgOf("cn-shibor-spread"), { force: true });
  show("无污染 ⇒ 不应有任何存疑/改值", d, { pass: false });
}
