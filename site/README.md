# Quartz 展示层

本目录只负责把内容仓库导出的公开闭包渲染为静态站点。构建器要求显式提供
`WEB_CLIPS_CONTENT_ROOT`，因此不会意外扫描展示仓库或其他本地目录。

```powershell
$env:WEB_CLIPS_CONTENT_ROOT = "C:\\path\\to\\web-clips"
npm.cmd run build:site
```

构建流程：

1. 从内容仓库加载 `publishing/publisher.mjs`；
2. 校验并生成内容仓库的 `.publish-stage`；
3. 只复制 manifest 声明的 Markdown、raw 和迁移期本地附件；
4. 使用锁定版本的 Quartz 构建；
5. 原子替换本仓库的 `public/`。

Quartz 与插件版本由 `package-lock.json` 和 `quartz.lock.json` 固定。GitHub Pages
项目路径已经写入 `quartz.config.yaml`：`l4place0.github.io/web-clips-publish`。

媒体迁移后，Markdown 直接引用 `https://assets.l4p.site/...`，展示仓库不复制
`clips/assets/`。迁移完成前仍保留旧附件旁路复制能力，以便并行验收和回滚。
