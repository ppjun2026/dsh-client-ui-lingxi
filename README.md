# 灵犀 · 灵感工作台（dsh-client-ui-lingxi）

[![License: MIT](https://img.shields.io/github/license/ppjun2026/dsh-client-ui-lingxi?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ppjun2026/dsh-client-ui-lingxi?include_prereleases&label=release&color=orange)](https://github.com/ppjun2026/dsh-client-ui-lingxi/releases)
[![Stars](https://img.shields.io/github/stars/ppjun2026/dsh-client-ui-lingxi?style=social)](https://github.com/ppjun2026/dsh-client-ui-lingxi)

> 日常中散落、模糊的临时想法，往往日后会成长为好项目，甚至彼此关联。
> 灵犀把它们沉淀成一个「灵感池」：随时录入 → 随时打捞深入 → 制定计划 → 立项管理，
> 并由 AI 帮你做初步解析、评分、标签化与关联合并。

灵犀是一个 **DSH Web GUI 插件**，安装在侧边栏「灵犀」入口，点击后在主区打开灵感工作台。

## 功能

- **灵感池**：卡片墙展示所有想法，支持按状态、标签、关键词筛选与搜索。
- **随手录入**：网页顶部快捷框，或在对话里直接对 DSH 助手说一个想法。
- **想法生命周期**：`灵感种子 → 孵化中 → 计划中 → 已立项`，另有「已合并 / 已归档」。
- **AI 解析**（对话通道）：一句话概括、展开解析、多维评分（新颖性/可行性/价值潜力/综合）、自动标签、领域分类。
- **关联与合并**：检测想法间的关联（高/中/低 + 理由），关联度高的建议合并，合并保留历史。
- **关联图谱**：Canvas 力导向网络图，直观看到想法之间的关联簇。
- **深入构想**：每条想法可累积「构想记录」。
- **项目管理**：立项后生成项目 + 任务看板（待办 / 进行中 / 已完成）。

## 安装

在 DSH 环境中安装本插件（二选一）：

```bash
# 方式一：从 Git 仓库安装（link 模式，改代码后重启 DSH 生效）
dsh plugin --profile web add "link:<本仓库路径>"

# 方式二：从 npm 安装（发布后）
dsh plugin --profile web add @linxin666/dsh-client-ui-lingxi
```

安装后重启 DSH，侧边栏出现「灵犀」入口即成功。

## 数据文件

- 默认位置：`~/.dsh/lingxi/lingxi-data.json`（`lib/index.js` 中的兜底路径）
- 可通过 `cordis.patch.yml` 的 `config.dataFile` 指定（相对/绝对路径均可）
- 也可通过环境变量 `LINGXI_DATA_FILE` 覆盖
- 单文件 JSON，可随时备份/导出/迁移

## 双通道使用方式

### 通道一：对话（推荐，随手 + AI 加工）

在任意对话里对 DSH 助手说，例如：

- `我又有个想法：做一个把散落灵感收集成项目池的工具`
- `把刚才那个想法记进灵犀`
- `解析一下灵犀里的新想法`
- `灵犀里有哪些想法关联性很强？帮我合并`
- `帮我把「xxx」这个想法深入构想一下`
- `把「xxx」立项，制定一个计划`

助手会读写数据文件，完成解析、评分、打标签、关联检测与合并，网页刷新即可看到结果。

### 通道二：网页

侧边栏点「灵犀」→ 顶部快捷框输入想法 → 回车或点「入池」。
网页录入的想法先以「灵感种子」入池，AI 解析可再在对话里让助手处理。

## 数据模型（数据 JSON 文件）

```jsonc
{
  "schemaVersion": 1,
  "revision": 0,
  "ideas": [{
    "id": "…", "raw": "原始想法", "title": "一句话标题",
    "status": "seed|incubating|planning|project|merged|archived",
    "scores": { "novelty": 0, "feasibility": 0, "value": 0, "overall": 0 },
    "analysis": "AI 解析", "tags": ["…"], "domain": "领域",
    "related": [{ "ideaId": "…", "strength": "high|medium|low", "reason": "…" }],
    "notes": [{ "id": "…", "text": "…", "createdAt": 0 }],
    "mergedInto": null, "createdAt": 0, "updatedAt": 0
  }],
  "projects": [{ "id": "…", "ideaId": "…", "name": "…", "goal": "…",
    "tasks": [{ "id": "…", "title": "…", "status": "todo|doing|done" }] }],
  "merges": [{ "id": "…", "intoId": "…", "fromId": "…", "reason": "…", "createdAt": 0 }]
}
```

## 技术要点

- **文件即真相**：宿主侧每次读写都直接操作 JSON 文件，不缓存。
  因此「对话通道」（AI 直接写文件）与「网页通道」（经 `/api/lingxi` 路由写文件）天然共享同一份数据。
- **零构建工具链**：纯手写 ESM + 原生 DOM，无需 TypeScript / React / 构建工具。
- **API**：`GET /api/lingxi/state`（读全量）、`POST /api/lingxi/action`（写变更），仅回环 + 同源可访问。
- **架构**：`lib/index.js` 为 Host 侧（提供 API 路由 + 系统提示注入），`lib/client.js` 为浏览器侧（渲染工作台）。

## 开发

```bash
# 本地 link 安装后，修改代码 → 重启 DSH 即生效
dsh plugin --profile web add "link:."
```

## 许可证

[MIT](./LICENSE)
