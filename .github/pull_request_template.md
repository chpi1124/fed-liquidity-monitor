## 关联 issue

Closes #

## 改了什么

<!-- 一句话说明；若新增指标/页面，列出文件名与 spec id -->

## 变更面自检

- [ ] 只改了数据/资产层（`indicators/` `charts/` `sheets/` `summaries/` `specs/` `fixtures/`），未改主程序（`backend/server.js` `frontend/js/app.js` `frontend/js/core/store.js` `frontend/js/core/chart-panel.js`）
- [ ] 若改了主程序，在下方说明理由并确认 G12 门禁仍绿

## 门禁与自检

```
node tools/gates.mjs --net     # 期望 26/26 GREEN
node tools/selftest.mjs        # 期望 FAIL 0
node tools/snapshot.mjs --check # 期望差异 0 份
```

- [ ] 全量门禁 GREEN（若有 RED-BLOCKED，说明原因）
- [ ] 自检 FAIL 0
- [ ] 快照内容零漂移（若因视觉/口径有意变更，说明已 `--write` 重刷并写清原因）

## 数据红线

- [ ] 未造数、未静默改值、未绕 WAF；新序列有官方出处与校验腿
- [ ] 阈值都带 `source`（样本/区间/统计量）

## 浏览器实测（涉及 UI 时）

<!-- 视口、页面、ECharts series 数、控制台错误数 -->

## 备注
