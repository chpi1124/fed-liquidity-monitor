import { colorOf, eraOf, fmtPoint, fmtVal, seriesLabel, SHEET_PRESETS, zoneOf, zoomWindow } from "./core/derive.js";

let inst = null;
let sheetInst = null;
let goldInst = null;
const instances = new Set();
let resizeBound = false;

function track(i) {
  instances.add(i);
  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener("resize", () => {
      for (const x of instances) x.resize();
    });
  }
  return i;
}

export function mount(el) {
  inst = track(echarts.init(el));
  return inst;
}

export function mountSheet(el) {
  sheetInst = track(echarts.init(el));
  return sheetInst;
}

export function mountGold(el) {
  goldInst = track(echarts.init(el));
  return goldInst;
}

export function resizeAll() {
  for (const x of instances) x.resize();
}

function markLines(cfg) {
  if (!cfg.zones) return undefined;
  return {
    silent: true,
    symbol: "none",
    data: cfg.zones
      .filter((z) => z.max != null)
      .map((z) => {
        const above = zoneOf(cfg.zones, z.max + 0.001);
        return {
          yAxis: z.max,
          lineStyle: { color: above.color, type: "dashed", width: 1, shadowColor: above.color, shadowBlur: 6 },
          label: {
            formatter: `${above.label} > ${z.max}${cfg.unit}`,
            position: "insideEndTop",
            color: above.color,
            fontSize: 11,
          },
        };
      }),
  };
}

export function render({ cfg, points, granularity, preset }) {
  if (!inst || !points) return;
  const isDay = granularity === "day";
  const w = zoomWindow(points, preset);
  const series = isDay
    ? {
        type: "bar",
        barWidth: "62%",
        data: points.map((p) => ({
          value: p.v,
          itemStyle: {
            color: colorOf(cfg.zones, p.v, cfg.hue),
            // 存疑柱描红边、已改值柱描金边：数据只标记不删除，问题点在图上就看得见
            borderColor: p.suspect ? "#ff5566" : p.corrected ? "#e8c46a" : "transparent",
            borderWidth: p.suspect || p.corrected ? 1.6 : 0,
          },
        })),
        markLine: markLines(cfg),
      }
    : {
        type: "candlestick",
        data: points.map((p) => {
          const c = colorOf(cfg.zones, p.c, cfg.hue);
          return { value: [p.o, p.c, p.l, p.h], itemStyle: { color: c, color0: c, borderColor: c, borderColor0: c } };
        }),
        markLine: markLines(cfg),
      };

  function fmt(params) {
    const p = Array.isArray(params) ? params[0] : params;
    const pt = points[p.dataIndex];
    if (!pt) return "";
    const v = isDay ? pt.v : pt.c;
    const z = zoneOf(cfg.zones, v);
    const okTxt = pt.ok === true ? "交叉验证 通过" : pt.ok === false ? "交叉验证 不一致" : "无校验源";
    // 纠错留痕直接写在 tooltip 上：改前值、改后值、依据来源与存疑原因，全部可追溯到官方源
    const fixTxt = pt.corrected
      ? `<br/>已依 ${pt.corrected.by} 改值：${fmtVal(pt.corrected.from, cfg)} → ${fmtVal(pt.corrected.to, cfg)}${cfg.unit}`
      : "";
    const susTxt = pt.suspect ? `<br/>存疑（${pt.suspect}）：保留原值不删不改，已排除出本桶统计` : "";
    if (isDay) {
      return `${pt.date}<br/>${cfg.name}: <b>${fmtVal(pt.v, cfg)}${cfg.unit}</b>${z ? ` · ${z.label}` : ""}<br/>${okTxt}${fixTxt}${susTxt}`;
    }
    return `${pt.date}（${granularity === "week" ? "周" : "月"}，${pt.n} 个交易日）<br/>开 ${fmtVal(pt.o, cfg)} · 收 ${fmtVal(pt.c, cfg)} · 高 ${fmtVal(pt.h, cfg)} · 低 ${fmtVal(pt.l, cfg)}<br/>${z ? z.label + " · " : ""}${okTxt}${pt.corrected ? `<br/>本期含 ${pt.corrected} 个改值点` : ""}${pt.suspect ? `<br/>本期含 ${pt.suspect} 个存疑点（已排除出开/高/低/收统计）` : ""}`;
  }

  inst.setOption(
    {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 56, right: 20, top: 30, bottom: 64 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#1a2530" } },
        backgroundColor: "rgba(18,26,35,.94)",
        borderColor: "#223140",
        textStyle: { color: "#e8eef4", fontSize: 12 },
        formatter: fmt,
      },
      xAxis: {
        type: "category",
        data: points.map((p) => p.date),
        axisLine: { lineStyle: { color: "#223140" } },
        axisLabel: { color: "#8fa3b0" },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: cfg.unit,
        nameTextStyle: { color: "#8fa3b0" },
        axisLabel: { color: "#8fa3b0" },
        splitLine: { lineStyle: { color: "rgba(34,49,64,.6)" } },
      },
      dataZoom: [
        { type: "inside", startValue: w.start, endValue: w.end },
        {
          type: "slider",
          startValue: w.start,
          endValue: w.end,
          height: 22,
          bottom: 10,
          borderColor: "#223140",
          backgroundColor: "rgba(18,26,35,.8)",
          fillerColor: "rgba(255,138,42,.16)",
          handleStyle: { color: "#ff8a2a", borderColor: "#ff8a2a" },
          moveHandleStyle: { color: "#31465c" },
          textStyle: { color: "#8fa3b0" },
          dataBackground: { lineStyle: { color: "#31465c" }, areaStyle: { color: "rgba(49,70,92,.3)" } },
        },
      ],
      series: [series],
    },
    { notMerge: true }
  );
}

