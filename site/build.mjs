import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { slugTag } from "@quartz-community/utils"
import { parse } from "yaml"

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.dirname(SITE_DIR)
const PINNED_PLUGIN_VERSION = "0.1.0"
const RID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
async function loadContentPublisher(contentRoot) {
  const publisherPath = path.join(contentRoot, "publishing", "publisher.mjs")
  if (!(await pathExists(publisherPath))) {
    throw new Error(`Content publisher is missing: ${publisherPath}`)
  }
  return import(`${pathToFileURL(publisherPath).href}?content=${Date.now()}`)
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function assertManagedPath(root, candidate, expectedPrefix) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (!isInside(resolvedRoot, resolved) || !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error(`Refusing unmanaged path: ${expectedPrefix}`)
  }
  return resolved
}

async function pathExists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function rejectSymlink(target, label) {
  if (!(await pathExists(target))) return
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link at ${label}`)
}

async function removeManaged(root, candidate, prefix) {
  const resolved = assertManagedPath(root, candidate, prefix)
  await rejectSymlink(resolved, prefix)
  await fs.rm(resolved, { recursive: true, force: true })
}

async function copyTreeSecure(sourceRoot, destinationRoot) {
  if (!(await pathExists(sourceRoot))) {
    await fs.mkdir(destinationRoot, { recursive: true })
    return
  }

  await rejectSymlink(sourceRoot, "published content root")
  const sourceReal = await fs.realpath(sourceRoot)
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  await fs.mkdir(destinationRoot, { recursive: true })

  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name)
    const destination = path.join(destinationRoot, entry.name)
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink()) throw new Error("Published content must not contain symbolic links")
    const real = await fs.realpath(source)
    if (real !== sourceReal && !isInside(sourceReal, real)) {
      throw new Error("Published content escaped its staging root")
    }
    if (stat.isDirectory()) {
      await copyTreeSecure(source, destination)
    } else if (stat.isFile()) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    } else {
      throw new Error("Published content contains an unsupported filesystem entry")
    }
  }
}

async function copyStagedPages(stageContentRoot, destinationRoot, manifest) {
  await fs.mkdir(path.join(destinationRoot, "r"), { recursive: true })
  for (const resource of manifest.resources) {
    if (!RID_PATTERN.test(resource.rid)) throw new Error("Manifest contains an invalid RID")
    const source = path.join(stageContentRoot, "r", `${resource.rid}.md`)
    const destination = path.join(destinationRoot, "r", `${resource.rid}.md`)
    await rejectSymlink(source, "staged Quartz page")
    if (!(await pathExists(source))) throw new Error(`Missing staged page for ${resource.rid}`)
    await fs.copyFile(source, destination)
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const TOPIC_CLUSTERS = [
  { title: "AI 与编程", tags: ["AI", "Codex", "AI编程", "人工智能"] },
  { title: "学习与认知", tags: ["学习", "学习方法", "知识体系", "思维"] },
  { title: "健康与心理", tags: ["健康", "心理学", "睡眠", "情绪管理"] },
  { title: "学业与职业", tags: ["考研", "就业", "博士", "面试"] },
  { title: "系统与方法", tags: ["系统论", "系统思想", "软件工程", "工作流"] },
]

function tagHref(slug) {
  return `/tags/${String(slug).split("/").map(encodeURIComponent).join("/")}`
}

async function collectPublishedTags(contentRoot, resources) {
  const tagsBySlug = new Map()
  for (const resource of resources) {
    const source = path.join(contentRoot, "r", `${resource.rid}.md`)
    const markdown = await fs.readFile(source, "utf8")
    const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (!frontmatter) continue
    const parsed = parse(frontmatter[1]) ?? {}
    const tags = Array.isArray(parsed.tags) ? parsed.tags : parsed.tags ? [parsed.tags] : []
    for (const value of tags) {
      const tag = String(value).trim()
      if (!tag) continue
      const slug = String(slugTag(tag))
      const current = tagsBySlug.get(slug)
      tagsBySlug.set(slug, {
        slug,
        label: current?.label ?? tag,
        count: (current?.count ?? 0) + 1,
      })
    }
  }
  return tagsBySlug
}

function renderTagLink(tag, className = "clip-tag-link") {
  return `<a class="${className}" href="${tagHref(tag.slug)}"><span>${escapeHtml(tag.label)}</span><small>${tag.count}</small></a>`
}

async function writeSafeIndex(contentRoot, manifest) {
  const resources = []
  for (const resource of manifest.resources) {
    if (!RID_PATTERN.test(resource.rid)) throw new Error("Manifest contains an invalid RID")
    if (typeof resource.title !== "string" || !resource.title.trim()) {
      throw new Error(`Manifest contains an invalid title for ${resource.rid}`)
    }
    const title = resource.title.trim()
    resources.push({ rid: resource.rid, title })
  }
  resources.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"))
  const tagsBySlug = await collectPublishedTags(contentRoot, resources)
  const rankedTags = [...tagsBySlug.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"))
  const repeatedTags = rankedTags.filter((tag) => tag.count > 1)
  const popularTags = (repeatedTags.length >= 6 ? repeatedTags : rankedTags).slice(0, 10)
  const popularTagLinks = popularTags.length > 0
    ? popularTags.map((tag) => renderTagLink(tag)).join("\n")
    : '<p class="clip-rail-empty">标签将在内容增加后出现。</p>'
  const clusters = TOPIC_CLUSTERS.map((cluster) => {
    const tags = cluster.tags
      .map((label) => tagsBySlug.get(String(slugTag(label))))
      .filter(Boolean)
    if (tags.length === 0) return ""
    return `<section class="clip-topic-cluster">
  <h3>${escapeHtml(cluster.title)}</h3>
  <div class="clip-topic-tags">${tags.map((tag) => renderTagLink(tag, "clip-topic-link")).join("\n")}</div>
</section>`
  }).filter(Boolean).join("\n")

  const status = resources.length === 0
    ? "当前暂无公开内容。"
    : `已收录 ${resources.length} 条公开资源，持续从本地剪藏同步更新。`
  const cards = resources.length === 0
    ? '<p class="clip-home-empty">第一条剪藏正在路上。</p>'
    : `<div class="clip-grid">\n${resources
      .map(({ rid, title }) => `<a class="clip-card" href="/r/${rid}">
  <span class="clip-card-title">${escapeHtml(title)}</span>
  <span class="clip-card-action">阅读全文 <span aria-hidden="true">→</span></span>
</a>`)
      .join("\n")}\n</div>`

  const markdown = `---
title: L4P 剪藏馆
description: 一个持续更新、方便检索与引用的个人互联网资源剪藏馆。
---

<div class="clip-home-layout">
<aside class="clip-retrieval-rail clip-retrieval-left" aria-label="快速检索">
  <section class="clip-rail-panel">
    <p class="clip-rail-eyebrow">快速检索</p>
    <h2>从这里开始</h2>
    <p>使用顶部搜索，可检索标题、正文和标签。</p>
    <a class="clip-all-tags" href="/tags">浏览全部标签 <span aria-hidden="true">→</span></a>
  </section>
  <section class="clip-rail-panel">
    <h2>热门标签</h2>
    <div class="clip-tag-stack">${popularTagLinks}</div>
  </section>
</aside>

<main class="clip-home-main">
<section class="clip-home-hero">
  <p class="clip-home-eyebrow">PERSONAL WEB CLIPS</p>
  <p class="clip-home-lede">把散落在互联网上的好内容，整理成随时可检索、可引用的个人资料库。</p>
  <p class="clip-home-status">${escapeHtml(status)}</p>
  <div class="clip-home-actions">
    <a class="clip-home-primary" href="#all-clips">浏览全部</a>
    <a class="clip-home-secondary" href="/tags">按标签浏览</a>
  </div>
  <p class="clip-home-search-hint">使用顶部“搜索”，可以按标题、正文或标签快速定位。</p>
</section>

<h2 id="all-clips">全部资源</h2>

${cards}
</main>

<aside class="clip-retrieval-rail clip-retrieval-right" aria-label="主题聚类">
  <section class="clip-rail-panel">
    <p class="clip-rail-eyebrow">主题聚类</p>
    <h2>按主题发现</h2>
    <p>暂时直接使用现有标签归组，不修改原始元数据。</p>
  </section>
  ${clusters || '<p class="clip-rail-empty">更多主题将在标签积累后出现。</p>'}
</aside>
</div>`
  await fs.writeFile(path.join(contentRoot, "index.md"), markdown, "utf8")
}

function runNode(args, { cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const detail = `${stdout}\n${stderr}`.trim()
        reject(new Error(`${label} failed with exit code ${code}${detail ? `\n${detail}` : ""}`))
      }
    })
  })
}

async function prepareQuartzEngine() {
  const engineRoot = path.join(REPOSITORY_ROOT, "node_modules", "@jackyzha0", "quartz")
  const bootstrap = path.join(engineRoot, "quartz", "bootstrap-cli.mjs")
  if (!(await pathExists(bootstrap))) {
    throw new Error("Pinned Quartz engine is missing; run npm ci first")
  }

  await fs.copyFile(path.join(SITE_DIR, "quartz.config.yaml"), path.join(engineRoot, "quartz.config.yaml"))
  await fs.copyFile(path.join(SITE_DIR, "quartz.lock.json"), path.join(engineRoot, "quartz.lock.json"))
  await fs.copyFile(
    path.join(SITE_DIR, "custom.scss"),
    path.join(engineRoot, "quartz", "styles", "custom.scss"),
  )

  const loaderPath = path.join(engineRoot, "quartz", "plugins", "loader", "gitLoader.ts")
  const loader = await fs.readFile(loaderPath, "utf8")
  const marker = "M4_PINNED_NPM_PLUGIN"
  if (!loader.includes(marker)) {
    const pattern = /    } catch \{\r?\n      \/\/ If git operations fail, re-clone\r?\n    \}/
    if (!pattern.test(loader)) throw new Error("Quartz plugin loader compatibility point changed")
    const compatible = loader.replace(
      pattern,
      `    } catch {
      // ${marker}: package-lock pinned plugin snapshots are valid without nested Git metadata.
      if (
        fs.existsSync(path.join(pluginDir, "package.json")) &&
        fs.existsSync(path.join(pluginDir, "dist"))
      ) {
        return pluginDir
      }
    }`,
    )
    await fs.writeFile(loaderPath, compatible, "utf8")
  }
  return { engineRoot, bootstrap }
}

async function preparePinnedPlugins(engineRoot) {
  const lock = JSON.parse(await fs.readFile(path.join(SITE_DIR, "quartz.lock.json"), "utf8"))
  if (lock?.version !== "1.0.0" || !lock.plugins || typeof lock.plugins !== "object") {
    throw new Error("Quartz plugin lock is invalid")
  }
  const pluginRoot = path.join(engineRoot, ".quartz", "plugins")
  if (!isInside(engineRoot, pluginRoot)) throw new Error("Unsafe Quartz plugin cache path")
  await rejectSymlink(pluginRoot, "Quartz plugin cache")
  await fs.rm(pluginRoot, { recursive: true, force: true })
  await fs.mkdir(pluginRoot, { recursive: true })

  for (const [name, entry] of Object.entries(lock.plugins)) {
    if (
      entry?.source !== `github:quartz-community/${name}` ||
      !/^[0-9a-f]{40}$/.test(entry.commit ?? "")
    ) {
      throw new Error(`Invalid pinned plugin entry: ${name}`)
    }
    const packageRoot = path.join(REPOSITORY_ROOT, "node_modules", "@quartz-community", name)
    const packageJsonPath = path.join(packageRoot, "package.json")
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"))
    if (packageJson.name !== `@quartz-community/${name}` || packageJson.version !== PINNED_PLUGIN_VERSION) {
      throw new Error(`Unexpected pinned plugin package: ${name}`)
    }
    const destination = path.join(pluginRoot, name)
    await fs.mkdir(destination, { recursive: true })
    await fs.copyFile(packageJsonPath, path.join(destination, "package.json"))
    await copyTreeSecure(path.join(packageRoot, "dist"), path.join(destination, "dist"))
  }

  await fs.writeFile(
    path.join(pluginRoot, "index.ts"),
    `export { ContentDetails } from "./content-index"
