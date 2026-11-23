import { h, mount } from "../core/dom.js";
import * as ui from "../ui/index.js";
import * as store from "../core/store.js";
import { fmtPoint, publicationLine, validationNote, zoneOf } from "../core/derive.js";

function panelOf(s) {
  return (s.payload?.views || []).find((v) => v.projection === "panel");
}

function anchorLayer(s) {
  const p = panelOf(s);
  return p?.ds?.layers?.find((l) => l.id === p.ds.anchor) || p?.ds?.layers?.[0];
}

function sheetOf(s) {
  return (s.payload?.views || []).find((v) => v.sheet)?.sheet;
}

// 汇总表的行级自检（利率行套同一把不变量、金额行靠双源逐点）在这里聚合成一条徽章数据
function rowCheckOf(s) {
  const items = (s.payload?.views || []).flatMap((v) => v.summaries || []);
  if (!items.some((d) => d.integrity)) return null;
  return items.reduce(
    (a, d) => {
      const i = d.integrity;
      if (!i) return a;
      return {
        verdict: i.verdict === "fail" || a.verdict === "fail" ? "fail" : a.verdict === "warn" || i.verdict === "warn" ? "warn" : "ok",
        rows: a.rows + (i.rows ?? 0),
        selfChecked: a.selfChecked + (i.selfChecked ?? 0),
        unthresholded: a.unthresholded + (i.unthresholded ?? 0),
        bad: a.bad.concat(i.bad ?? []),
      };
    },
    { verdict: "ok", rows: 0, selfChecked: 0, unthresholded: 0, bad: [] }
  );
}

// 页眉模型：有什么数据就说什么话。asOf 型（报表/汇总）与序列型（指标）共用同一组字段。
export function headerModel(s) {
  const layer = anchorLayer(s);
  const sheet = sheetOf(s);
  const summaries = (s.payload?.views || []).flatMap((v) => v.summaries || []);
  const latest = layer?.latest;
  const v = latest?.v ?? latest?.c;
  const agg = summaries.length
    ? summaries.reduce((a, d) => ({ checked: a.checked + (d.validation?.checked || 0), matched: a.matched + (d.validation?.matched || 0), mismatched: a.mismatched + (d.validation?.mismatched || 0) }), { checked: 0, matched: 0, mismatched: 0 })
    : null;
  return {
    title: layer?.name || sheet?.name || summaries[0]?.name || s.payload?.views?.[0]?.title || "…",
    formula: layer?.meta?.formula || summaries[0]?.formula || "",
    unit: layer?.unit || "",
    precision: layer?.precision,
    zone: layer?.meta?.zones ? zoneOf(layer.meta.zones, v) : null,
    latest: v != null ? { v, d: latest.date } : null,
    validation: layer?.validation || sheet?.validation || agg || null,
    integrity: layer?.integrity || null,
    rowCheck: rowCheckOf(s),
    updatedAt: layer?.updatedAt || sheet?.updatedAt || summaries.map((d) => d.updatedAt).sort().pop() || null,
    publication: layer?.meta?.publication,
    asOf: sheet?.asOf || summaries[0]?.asOf || null,
    identities: sheet?.validation?.identities || null,
    error: s.error || panelOf(s)?.ds?.error || null,
  };
}

export const headerView = {
  build: () => ({ root: h("div") }),
  update(built, view, s) {
    mount(
      built.root,
      ui.HeaderBar({
        header: headerModel(s),
        refreshing: s.refreshing,
        onRefresh: store.refresh,
        policyOn: s.policyOn,
        onTogglePolicy: () => store.setPolicyOn(!s.policyOn),
      })
    );
  },
};

