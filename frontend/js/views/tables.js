import { h } from "../core/dom.js";
import * as ui from "../ui/index.js";
import { compositionSegments } from "../core/derive.js";

export const tablesView = {
  build: (view) => ({ root: h("div", { id: view.container }) }),
  update(built, view) {
    if (view.summaries?.length) {
      built.root.replaceChildren(ui.SummaryTables({ items: view.summaries }));
      return;
    }
    if (view.sheet) {
      built.root.replaceChildren(
        ui.BalanceTables({ groups: view.sheet.groups, asOf: view.sheet.asOf, prevDate: view.sheet.prevDate, yearAgoDate: view.sheet.yearAgoDate })
      );
      return;
    }
    built.root.replaceChildren(ui.EmptyState({ text: view.empty || "等待数据…" }));
  },
};

export const compositionView = {
  build: (view) => ({ root: h("div", { id: view.container }) }),
  update(built, view) {
    const sheet = view.sheet;
    if (!sheet?.groups) {
      built.root.replaceChildren();
      return;
    }
    built.root.replaceChildren(ui.CompositionBar({ segments: compositionSegments(sheet), total: sheet.total }));
  },
};
