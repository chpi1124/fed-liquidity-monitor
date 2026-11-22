import * as store from "./core/store.js";
import * as ui from "./ui/index.js";
import * as chart from "./chart.js";
import { compositionSegments, fmtPoint, publicationLine, seriesLabel, zoneOf, PRESETS } from "./core/derive.js";
import { mount, h } from "./core/dom.js";

const $ = (id) => document.getElementById(id);
chart.mount($("chart"));
chart.mountSheet($("bh-chart"));
chart.mountGold($("gold-chart"));
chart.onGoldLegend((sel) => store.setGoldSelection(sel));

let prev = {};

function renderMonitor(s) {
  const cfg = s.indicators.find((i) => i.id === s.activeId);
  const sidebarInds = s.indicators.filter((i) => i.surface !== "strip" && i.surface !== "gold");
  const stripInds = s.indicators.filter((i) => i.surface === "strip");

  const navKey = `${s.indicators.length}|${s.activeId}|${s.indicators === prev.indicatorsRef ? 1 : 0}`;
  if (prev.navKey !== navKey || prev.indicatorsRef !== s.indicators) {
    mount($("indicator-nav"), ui.Sidebar({ indicators: sidebarInds, activeId: s.activeId, onSelect: store.select }));
    mount(
      $("strip"),
      stripInds.map((c, i) =>
        ui.RateTile({ cfg: c, status: c.status, active: c.id === s.activeId, onClick: () => store.select(c.id), index: i })
      )
    );
  }
  prev.navKey = navKey;
  prev.indicatorsRef = s.indicators;

  if (cfg) {
    const latest = s.series?.points?.[s.series.points.length - 1];
    const lv = s.granularity === "day" ? latest?.v : latest?.c;
    const zone = zoneOf(cfg.zones, lv);
    const headerKey = [s.activeId, lv, s.series?.updatedAt, s.series?.validation?.matched, s.series?.validation?.mismatched, s.series?.integrity?.verdict, s.series?.integrity?.counts?.corrected, s.error, s.granularity].join("|");
    if (prev.headerKey !== headerKey) {
      mount(
        $("header"),
        ui.HeaderBar({
          cfg,
          latest: lv != null ? { v: lv, d: latest.date } : null,
          zone,
          validation: s.series?.validation,
          integrity: s.series?.integrity,
          updatedAt: s.series?.updatedAt,
          error: s.error,
        })
      );
      prev.headerKey = headerKey;
    }
    const toolbarKey = [s.granularity, s.preset, s.refreshing, s.activeId].join("|");
    if (prev.toolbarKey !== toolbarKey) {
      mount(
        $("toolbar"),
        ui.Toolbar({
          granularity: s.granularity,
          onGranularity: store.setGranularity,
          preset: s.preset,
          onPreset: store.setPreset,
          onRefresh: store.refresh,
          refreshing: s.refreshing,
          zones: cfg.zones,
          unit: cfg.unit,
        })
      );
      prev.toolbarKey = toolbarKey;
    }
    const descKey = `${s.activeId}|${latest?.date ?? ""}`;
    if (prev.descKey !== descKey) {
      $("desc").textContent = [cfg.description, publicationLine(cfg, latest?.date)].filter(Boolean).join(" ");
      prev.descKey = descKey;
    }
  }

  const chartKey = [s.series?.updatedAt ?? "", s.series?.points?.length ?? 0, s.granularity, s.activeId].join("|");
  if (prev.chartKey !== chartKey) {
    if (s.series && cfg) {
      $("chart-empty").hidden = true;
      chart.render({ cfg, points: s.series.points, granularity: s.granularity, preset: s.preset });
    } else if (s.loading) {
      $("chart-empty").hidden = false;
      mount($("chart-empty"), ui.EmptyState({ text: "加载数据中…" }));
    } else if (s.error) {
      $("chart-empty").hidden = false;
      mount($("chart-empty"), ui.EmptyState({ text: s.error }));
    }
    prev.chartKey = chartKey;
  }
  if (prev.preset !== s.preset && s.series) {
    chart.applyZoom({ points: s.series.points, preset: s.preset });
  }
  prev.preset = s.preset;
}