export function applyZoom({ points, preset }) {
  if (!inst || !points || !points.length) return;
  const w = zoomWindow(points, preset);
  inst.setOption({
    dataZoom: [
      { startValue: w.start, endValue: w.end },
      { startValue: w.start, endValue: w.end },
    ],
  });
}

const ZOOM_STYLE = {
  height: 22,
  bottom: 10,
  borderColor: "#223140",
  backgroundColor: "rgba(18,26,35,.8)",
  fillerColor: "rgba(255,138,42,.16)",
  handleStyle: { color: "#ff8a2a", borderColor: "#ff8a2a" },
  moveHandleStyle: { color: "#31465c" },
  textStyle: { color: "#8fa3b0" },
  dataBackground: { lineStyle: { color: "#31465c" }, areaStyle: { color: "rgba(49,70,92,.3)" } },
};

export function renderSheet({ cfg, sheet, preset }) {
  if (!sheetInst || !sheet?.history?.length) return;
  sheetInst.resize();
  const pts = sheet.history.map((p) => ({ date: p.d, v: p.v / 1e6 }));
  const cats = pts.map((p) => p.date);
  const last = cats[cats.length - 1];
  const near = (d) => {
    const i = cats.findIndex((c) => c >= d);
    return cats[i < 0 ? cats.length - 1 : i];
  };
  const w = zoomWindow(pts, preset, SHEET_PRESETS);
  const areas = (cfg.eras || []).map((e) => [
    {
      name: e.label,
      xAxis: near(e.from),
      itemStyle: { color: `${e.color}14` },
      label: { show: true, position: "insideTop", color: e.color, fontSize: 10, fontWeight: 700 },
    },
    { xAxis: e.to ? near(e.to) : last },
  ]);

  function fmt(params) {
    const p = Array.isArray(params) ? params[0] : params;
    const i = p.dataIndex;
    const pt = pts[i];
    if (!pt) return "";
    const era = eraOf(cfg.eras, pt.date);
    const wc = i > 0 ? (pt.v - pts[i - 1].v) * 1e4 : null;
    const wcTxt = wc == null ? "" : `<br/>周环比 <b>${wc >= 0 ? "+" : ""}${wc.toFixed(1)}</b> 亿美元`;
    return `${pt.date}（周三）<br/>总资产 <b>${pt.v.toFixed(3)}</b> 万亿美元${wcTxt}${era ? `<br/>时期：${era.label}` : ""}<br/>FRED WALCL · 与理事会 H.4.1 交叉验证`;
  }

  sheetInst.setOption(
    {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 56, right: 20, top: 30, bottom: 64 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#1a2530" } },
        backgroundColor: "rgba(18,26,35,.94)",
        borderColor: "#223140",
        textStyle: { color: "#e8eef4", fontSize: 12 },
        formatter: fmt,
      },
      xAxis: {
        type: "category",
        data: cats,
        axisLine: { lineStyle: { color: "#223140" } },
        axisLabel: { color: "#8fa3b0" },
      },
      yAxis: {
        type: "value",
        min: 0,
        name: "万亿美元",
        nameTextStyle: { color: "#8fa3b0" },
        axisLabel: { color: "#8fa3b0" },
        splitLine: { lineStyle: { color: "rgba(34,49,64,.6)" } },
      },
      dataZoom: [
        { type: "inside", startValue: w.start, endValue: w.end },
        { type: "slider", startValue: w.start, endValue: w.end, ...ZOOM_STYLE },
      ],
      series: [
        {
          type: "bar",
          barWidth: "72%",
          data: pts.map((p) => ({ value: p.v, itemStyle: { color: eraOf(cfg.eras, p.date)?.color || "#3aa6ff" } })),
          markArea: { silent: true, data: areas },
        },
      ],
    },
    { notMerge: true }
  );
}

