# Quartz 展示层

本目录只负责把内容仓库导出的公开闭包渲染为静态站点。构建器要求显式提供
`WEB_CLIPS_CONTENT_ROOT`，因此不会意外扫描展示仓库或其他本地目录。

```powershell
$env:WEB_CLIPS_CONTENT_ROOT = "C:\\path\\to\\web-clips"
npm.cmd run build:site
```

构建流程：

1. 使用展示仓库内置发布器校验内容仓库；
2. 生成内容 checkout 中的临时 `.publish-stage`；
3. 只复制 manifest 声明的 Markdown、raw 和迁移期本地附件；
4. 使用锁定版本的 Quartz 构建；
5. 原子替换本仓库的 `public/`。

Quartz 与插件版本由 `package-lock.json` 和 `quartz.lock.json` 固定。GitHub Pages
项目路径已经写入 `quartz.config.yaml`：`l4place0-cloud.github.io/web-clips-publish`。

媒体迁移后，Markdown 直接引用 `https://assets.l4p.site/...`，展示仓库不复制
`clips/assets/`。迁移完成前仍保留旧附件旁路复制能力，以便并行验收和回滚。
远端 checkout 中缺失本地附件的笔记会整篇隔离；其余笔记继续构建，避免生成破图或泄露
本地缓存路径。
