import fs from "node:fs";

const strip = (s) =>
  s
    .replace(/<br\s*\/?>/g, " ⏎ ")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "·")
    .replace(/\s+/g, " ")
    .trim();

const files = ["架构规范与门禁-执行计划.html", "后端与数据库架构规范.html", "架构原则与机检CI.html", "核心数据面板组件规范与守卫.html"];
for (const f of files) {
  const h = fs.readFileSync("docs/" + f, "utf8");
  console.log("\n########## " + f);
  for (const tr of h.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = strip(tr[1]);
    if (/\bG\d{1,2}\b/.test(row.slice(0, 20))) console.log(row);
  }
}