// Quartz v5.0.0 core imports this optional plugin symbol unconditionally.
export const CustomOgImagesEmitterName = "__disabled_custom_og_images__"
`,
    "utf8",
  )
}

async function copyRawFiles(stageRoot, outputRoot, manifest) {
  const rawRoot = path.join(stageRoot, "raw")
  for (const resource of manifest.resources) {
    if (!RID_PATTERN.test(resource.rid)) throw new Error("Manifest contains an invalid RID")
    const source = path.join(rawRoot, `${resource.rid}.md`)
    const destination = path.join(outputRoot, "raw", `${resource.rid}.md`)
    await rejectSymlink(source, "raw Markdown")
    if (!(await pathExists(source))) throw new Error(`Missing staged raw Markdown for ${resource.rid}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
  }
}

function publicPath(outputRoot, route) {
  const segments = route.replace(/^\/+/, "").split("/").map((segment) => {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Manifest route contains an unsafe segment")
    }
    return decoded
  })
  const relative = segments.join(path.sep)
  const resolved = path.resolve(outputRoot, relative)
  if (!isInside(outputRoot, resolved)) throw new Error("Manifest route escaped public output")
  return resolved
}

async function copyDeclaredAssets(stageContentRoot, outputRoot, manifest) {
  for (const resource of manifest.resources) {
    for (const asset of resource.assets) {
      if (!asset.startsWith(`/assets/${resource.rid}/`)) {
        throw new Error(`Asset route does not belong to ${resource.rid}`)
      }
      const source = publicPath(stageContentRoot, asset)
      const destination = publicPath(outputRoot, asset)
      await rejectSymlink(source, "staged public asset")
      if (!(await pathExists(source))) throw new Error(`Missing staged asset for ${resource.rid}`)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }
  }
}

