// 视图投影族：一个页面 = 一组投影；app.js 只按 spec 声明的 projection 查表，不认具体页面。
// 新增一种视图 = 在这里注册一个 {build, update}，其余全由 charts/*.json 驱动。
import { panelView } from "./panel.js";
import { headerView, toolbarView, descView } from "./chrome.js";
import { navView, tilesView } from "./lists.js";
import { tablesView, compositionView } from "./tables.js";

export const PROJECTIONS = {
  panel: panelView,
  header: headerView,
  toolbar: toolbarView,
  desc: descView,
  nav: navView,
  tiles: tilesView,
  tables: tablesView,
  composition: compositionView,
};

export function projectionOf(name) {
  const p = PROJECTIONS[name];
  if (!p) throw new Error(`未注册的视图投影：${name}（合法键：${Object.keys(PROJECTIONS).join(", ")}）`);
  return p;
}
