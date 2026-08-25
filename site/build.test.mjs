import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildSite } from "./build.mjs"
import * as contentPublisher from "./publisher.mjs"

const CONTENT_REPO_ROOT = process.env.WEB_CLIPS_CONTENT_ROOT
if (!CONTENT_REPO_ROOT) throw new Error("WEB_CLIPS_CONTENT_ROOT is required for site tests")
const { assignId } = contentPublisher

const RID = "5d3b8f6e-19c4-4c62-9a71-2f0e8d7b6c45"
const PROJECT_PATH = "/web-clips-publish"
const PRIVATE_SENTINEL = "PRIVATE_SENTINEL_DO_NOT_PUBLISH_9a4f"
const SEARCH_TERM = "量子剪藏检索词"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
)

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function listFiles(root) {
  const result = []
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(full)
      else result.push(full)
    }
  }
  await visit(root)
  return result
}

test("production pipeline publishes only the staged closure with stable routes", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "web-clips-site-"))
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }))

  await fs.mkdir(path.join(fixture, "publishing"), { recursive: true })
  const config = JSON.parse(
    await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "publisher.config.json"), "utf8"),
  )
  config.source.root = "."
  config.source.publishAll = false
  config.attachments.allowedLocalRoots = ["assets"]
  config.attachments.localImages.onMissing = "error"
  await fs.writeFile(
    path.join(fixture, "publishing", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  await write(fixture, "assets/图片 空格.png", PNG)
  await write(fixture, "assets/未引用.png", PRIVATE_SENTINEL)
  await write(
    fixture,
    "公开 笔记.md",
    `---
title: 中文公开笔记
publish: false
tags:
  - 中文标签
---

# 中文公开笔记

${SEARCH_TERM}

## 第一节

公开正文。

## 第二节

![示例](<assets/图片 空格.png>)
`,
  )
  await write(
    fixture,
    "私人 sentinel.md",
    `---
title: 私人内容
publish: false
---

${PRIVATE_SENTINEL}
`,
  )

  await assignId(fixture, "公开 笔记.md", { uuid: () => RID })
  const assigned = await fs.readFile(path.join(fixture, "公开 笔记.md"), "utf8")
  await fs.writeFile(path.join(fixture, "公开 笔记.md"), assigned.replace("publish: false", "publish: true"), "utf8")

  const result = await buildSite(fixture, { outputRoot: fixture, publisher: contentPublisher })
  assert.equal(result.published, 1)

  const output = path.join(fixture, "public")
  const page = await fs.readFile(path.join(output, "r", `${RID}.html`), "utf8")
  const homepage = await fs.readFile(path.join(output, "index.html"), "utf8")
  const homepageCss = await fs.readFile(path.join(output, "index.css"), "utf8")
  const raw = await fs.readFile(path.join(output, "raw", `${RID}.md`), "utf8")
  const noJekyll = await fs.readFile(path.join(output, ".nojekyll"), "utf8")
  const contentSha = await fs.readFile(path.join(output, "content-sha.txt"), "utf8")
  const contentIndex = await fs.readFile(path.join(output, "static", "contentIndex.json"), "utf8")
  const files = await listFiles(output)
  const textFiles = files.filter((file) => /\.(?:html|json|js|md|txt)$/i.test(file))
  const publicText = (await Promise.all(textFiles.map((file) => fs.readFile(file, "utf8")))).join("\n")

  assert.equal(await fs.stat(path.join(output, "assets", RID, "图片 空格.png")).then(() => true), true)
  assert.equal(files.some((file) => file.endsWith(path.join("r", RID, "index.html"))), false)
  assert.match(page, /<title>中文公开笔记<\/title>/)
  assert.match(page, /中文公开笔记/)
  assert.match(page, /第一节/)
  assert.match(page, /第二节/)
  assert.match(page, /(?:toc|table-of-contents)/i)
  assert.match(page, new RegExp(`${PROJECT_PATH}/assets/${RID}/%E5%9B%BE%E7%89%87%20%E7%A9%BA%E6%A0%BC\\.png`))
  assert.doesNotMatch(page, /%25E[0-9A-F]{1}/i)
  assert.doesNotMatch(page, /permalink:\s*\/r\//)
  assert.match(raw, new RegExp(`permalink: "?/r/${RID}"?`))
  assert.match(raw, new RegExp(`${PROJECT_PATH}/assets/${RID}/%E5%9B%BE%E7%89%87%20%E7%A9%BA%E6%A0%BC\\.png`))
  assert.match(contentIndex, new RegExp(SEARCH_TERM))
  assert.match(contentIndex, /中文公开笔记/)
  assert.match(contentIndex, /中文标签/)
  assert.doesNotMatch(contentIndex, new RegExp(PRIVATE_SENTINEL))
  assert.doesNotMatch(publicText, new RegExp(PRIVATE_SENTINEL))
  assert.doesNotMatch(publicText, /私人 sentinel\.md/)
  assert.match(homepage, /class="clip-home-hero"/)
  assert.match(homepage, /class="clip-retrieval-rail clip-retrieval-left"/)
  assert.match(homepage, /class="clip-retrieval-rail clip-retrieval-right"/)
  assert.match(homepage, /href="\/web-clips-publish\/tags\/%E4%B8%AD%E6%96%87%E6%A0%87%E7%AD%BE"/)
  assert.match(homepage, /使用顶部搜索/)
  assert.match(homepage, /已收录 1 条公开资源/)
  assert.match(homepage, /<h2 id="all-clips">全部资源/)
  assert.match(homepage, new RegExp(`class="clip-card" href="${PROJECT_PATH}/r/${RID}"`))
  assert.match(homepage, /中文公开笔记/)
  assert.doesNotMatch(homepage, new RegExp(PRIVATE_SENTINEL))
  assert.match(homepageCss, /\.clip-home-hero/)
  assert.match(homepageCss, /\.clip-grid/)
  assert.match(homepageCss, /\.clip-home-layout/)
  assert.match(homepageCss, /body\[data-slug=index\] \.page>#quartz-body\{[^}]*display:block/)
  assert.match(homepageCss, /body\[data-slug=index\] \.page>#quartz-body \.sidebar\.left/)
  assert.equal(files.some((file) => file.includes(".publishing-state")), false)
  assert.equal(files.some((file) => file.endsWith("未引用.png")), false)
  assert.equal(noJekyll, "")
  assert.equal(contentSha, "local\n")
  assert.equal(await fs.stat(path.join(output, "static", "icon.png")).then(() => true), true)
  assert.equal(await fs.stat(path.join(output, "static", "og-image.png")).then(() => true), true)
  const tagFiles = files.filter((file) => {
    const relative = path.relative(output, file)
    return relative.startsWith(`tags${path.sep}`) && relative.endsWith(".html")
  })
  assert.ok(tagFiles.length >= 2)
  const tagText = (await Promise.all(tagFiles.map((file) => fs.readFile(file, "utf8")))).join("\n")
  assert.match(tagText, /中文标签/)
  assert.match(tagText, /中文公开笔记/)
})

test("production quarantine omits notes with unavailable local assets", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "web-clips-quarantine-"))
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }))

  await fs.mkdir(path.join(fixture, "publishing"), { recursive: true })
  const config = JSON.parse(
    await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "publisher.config.json"), "utf8"),
  )
  config.source.root = "."
  config.source.publishAll = false
  config.attachments.allowedLocalRoots = ["assets"]
  await fs.writeFile(path.join(fixture, "publishing", "config.json"), `${JSON.stringify(config, null, 2)}\n`)

  const safeRid = "4cb1ad89-7d36-4fe4-a8e1-1b5fb2c45277"
  const quarantinedRid = "aac8d01d-79d3-46c0-b476-daf19dc1ff5b"
  const quarantinedSentinel = "QUARANTINED_BODY_MUST_NOT_PUBLISH"
  await write(fixture, "完整.md", `---
title: 完整内容
publish: true
rid: ${safeRid}
permalink: /r/${safeRid}
---

# 完整内容

可以安全发布。

[不随站点发布的本地数据](assets/private-data.json)
`)
  await write(fixture, "附件缺失.md", `---
title: 附件缺失内容
publish: true
rid: ${quarantinedRid}
permalink: /r/${quarantinedRid}
---

# 附件缺失内容

${quarantinedSentinel}

![缺失](assets/not-synced.png)
`)

  const validation = await contentPublisher.validate(fixture)
  assert.equal(validation.ok, true)
  assert.equal(validation.publishedCount, 1)
  assert.equal(validation.quarantinedCount, 1)
  assert.equal(validation.diagnostics.some((item) => item.code === "W_NOTE_QUARANTINED"), true)

  const result = await buildSite(fixture, { outputRoot: fixture, publisher: contentPublisher })
  assert.equal(result.published, 1)
  assert.equal(await fs.stat(path.join(fixture, "public", "r", `${safeRid}.html`)).then(() => true), true)
  assert.equal(await fs.access(path.join(fixture, "public", "r", `${quarantinedRid}.html`)).then(() => true, () => false), false)
  const index = await fs.readFile(path.join(fixture, "public", "static", "contentIndex.json"), "utf8")
  assert.doesNotMatch(index, new RegExp(quarantinedSentinel))
  const safePage = await fs.readFile(path.join(fixture, "public", "r", `${safeRid}.html`), "utf8")
  assert.doesNotMatch(safePage, /assets\/private-data\.json/)
})