async function verifyOutput(outputRoot, manifest) {
  if (!(await pathExists(path.join(outputRoot, "index.html")))) {
    throw new Error("Quartz did not generate the empty-safe homepage")
  }
  for (const resource of manifest.resources) {
    const page = path.join(outputRoot, "r", `${resource.rid}.html`)
    const raw = path.join(outputRoot, "raw", `${resource.rid}.md`)
    if (!(await pathExists(page))) throw new Error(`Missing page output for ${resource.rid}`)
    if (!(await pathExists(raw))) throw new Error(`Missing raw output for ${resource.rid}`)
    for (const asset of resource.assets) {
      if (!(await pathExists(publicPath(outputRoot, asset)))) {
        throw new Error(`Missing public asset for ${resource.rid}`)
      }
    }
  }
}

async function configuredBasePath() {
  const config = parse(await fs.readFile(path.join(SITE_DIR, "quartz.config.yaml"), "utf8"))
  const baseUrl = config?.configuration?.baseUrl
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("Quartz baseUrl is required")
  }
  const pathname = new URL(`https://${baseUrl}`).pathname.replace(/\/+$/, "")
  return pathname === "/" ? "" : pathname
}

async function prefixProjectUrls(outputRoot, basePath) {
  if (!basePath) return
  const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".txt", ".xml"])
  const internalRoute = /((?:href|src)=["']|\]\(<?|url\(["']?)\/(r|raw|assets|tags|static)(?=\/|["'#?])/g

  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(target)
      } else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const original = await fs.readFile(target, "utf8")
        const rewritten = original.replace(internalRoute, `$1${basePath}/$2`)
        if (rewritten !== original) await fs.writeFile(target, rewritten, "utf8")
      }
    }
  }

  await visit(outputRoot)
}

