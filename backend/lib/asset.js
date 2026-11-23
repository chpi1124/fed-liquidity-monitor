// 资产（sheet/summary）声明「用哪个官方源取数」的唯一读取处。
// lib 层一旦写死 provider 名字，接入第二个市场的报表就得改主程序（本站的「自动发现/完全解耦」正是要堵这个）。
// 因此这里只认配置，不给默认源：缺声明直接拒绝运行，绝不悄悄退回某一家。

// 报错要能指向该补的那一行配置，而不是让人去猜哪段代码在起作用
export function providerOf(cfg, role) {
  const id = cfg.providers && cfg.providers[role];
  if (!id) throw new Error(`${cfg.id}: 配置缺 providers.${role}（lib 层不认领官方源，必须由资产声明）`);
  return id;
}

export function historyStartOf(cfg, what) {
  const s = cfg.historyStart;
  if (!s) throw new Error(`${cfg.id}: 配置缺 historyStart（${what}的起点属于资产口径，不该由代码记死某家报表的起始日）`);
  return s;
}