function renderBalance(s) {
  const cfg = s.sheets.find((x) => x.id === s.sheetId);
  const d = s.sheet && s.sheet.id === s.sheetId ? s.sheet : null;

  const headerKey = [s.sheetId, d?.updatedAt ?? "", d?.total ?? "", s.sheetError ?? ""].join("|");
  if (prev.bhHeaderKey !== headerKey) {
    mount(
      $("bh-header"),
      ui.HeaderBar({
        cfg,
        latest: d ? { v: d.total / 1e6, d: d.asOf } : null,
        validation: d?.validation,
        updatedAt: d?.updatedAt,
        error: s.sheetError,
      })
    );
    prev.bhHeaderKey = headerKey;
  }

  const toolbarKey = [s.sheetId, s.sheetPreset, s.refreshing, d?.validation?.matched ?? ""].join("|");
  if (prev.bhToolbarKey !== toolbarKey) {
    mount(
      $("bh-toolbar"),
      ui.SheetToolbar({
        preset: s.sheetPreset,
        onPreset: store.setSheetPreset,
        onRefresh: store.refresh,
        refreshing: s.refreshing,
        validation: d?.validation,
        eras: cfg?.eras,
      })
    );
    prev.bhToolbarKey = toolbarKey;
  }

  const dataKey = [s.sheetId, d?.updatedAt ?? "", d?.asOf ?? ""].join("|");
  if (prev.bhDataKey !== dataKey) {
    if (d && cfg) {
      mount($("bh-comp"), ui.CompositionBar({ segments: compositionSegments(d), total: d.total }));
      mount($("bh-tables"), ui.BalanceTables({ groups: d.groups, asOf: d.asOf, prevDate: d.prevDate, yearAgoDate: d.yearAgoDate }));
      $("bh-desc").textContent = [
        cfg.description,
        `本期为 ${d.asOf}（周三）水平，环比对照 ${d.prevDate}，同比对照 ${d.yearAgoDate}；H.4.1 每周四发布，下一期数据截至 ${d.asOf} 后一周的周三。`,
        cfg.validationNote,
      ].filter(Boolean).join(" ");
    } else {
      mount($("bh-comp"));
      mount($("bh-tables"), ui.EmptyState({ text: s.sheetLoading ? "资产负债表数据加载中…" : s.sheetError || "等待数据…" }));
      $("bh-desc").textContent = cfg?.description ?? "";
    }
    prev.bhDataKey = dataKey;
  }

  const chartKey = [s.sheetId, d?.updatedAt ?? "", d?.history?.length ?? 0].join("|");
  if (prev.bhChartKey !== chartKey) {
    if (d && cfg) {
      $("bh-chart-empty").hidden = true;
      chart.renderSheet({ cfg, sheet: d, preset: s.sheetPreset });
    } else if (s.sheetLoading) {
      $("bh-chart-empty").hidden = false;
      mount($("bh-chart-empty"), ui.EmptyState({ text: "加载数据中…" }));
    } else if (s.sheetError) {
      $("bh-chart-empty").hidden = false;
      mount($("bh-chart-empty"), ui.EmptyState({ text: s.sheetError }));
    }
    prev.bhChartKey = chartKey;
  }
  if (prev.bhPreset !== s.sheetPreset && d) {
    chart.applySheetZoom({ sheet: d, preset: s.sheetPreset });
  }
  prev.bhPreset = s.sheetPreset;
}

