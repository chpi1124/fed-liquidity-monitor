// 配方元数据的唯一出处：图例注记与该形态下「缺官方观测」该怎么读，与配方键同一张表。
// 独立成文件（不 import 任何东西）是为了让 chart-types 与 chart-option 共用而不产生循环依赖。
export const RECIPE_META = {
  line: { tag: "", lag: "折线为观测月之间的连线" },
  zoneBar: { tag: "柱", lag: "柱只落在每月首日" },
  eraBar: { tag: "柱", lag: "柱只落在每个观测周" },
  signedBar: { tag: "柱", lag: "柱只落在每月首日" },
  candlestick: { tag: "K线", lag: "" },
};

// 图例与开关标签：序列名 + 形态/频率/轴方向注记，前端只在这一处拼。
export function layerLabel(layer) {
  const tags = [];
  if (layer.inverse) tags.push("轴反向");
  if (layer.freq === "month") tags.push("月度");
  const tag = RECIPE_META[layer.recipe]?.tag;
  if (tag) tags.push(tag);
  return layer.name + (tags.length ? `（${tags.join("·")}）` : "");
}