export const toolbarView = {
  build: () => ({ root: h("div") }),
  update(built, view, s) {
    const p = panelOf(s);
    const ds = p?.ds;
    const kids = [];
    if (view.granularity) {
      kids.push(
        ui.Segmented({
          label: "时间粒度",
          value: s.granularity,
          onChange: store.setGranularity,
          options: [
            { value: "day", label: "日" },
            { value: "week", label: "周" },
            { value: "month", label: "月" },
          ],
        })
      );
    }
    if (ds?.viewGroups?.length) {
      // 两级互斥视图：顶层选组，组内再选看法。组由 spec 声明，这里只按契约渲染，不认具体页面。
      const active = ds.viewGroups.find((g) => (g.modes || []).includes(ds.view)) || ds.viewGroups[0];
      kids.push(
        ui.Segmented({
          label: "视图",
          value: active.id,
          onChange: (gid) => {
            if (gid === active.id) return;
            const g = ds.viewGroups.find((x) => x.id === gid);
            if (g?.modes?.length) store.setView(g.modes[0]);
          },
          options: ds.viewGroups.map((g) => ({ value: g.id, label: g.label, title: g.title })),
        })
      );
      if (active.modes?.length > 1) {
        kids.push(
          ui.Segmented({
            label: "看法",
            value: ds.view,
            onChange: store.setView,
            options: active.modes
              .map((id) => ds.viewModes.find((m) => m.id === id))
              .filter(Boolean)
              .map((m) => ({ value: m.id, label: m.label, title: m.title })),
          })
        );
      }
    } else if (ds?.viewModes?.length) {
      // 兼容未分组的 spec：保持原来的单层切换
      kids.push(
        ui.Segmented({
          label: "视图",
          value: ds.view,
          onChange: store.setView,
          options: ds.viewModes.map((m) => ({ value: m.id, label: m.label, title: m.title })),
        })
      );
    }
    if (ds?.presets?.length) {
      kids.push(
        ui.Segmented({
          label: "区间定位",
          value: s.preset,
          onChange: store.setPreset,
          options: ds.presets.map((x) => ({ value: x.id, label: x.label, title: x.title })),
        })
      );
    }
    kids.push(ui.Button({ label: s.refreshing ? "更新中…" : "刷新数据", variant: "solid", onClick: store.refresh, disabled: s.refreshing }));
    if (view.overlay && ds?.availableOverlays?.length) {
      kids.push(ui.OverlayPicker({ options: ds.availableOverlays, selected: ds.overlayIds || [], onToggle: store.toggleOverlay, limits: ds.limits }));
    }
    if (view.toggles && ds?.layers?.length) {
      kids.push(ui.SeriesToggles({ layers: ds.layers, selected: s.selected[p.specId] || {}, onToggle: (id) => store.toggleLayer(p.specId, id) }));
    }
    if (anchorLayer(s)?.meta?.zones) kids.push(ui.Legend({ zones: anchorLayer(s).meta.zones, unit: anchorLayer(s).unit }));
    if (view.eras && s.payload?.views?.find((v) => v.sheet)?.sheet?.cfg?.eras) {
      kids.push(ui.EraChips({ eras: sheetOf(s).cfg.eras }));
    }
    mount(built.root, ui.Toolbar({ children: kids, identities: headerModel(s).identities }));
  },
};

// 一句话摘要：既是页面说明，也是每张图的 aria-label 文本来源（同一处生成，两处读同一份）
export function descText(s) {
  const p = panelOf(s);
  const ds = p?.ds;
  const summaries = (s.payload?.views || []).flatMap((v) => v.summaries || []);
  if (!ds || ds.error)
    return summaries.length ? summaries.map((d) => d.cfg?.description).filter(Boolean).join(" ") : p?.empty || s.error || "等待数据…";
  const brief = (ds.layers || [])
    .filter((l) => !l.error)
    .map((l) => `${l.name} ${fmtPoint(l, l.latest?.v ?? l.latest?.c)}（${validationNote(l)}）`)
    .join("　·　");
  const anchor = anchorLayer(s);
  const pub = anchor ? publicationLine({ publication: anchor.meta?.publication }, anchor.latest?.date) : "";
  const monthly = (ds.layers || []).filter((l) => l.meta?.freq === "month" && l.latest?.date);
  const lag = monthly.length
    ? ` ${monthly.map((l) => `${l.name}为月度官方申报序列，最新观测至 ${l.latest.date.slice(0, 7)}；窗口内没有它的观测点属官方尚未发布而非缺数。`).join("")}`
    : "";
  const sheet = sheetOf(s);
  const sheetNote = sheet ? ` 本期为 ${sheet.asOf}（周三）水平，环比对照 ${sheet.prevDate}，同比对照 ${sheet.yearAgoDate}；H.4.1 每周四发布。` : "";
  const overlays = (ds.layers || []).length > 1 ? ` 当前叠加 ${ds.layers.length} 条序列（同轴 ${ds.limits?.sharedMax || 0} 条内为直接比较，异轴只用于看相关性）。` : "";
  return [brief ? `${brief}。` : "", anchor?.meta?.description || "", pub, sheetNote, lag, overlays, (ds.layers || []).map((l) => l.meta?.description).filter(Boolean).join(" ")].filter(Boolean).join(" ");
}

export const descView = {
  build: () => ({ root: h("p", { class: "desc" }) }),
  update(built, view, s) {
    built.root.textContent = descText(s);
  },
};