function renderSummary(s) {
  const items = s.summaries.map((cfg) => s.summaryData[cfg.id]).filter(Boolean);
  const agg = items.reduce(
    (a, d) => ({ checked: a.checked + d.validation.checked, matched: a.matched + d.validation.matched, mismatched: a.mismatched + d.validation.mismatched }),
    { checked: 0, matched: 0, mismatched: 0 }
  );
  const asOf = items[0]?.asOf ?? null;
  const updatedAt = items.map((d) => d.updatedAt).sort().pop() ?? null;

  const integ = items.reduce(
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
  const integrityAgg = items.some((d) => d.integrity) ? integ : null;

  const headerKey = [asOf, agg.matched, agg.checked, agg.mismatched, integrityAgg?.verdict, integrityAgg?.bad?.length, s.refreshing, s.summaryError, updatedAt].join("|");
  if (prev.sumHeaderKey !== headerKey) {
    mount(
      $("sum-header"),
      ui.SummaryHeader({ asOf, validation: items.length ? agg : null, integrity: integrityAgg, updatedAt, refreshing: s.refreshing, onRefresh: store.refresh, error: s.summaryError })
    );
    prev.sumHeaderKey = headerKey;
  }

  const dataKey = [s.summaries.map((c) => c.id).join(","), items.map((d) => d.updatedAt).join(",")].join("|");
  if (prev.sumDataKey !== dataKey) {
    if (items.length) {
      mount($("sum-tables"), ui.SummaryTables({ items }));
      $("sum-desc").textContent = s.summaries.map((c) => c.description).filter(Boolean).join(" ");
    } else {
      mount($("sum-tables"), ui.EmptyState({ text: s.summaryLoading ? "周度汇总数据加载中…" : s.summaryError || "等待数据…" }));
      $("sum-desc").textContent = "";
    }
    prev.sumDataKey = dataKey;
  }
}

function renderGold(s) {
  const series = s.gold?.series || [];
  const lastOf = (x) => x?.points?.[x.points.length - 1];
  const anchor = series.find((x) => x.cfg.axisPos === "left") || series[0];
  const anchorLast = lastOf(anchor);
  const offKey = series.map((x) => (s.goldOn[seriesLabel(x.cfg)] === false ? "0" : "1")).join("");

  const headerKey = [anchor?.updatedAt ?? "", anchorLast?.date ?? "", anchor?.validation?.matched ?? "", anchor?.validation?.mismatched ?? "", anchor?.integrity?.verdict ?? "", s.goldError ?? "", s.refreshing, series.length].join("|");
  if (prev.goldHeaderKey !== headerKey) {
    mount(
      $("gold-header"),
      ui.HeaderBar({
        cfg: anchor?.cfg,
        latest: anchorLast ? { v: anchorLast.v, d: anchorLast.date } : null,
        validation: anchor?.validation,
        integrity: anchor?.integrity,
        updatedAt: anchor?.updatedAt,
        error: s.goldError,
      })
    );
    prev.goldHeaderKey = headerKey;
  }

  const toolbarKey = [s.goldPreset, s.refreshing, series.length, offKey].join("|");
  if (prev.goldToolbarKey !== toolbarKey) {
    mount(
      $("gold-toolbar"),
      h(
        "div",
        { class: "toolbar" },
        ui.Segmented({
          label: "区间定位",
          value: s.goldPreset,
          onChange: store.setGoldPreset,
          options: PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.title })),
        }),
        ui.Button({ label: s.refreshing ? "更新中…" : "刷新数据", variant: "solid", onClick: store.refresh, disabled: s.refreshing })
      ),
      series.length ? ui.SeriesToggles({ series, selected: s.goldOn, onToggle: store.toggleGoldSeries }) : null
    );
    prev.goldToolbarKey = toolbarKey;
  }

  const chartKey = [series.map((x) => `${x.cfg.id}:${x.updatedAt}:${x.points?.length ?? 0}`).join("|"), offKey].join("|");
  if (prev.goldChartKey !== chartKey) {
    if (series.length) {
      $("gold-chart-empty").hidden = true;
      chart.renderGold({ series, preset: s.goldPreset, selected: s.goldOn });
      const brief = series
        .map((x) => {
          if (x.error) return `${x.cfg.name} 取数失败（${x.error}）`;
          const last = lastOf(x);
          const vld = x.validation?.checked ? `交叉验证 ${x.validation.matched}/${x.validation.checked}` : x.cfg.sourceNote || "";
          return `${x.cfg.name} ${fmtPoint(x.cfg, last?.v)}（${vld}）`;
        })
        .join("　·　");
      const monthly = series.filter((x) => x.cfg.freq === "month" && !x.error);
      const lagNote = monthly.length
        ? " " +
          monthly
            .map(
              (x) =>
                `${x.cfg.name}为月度官方申报序列，最新观测至 ${lastOf(x)?.date?.slice(0, 7) || "—"}；区间收到比该月更近的窗口时，窗口内没有它的观测点，属官方尚未发布而非缺数，切「1Y／全部」可看完整月度形态。`
            )
            .join("")
        : "";
      $("gold-desc").textContent =
        `${brief}。点击图例或上方标签可单独开启 / 关闭任一序列，坐标轴随可见序列自动增减。${lagNote}` +
        series.map((x) => x.cfg.description).filter(Boolean).join(" ");
    } else {
      mount($("gold-chart-empty"), ui.EmptyState({ text: s.goldLoading ? "黄金板块数据加载中…" : s.goldError || "等待数据…" }));
      $("gold-chart-empty").hidden = false;
      $("gold-desc").textContent = "";
    }
    prev.goldChartKey = chartKey;
  }
  if (prev.goldPreset !== s.goldPreset) {
    chart.applyGoldZoom({ preset: s.goldPreset });
  }
  prev.goldPreset = s.goldPreset;
}

function render(s) {
  if (prev.region !== s.region) {
    mount(
      $("region-switch"),
      ui.Segmented({
        label: "市场",
        value: s.region,
        onChange: store.setRegion,
        options: [
          { value: "us", label: "美国", title: "美联储 / 纽约联储 / FRED 官方数据" },
          { value: "cn", label: "中国", title: "中国人民银行 / CFETS 中国外汇交易中心 / 国家外汇管理局 官方数据" },
        ],
      })
    );
    prev.region = s.region;
  }

  const isMonitor = s.page === "monitor";
  const isSummary = s.page === "summary";
  const isGold = s.page === "gold";
  const hasGold = s.indicators.some((i) => i.surface === "gold");
  $("page-monitor").hidden = !isMonitor;
  $("page-balance").hidden = isMonitor || isSummary || isGold;
  $("page-summary").hidden = !isSummary;
  $("page-gold").hidden = !isGold;
  $("indicator-nav").hidden = !isMonitor;

  const pageNavKey = `${s.page}|${s.region}|${s.sheets.length}|${s.summaries.length}|${hasGold}|${s.sheets.map((x) => x.status?.updatedAt ?? "").join(",")}|${s.summaries.map((x) => x.status?.updatedAt ?? "").join(",")}`;
  if (prev.pageNavKey !== pageNavKey) {
    mount($("page-nav"), ui.PageNav({ sheets: s.sheets, summaries: s.summaries, gold: hasGold, page: s.page, onPage: store.setPage }));
    prev.pageNavKey = pageNavKey;
  }

  if (prev.page !== s.page) {
    chart.resizeAll();
    prev.page = s.page;
  }

  if (isMonitor) renderMonitor(s);
  else if (isSummary) renderSummary(s);
  else if (isGold) renderGold(s);
  else renderBalance(s);
}

store.subscribe(render);
store.init();
setInterval(() => store.silentReload(), 10 * 60 * 1000);