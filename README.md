# 鸿学院金融指标监控

美联储 / 中国官方金融指标的监控站。核心不是"画好看的图"，而是**一个数字只能有一个来源结论**——官方双源交叉验证、改值留痕、不造数，并把这些纪律做成**会阻断回归的机检门禁**。

## 快速开始

零依赖，Node 22+：

```bash
npm start          # 启动本地服务 http://localhost:3000
```

前端是原生 ES 模块 + ECharts（本地 vendor），后端是 Node `http` + SQLite。无构建步骤。

## CI / 本地验证

同样的命令在 CI 与本地跑（`node tools/gates.mjs --net`）：

```bash
node tools/gates.mjs --net      # 26 条门禁全绿；--net 才跑 G4 出网纠错负向对照
node tools/selftest.mjs         # 沙箱热插拔 + 门禁可证红 + fixture 对账
node tools/snapshot.mjs --check # 视觉回归：冻结输入下 option 零漂移
```

门禁编号与判据见 [`specs/gates.md`](specs/gates.md)。任何失败只能通过**修正实现**或**同时修正规范两处**来关闭，禁止放宽阈值、注释断言、加豁免。

## 目录即契约

| 目录 | 职责 |
| --- | --- |
| `indicators/*.json` | 指标声明：官方源、校验腿、阈值来源、状态带 |
| `charts/*.json` | 页面与图形声明：视图投影、轴、视图组、tooltip 列 |
| `sheets/` `summaries/` | H.4.1 报表与周度汇总的声明式装配 |
| `backend/providers/` | 官方源插件；新增 provider 不改路由 |
| `backend/lib/` | 取数缓存 → 计算/交叉验证 → 完整性 → 原子落盘 → 面板装配 |
| `frontend/js/core/` | 唯一网络出口、唯一状态源、纯函数派生、唯一 ECharts 出口 |
| `frontend/js/views/` | 视图投影族：header / toolbar / panel / tables / nav |
| `frontend/js/ui/` | 组件族，页面代码不直接写 innerHTML |
| `tools/` | 门禁、自检、快照、基线棘轮、发布脚本 |

新增一个指标 = 加一份 `indicators/*.json`（+ 必要时一个 provider），不改主程序。新增一页 = 加一份 `charts/*.json`。G12 会实证这一点。

## 数据红线

1. **不造数**：缺口留空并说明；官方未发布不回补。
2. **不静默替换**：改值必须写 `corrected:{from,to,by}`。
3. **不绕 WAF**：遇到反爬放弃并透明标注；被拒源登记在 `specs/rejected-sources.json`。

## 工作流

- 改动走 issue → 分支 → PR；PR 模板会检查变更面与门禁结果。
- CI 在 PR 与 `main` push 上跑全部门禁 + 自检 + 快照比对；任一红即不能合并。
- 规范与设计依据见 `docs/`。

## License

见 [LICENSE](LICENSE)。数据来自各官方机构，引用请遵循其发布条款。