export function applySheetZoom({ sheet, preset }) {
  if (!sheetInst || !sheet?.history?.length) return;
  const pts = sheet.history.map((p) => ({ date: p.d, v: p.v }));
  const w = zoomWindow(pts, preset, SHEET_PRESETS);
  sheetInst.setOption({
    dataZoom: [
      { startValue: w.start, endValue: w.end },
      { startValue: w.start, endValue: w.end },
    ],
  });
}

let goldCats = [];

export function renderGold({ series, preset, selected = {} }) {
  if (!goldInst || !series?.length) return;
  goldInst.resize();
  const label = (cfg) => seriesLabel(cfg);
  const maps = series.map((s) => new Map(s.points.map((p) => [p.date, p.v])));
  // 存疑点（区间/跳变/交叉越带或主校不一致）在图上以空心菱形标出：不删、不藏、不静默平滑
  const susMaps = series.map((s) => new Map(s.points.map((p) => [p.date, p.suspect || (p.ok === false ? "mismatch" : null)])));
  const cats = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();
  goldCats = cats;
  const pts = cats.map((date) => ({ date }));
  const w = zoomWindow(pts, preset);
  const on = (cfg) => selected[label(cfg)] !== false;
  const shown = (s) => on(s.cfg) && !!s.points?.length;
  const lastObsOnOrBefore = (si, d) => {
    const ps = series[si].points;
    let lo = 0, hi = ps.length - 1, res = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].date <= d) {
        res = ps[mid].date;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return res;
  };

  const axes = [];
  for (const s of series) {
    if (!axes.some((a) => a.key === s.cfg.axis)) axes.push({ key: s.cfg.axis, cfg: s.cfg });
  }
  const visible = series.filter(shown);
  const axisIndexOf = (axisKey) => axes.findIndex((a) => a.key === axisKey);
  const posOf = (cfg) => cfg.axisPos || (cfg.axis === "left" ? "left" : "right");
  const countAt = (side) => axes.filter((a) => visible.some((s) => s.cfg.axis === a.key) && posOf(a.cfg) === side).length;
  const seq = { left: 0, right: 0 };
  const yAxis = axes.map((a) => {
    const cfg = a.cfg;
    const side = posOf(cfg);
    const idx = seq[side]++;
    const axisShown = visible.some((s) => s.cfg.axis === a.key);
    return {
      type: "value",
      name: axisShown ? cfg.axisName || cfg.name : "",
      inverse: !!cfg.invert,
      scale: true,
      show: axisShown,
      position: side,
      offset: idx * 52,
      nameTextStyle: { color: cfg.hue, fontSize: 11 },
      axisLabel: {
        color: "#8fa3b0",
        formatter: (v) => `${cfg.axisPrefix || ""}${v}${cfg.axisSuffix || ""}`,
      },
      splitLine: axisShown && side === "left" && idx === 0 ? { lineStyle: { color: "rgba(34,49,64,.6)" } } : { show: false },
    };
  });

  const buildSeries = (s, i) => {
    const cfg = s.cfg;
    const raw = cats.map((d) => (maps[i].has(d) ? maps[i].get(d) : null));
    const sus = susMaps[i];
    const data = raw.map((v, k) =>
      v == null || !sus.get(cats[k]) ? v : { value: v, symbol: "diamond", symbolSize: 9, itemStyle: { color: "#0f1620", borderColor: "#ff5566", borderWidth: 1.6 } }
    );
    const base = { name: label(cfg), yAxisIndex: axisIndexOf(cfg.axis), data };
    if (cfg.render === "bar") {
      const styled = cfg.posColor
        ? data.map((v) => (v == null ? v : { value: v, itemStyle: { color: v >= 0 ? cfg.posColor : cfg.negColor } }))
        : data;
      return {
        ...base,
        data: styled,
        type: "bar",
        barWidth: cfg.barWidth || 3,
        barMinHeight: 2,
        itemStyle: { color: cfg.hue },
        z: 2,
      };
    }
    if (cfg.render === "month-line")
      return {
        ...base,
        type: "line",
        symbol: "rect",
        symbolSize: 6,
        showSymbol: true,
        connectNulls: true,
        lineStyle: { color: cfg.hue, width: 1.4, opacity: 0.8 },
        itemStyle: { color: cfg.hue, borderColor: "#0f1620", borderWidth: 1 },
        z: 3,
      };
    return {
      ...base,
      type: "line",
      showSymbol: false,
      connectNulls: true,
      lineStyle: { color: cfg.hue, width: 1.6 },
      areaStyle: cfg.area ? { color: cfg.area } : undefined,
    };
  };

  function fmt(params) {
    const i = params[0].dataIndex;
    const head = cats[i] || "";
    const rows = params
      .filter((p) => p.value != null)
      .map((p) => {
        const cfg = series[p.seriesIndex].cfg;
        const dir =
          cfg.posColor && Number.isFinite(p.value)
            ? `　<b style="color:${p.value >= 0 ? cfg.posColor : cfg.negColor}">${p.value >= 0 ? "净流入·吸纳" : "净流出·吐出"}</b>`
            : "";
        return `${p.marker}${cfg.name}: <b>${fmtPoint(cfg, p.value)}</b>${dir}　${cfg.sourceNote || ""}`;
      });
    if (!rows.length) return `${head}<br/>无可显示序列（点击上方标签开启）`;
    const gaps = series
      .map((s, si) => ({ s, si }))
      .filter(({ s, si }) => s.cfg.freq === "month" && shown(s) && !params.some((p) => p.seriesIndex === si && p.value != null))
      .map(({ s, si }) => {
        const obs = lastObsOnOrBefore(si, head);
        const how = s.cfg.render === "bar" ? "柱只落在每月首日" : "折线为观测月之间的连线";
        return `<br/><span style="color:#8fa3b0">${s.cfg.name}：该日无官方月度观测${obs ? `（最近观测月 ${obs.slice(0, 7)}）` : ""}，${how}。</span>`;
      })
      .join("");
    return `${head}<br/>${rows.join("<br/>")}${gaps}`;
  }

  goldInst.setOption(
    {
      backgroundColor: "transparent",
      animation: false,
      legend: {
        data: series.map((s) => label(s.cfg)),
        selected: Object.fromEntries(series.map((s) => [label(s.cfg), on(s.cfg)])),
        selectedMode: "multiple",
        inactiveColor: "#42525e",
        itemGap: 16,
        textStyle: { color: "#c7d3dc", fontSize: 12 },
        top: 2,
      },
      grid: {
        left: 58 + 52 * Math.max(0, countAt("left") - 1),
        right: 62 + 52 * Math.max(0, countAt("right") - 1),
        top: 40,
        bottom: 64,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#1a2530" } },
        backgroundColor: "rgba(18,26,35,.94)",
        borderColor: "#223140",
        textStyle: { color: "#e8eef4", fontSize: 12 },
        formatter: fmt,
      },
      xAxis: { type: "category", data: cats, axisLine: { lineStyle: { color: "#223140" } }, axisLabel: { color: "#8fa3b0" } },
      yAxis,
      dataZoom: [
        { type: "inside", startValue: w.start, endValue: w.end },
        { type: "slider", startValue: w.start, endValue: w.end, ...ZOOM_STYLE },
      ],
      series: series.map(buildSeries),
    },
    { notMerge: true }
  );
}

export function onGoldLegend(cb) {
  if (goldInst) goldInst.on("legendselectchanged", (e) => cb(e.selected));
}

export function applyGoldZoom({ preset }) {
  if (!goldInst || !goldCats.length) return;
  const w = zoomWindow(goldCats.map((date) => ({ date })), preset);
  goldInst.setOption({
    dataZoom: [
      { startValue: w.start, endValue: w.end },
      { startValue: w.start, endValue: w.end },
    ],
  });
}
