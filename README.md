# web-clips-publish

`l4place0/web-clips` 的独立静态展示仓库。内容仓库保存 Markdown 和轻量发布元数据；本仓库
固定 checkout 内容 `main` 的一个完整 commit SHA，构建 Quartz 并部署到 GitHub Pages。

## 自动发布

- 每小时第 17、47 分钟检查内容仓库。
- 已成功部署过相同内容 SHA 时跳过构建。
- Actions 页面支持手动运行；选择 `force` 可强制重建相同 SHA。
- 构建失败不会登记 SHA，也不会覆盖上一次成功 Pages 部署。

站点地址：<https://l4place0.github.io/web-clips-publish/>

## 本地验证

PowerShell：

```powershell
$env:WEB_CLIPS_CONTENT_ROOT = "C:\path\to\web-clips"
npm.cmd ci
npm.cmd test
npm.cmd run build:site
```

构建产物位于 `public/`。内容仓库必须包含 `publishing/publisher.mjs`、
`publishing/config.json` 和有效的 RID 注册表。

