# web-clips-publish

`l4place0/web-clips` 的独立静态展示仓库。内容仓库保存 Markdown 和轻量发布元数据；本仓库
固定 checkout 内容 `main` 的一个完整 commit SHA，构建 Quartz 并部署到 GitHub Pages。

## 自动发布

- 每小时第 17、47 分钟检查内容仓库。
- 已成功部署过相同内容 SHA 时跳过构建。
- Actions 页面支持手动运行；选择 `force` 可强制重建相同 SHA。
- 构建失败不会登记 SHA，也不会覆盖上一次成功 Pages 部署。

站点地址：<https://l4place0-cloud.github.io/web-clips-publish/>

## 本地验证

PowerShell：

```powershell
$env:WEB_CLIPS_CONTENT_ROOT = "C:\path\to\web-clips"
npm.cmd ci
npm.cmd test
npm.cmd run build:site
```

构建产物位于 `public/`。内容仓库只需提供 `clips/` 下带有有效 `rid`、`permalink`
元数据的 Markdown；发布器与机器配置由本展示仓库维护。

仍引用未同步本地附件的笔记会被本次构建隔离并产生 `W_NOTE_QUARANTINED`，不会阻断
其他完整内容，也不会把失效附件路径发布到站点。