async function commitPublicOutput(root, temporaryOutput) {
  const finalOutput = path.join(root, "public")
  const transactionId = randomUUID()
  const backupOutput = path.join(root, `public.backup-${transactionId}`)
  await rejectSymlink(finalOutput, "public output")
  let backedUp = false
  try {
    if (await pathExists(finalOutput)) {
      await fs.rename(finalOutput, backupOutput)
      backedUp = true
    }
    await fs.rename(temporaryOutput, finalOutput)
    if (backedUp) await removeManaged(root, backupOutput, "public.backup-")
  } catch (error) {
    if (await pathExists(finalOutput)) await fs.rm(finalOutput, { recursive: true, force: true })
    if (backedUp && (await pathExists(backupOutput))) await fs.rename(backupOutput, finalOutput)
    throw error
  }
}

export async function buildSite(contentRootInput, options = {}) {
  if (!contentRootInput) throw new Error("Content repository path is required")
  const contentRoot = path.resolve(contentRootInput)
  const outputRoot = path.resolve(options.outputRoot ?? REPOSITORY_ROOT)
  const publisher = options.publisher ?? await loadContentPublisher(contentRoot)
  const transactionId = randomUUID()
  const workRoot = assertManagedPath(
    os.tmpdir(),
    await fs.mkdtemp(path.join(os.tmpdir(), "web-clips-quartz-")),
    "web-clips-quartz-",
  )
  const temporaryOutput = assertManagedPath(
    outputRoot,
    path.join(outputRoot, `public.tmp-${transactionId}`),
    "public.tmp-",
  )
  const stageRoot = path.join(contentRoot, ".publish-stage")

  try {
    const validation = await publisher.validate(contentRoot)
    if (!validation.ok) {
      const codes = [...new Set(validation.diagnostics.map((item) => item.code))].join(", ")
      throw new Error(`Publication validation failed (${codes || "unknown diagnostic"})`)
    }
    const publication = await publisher.build(contentRoot)
    if (!publication.ok || !publication.manifest) {
      const codes = [...new Set((publication.diagnostics ?? []).map((item) => item.code))].join(", ")
      throw new Error(`Publication build failed (${codes || "unknown diagnostic"})`)
    }
    await rejectSymlink(stageRoot, "publication staging root")
    const stagedContent = path.join(stageRoot, "quartz", "content")
    if (await pathExists(stagedContent)) {
      const stageReal = await fs.realpath(stageRoot)
      const contentReal = await fs.realpath(stagedContent)
      if (!isInside(stageReal, contentReal)) throw new Error("Quartz content escaped publication staging")
    }

    const quartzContentRoot = path.join(workRoot, "content")
    await copyStagedPages(stagedContent, quartzContentRoot, publication.manifest)
    await writeSafeIndex(quartzContentRoot, publication.manifest)

    const engine = await prepareQuartzEngine()
    await preparePinnedPlugins(engine.engineRoot)
    const bootstrapRelative = path.relative(engine.engineRoot, engine.bootstrap)
    await runNode(
      [
        bootstrapRelative,
        "build",
        "--directory",
        quartzContentRoot,
        "--output",
        temporaryOutput,
        "--concurrency",
        "1",
      ],
      { cwd: engine.engineRoot, label: "Quartz build" },
    )

    await copyTreeSecure(path.join(engine.engineRoot, "quartz", "static"), path.join(temporaryOutput, "static"))
    await copyRawFiles(stageRoot, temporaryOutput, publication.manifest)
    await copyDeclaredAssets(stagedContent, temporaryOutput, publication.manifest)
    await prefixProjectUrls(temporaryOutput, await configuredBasePath())
    await fs.writeFile(path.join(temporaryOutput, ".nojekyll"), "", "utf8")
    await fs.writeFile(path.join(temporaryOutput, "content-sha.txt"), `${options.contentSha ?? "local"}\n`, "utf8")
    await verifyOutput(temporaryOutput, publication.manifest)
    await commitPublicOutput(outputRoot, temporaryOutput)

    return {
      published: publication.manifest.resources.length,
      output: path.join(outputRoot, "public"),
      routes: publication.manifest.resources.map(({ rid, page, raw, assets }) => ({
        rid,
        page,
        raw,
        assets,
      })),
    }
  } finally {
    if (await pathExists(workRoot)) await removeManaged(os.tmpdir(), workRoot, "web-clips-quartz-")
    if (await pathExists(temporaryOutput)) await removeManaged(outputRoot, temporaryOutput, "public.tmp-")
  }
}

async function main() {
  const contentRoot = process.env.WEB_CLIPS_CONTENT_ROOT
  if (!contentRoot) throw new Error("WEB_CLIPS_CONTENT_ROOT is required")
  const result = await buildSite(contentRoot, {
    outputRoot: REPOSITORY_ROOT,
    contentSha: process.env.WEB_CLIPS_CONTENT_SHA,
  })
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    published: result.published,
    output: "public",
  })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Site build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
