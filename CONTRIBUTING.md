# 贡献指南（Contributing）

感谢你对灵犀（dsh-client-ui-lingxi）感兴趣！任何形式的贡献都欢迎：
提 issue、修 bug、加功能、写文档、提想法。

## 行为准则

- 友善、专业、尊重他人
- 讨论技术问题对事不对人
- 不发布与项目无关的内容

## 开发环境

灵犀是 **DSH Web GUI 插件**，需要本机有 DSH 环境才能运行调试。

```bash
# 1. 克隆仓库
git clone https://github.com/ppjun2026/dsh-client-ui-lingxi.git

# 2. 以 link 方式安装到 DSH web profile（改代码后重启 DSH 即生效）
dsh plugin --profile web add "link:."

# 3. 重启 DSH，侧边栏出现「灵犀」入口即安装成功
```

数据文件默认 `~/.dsh/lingxi/lingxi-data.json`（可通过 `cordis.patch.yml` 的
`config.dataFile` 或环境变量 `LINGXI_DATA_FILE` 覆盖）。开发时建议用独立的数据文件，
避免污染自己的真实想法池。

## 代码结构

```
lib/
  index.js   # Host 侧：/api/lingxi 路由、系统提示注入、文件读写（file-as-source-of-truth）
  client.js  # 浏览器侧：灵感工作台 UI（原生 DOM，零构建）
cordis.patch.yml  # bundle patch：向 web profile roster 插入插件行
```

## 开发约定

- **零构建工具链**：纯手写 ESM + 原生 DOM，不引入 TypeScript / React / 构建工具
- **文件即真相**：Host 每次读写都直接操作 JSON 文件，不缓存
- 代码风格尽量与现有文件保持一致（见 `lib/index.js` 的注释风格）
- 不改动数据文件格式（`schemaVersion: 1`）除非是兼容性升级

## 提 Pull Request

1. fork 仓库，从 `main` 新建分支：`git checkout -b feat/your-feature`
2. 开发并本地验证（重启 DSH 查看效果）
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
   - `feat: ...` 新功能
   - `fix: ...` 修 bug
   - `docs: ...` 文档
   - `refactor: ...` 重构
   - `chore: ...` 杂项
4. 推送到你的 fork，向 `main` 发起 Pull Request
5. 在 PR 描述里说明改动内容、动机、验证方式

## 提 Issue

- **Bug**：说明复现步骤、期望行为、实际行为、DSH 版本、截图（如适用）
- **功能建议**：说明场景、动机、期望效果；若是想法池相关的点子，欢迎直接用灵犀记录下来 😄

## 许可证

本项目以 [MIT](./LICENSE) 协议发布，贡献即视为同意在该协议下分发。
