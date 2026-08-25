import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildSite } from "./build.mjs"
import * as contentPublisher from "./publisher.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.dirname(HERE)
const CONTENT_REPO_ROOT = process.env.WEB_CLIPS_CONTENT_ROOT
if (!CONTENT_REPO_ROOT) throw new Error("WEB_CLIPS_CONTENT_ROOT is required for site tests")
const SOURCE_CONFIG = path.join(HERE, "publisher.config.json")
const { assignId } = contentPublisher
const RID = "6f6903e3-2b0e-4b66-9d5a-12f0e6b9d62b"
const PRIVATE_SENTINEL = "PRIVATE_MVP_SENTINEL_71f284b5"
const SEARCH_TERM = "中文生命周期验收词"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-clips-mvp-"))
  await fs.mkdir(path.join(root, "publishing"), { recursive: true })
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  const config = JSON.parse(await fs.readFile(SOURCE_CONFIG, "utf8"))
  config.source.root = "."
  config.source.publishAll = false
  config.attachments.allowedLocalRoots = ["assets"]
  config.attachments.localImages.onMissing = "error"
  await fs.writeFile(path.join(root, "publishing", "config.json"), `${JSON.stringify(config, null, 2)}\n`)
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function read(root, relative) {
  return fs.readFile(path.join(root, relative), "utf8")
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function snapshot(root) {
  const result = []
  async function visit(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"))
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(child, childRelative)
      else result.push([childRelative, (await fs.readFile(child)).toString("base64")])
    }
  }
  await visit(root)
  return result
}

async function publishFixture(root) {
  await write(root, "assets/中文 空格.png", PNG)
  await write(root, "assets/未引用.png", PNG)
  await write(
    root,
    "原始 名字.md",
    `---
title: 初始中文标题
publish: false
tags:
  - 生命周期
---

# 初始中文标题

${SEARCH_TERM}

## 第一节

公开正文。

## 第二节

![图片](<assets/中文 空格.png>)
`,
  )
  await write(
    root,
    "永远私有.md",
    `---
title: 私有标题
publish: false
---

${PRIVATE_SENTINEL}
`,
  )
  await assignId(root, "原始 名字.md", { uuid: () => RID, now: () => "2026-01-01T00:00:00.000Z" })
  await write(
    root,
    "原始 名字.md",
    (await read(root, "原始 名字.md")).replace("publish: false", "publish: true"),
  )
  await buildSite(root, { outputRoot: root, publisher: contentPublisher })
}

test("MVP lifecycle keeps RID routes stable and removes all outputs after unpublish", async (t) => {
  const root = await fixture(t)
  await publishFixture(root)

  const output = path.join(root, "public")
  const pagePath = path.join(output, "r", `${RID}.html`)
  const rawPath = path.join(output, "raw", `${RID}.md`)
  const assetPath = path.join(output, "assets", RID, "中文 空格.png")
  const contentIndexPath = path.join(output, "static", "contentIndex.json")

  assert.equal(await exists(pagePath), true)
  assert.equal(await exists(rawPath), true)
  assert.equal(await exists(assetPath), true)
  assert.equal(await exists(path.join(output, "assets", "未引用.png")), false)
  assert.match(await fs.readFile(contentIndexPath, "utf8"), new RegExp(SEARCH_TERM))
  assert.doesNotMatch(await fs.readFile(contentIndexPath, "utf8"), new RegExp(PRIVATE_SENTINEL))

  const priorRaw = await fs.readFile(rawPath)
  await write(root, `public.tmp-${RID}/raw/${RID}.md`, priorRaw)
  await write(root, `public.backup-${RID}/raw/${RID}.md`, priorRaw)
  await fs.mkdir(path.join(root, "移动 后"), { recursive: true })
  await fs.rename(path.join(root, "原始 名字.md"), path.join(root, "移动 后", "新名字.md"))
  const moved = (await read(root, "移动 后/新名字.md"))
    .replaceAll("初始中文标题", "移动后中文标题")
  await write(root, "移动 后/新名字.md", moved)
  await buildSite(root, { outputRoot: root, publisher: contentPublisher })

  assert.equal(await exists(pagePath), true)
  assert.equal(await exists(rawPath), true)
  assert.match(await fs.readFile(pagePath, "utf8"), /移动后中文标题/)
  assert.equal(await exists(path.join(output, "移动 后", "新名字.html")), false)
  assert.equal(await exists(path.join(output, "原始 名字.html")), false)

  await write(
    root,
    "移动 后/新名字.md",
    (await read(root, "移动 后/新名字.md")).replace("publish: true", "publish: false"),
  )
  await buildSite(root, { outputRoot: root, publisher: contentPublisher })

  assert.equal(await exists(pagePath), false)
  assert.equal(await exists(rawPath), false)
  assert.equal(await exists(assetPath), false)
  assert.equal(await exists(path.join(output, "index.html")), true)
  assert.doesNotMatch(await fs.readFile(contentIndexPath, "utf8"), new RegExp(SEARCH_TERM))
})

test("validation failures preserve the last successful public tree", async (t) => {
  const root = await fixture(t)
  await publishFixture(root)
  const publicRoot = path.join(root, "public")
  const goodNote = await read(root, "原始 名字.md")
  const before = await snapshot(publicRoot)

  const cases = [
    {
      name: "missing attachment",
      prepare: async () => {
        await write(root, "原始 名字.md", goodNote.replace("assets/中文 空格.png", "assets/不存在.png"))
      },
      restore: async () => write(root, "原始 名字.md", goodNote),
      pattern: /E_ATTACHMENT_MISSING/,
    },
    {
      name: "permalink drift",
      prepare: async () => {
        await write(root, "原始 名字.md", goodNote.replace(`/r/${RID}`, "/r/not-the-rid"))
      },
      restore: async () => write(root, "原始 名字.md", goodNote),
      pattern: /E_PERMALINK_MISMATCH/,
    },
    {
      name: "directory escape",
      prepare: async () => {
        await write(root, "原始 名字.md", goodNote.replace("assets/中文 空格.png", "../secret.png"))
      },
      restore: async () => write(root, "原始 名字.md", goodNote),
      pattern: /E_ATTACHMENT_ESCAPE/,
    },
    {
      name: "duplicate RID in a private note",
      prepare: async () => write(root, "私有重复.md", goodNote.replace("publish: true", "publish: false")),
      restore: async () => fs.rm(path.join(root, "私有重复.md"), { force: true }),
      pattern: /E_RID_DUPLICATE/,
    },
  ]

  for (const current of cases) {
    await current.prepare()
    await assert.rejects(
      () => buildSite(root, { outputRoot: root, publisher: contentPublisher }),
      current.pattern,
      current.name,
    )
    assert.deepEqual(await snapshot(publicRoot), before, `${current.name} changed public output`)
    await current.restore()
  }
})
