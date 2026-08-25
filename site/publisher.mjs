import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"

const PUBLISHER_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = path.join(PUBLISHER_DIR, "publisher.config.json")
const UTF8_BOM = "\uFEFF"
const RID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDENTITY_CODES = new Set([
  "E_CONFIG_INVALID",
  "E_FRONTMATTER_PARSE",
  "E_RID_INVALID",
  "E_RID_DUPLICATE",
  "E_RID_REUSED",
])

export class PublishError extends Error {
  constructor(message, exitCode, diagnostics = []) {
    super(message)
    this.name = "PublishError"
    this.exitCode = exitCode
    this.diagnostics = diagnostics
  }
}

function diag(code, sourcePath, detail = undefined) {
  const item = { code, level: code.startsWith("W_") ? "warning" : "error" }
  if (sourcePath) item.path = toPosix(sourcePath)
  if (detail !== undefined) item.detail = detail
  return item
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

function fromPosix(value) {
  return value.split("/").join(path.sep)
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalizeRelative(value) {
  return toPosix(path.normalize(value)).replace(/^\.\//, "")
}

function contractExit(config) {
  return config.diagnostics.exitCodes.contractOrUsage
}

function contentExit(config) {
  return config.diagnostics.exitCodes.contentValidation
}

function filesystemExit(config) {
  return config.diagnostics.exitCodes.filesystemOrStaging
}

function hasErrors(diagnostics) {
  return diagnostics.some((item) => item.level === "error")
}

function parseFrontmatter(text, sourcePath) {
  const bom = text.startsWith(UTF8_BOM) ? UTF8_BOM : ""
  const content = bom ? text.slice(1) : text
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n"

  if (!content.startsWith(`---${lineEnding}`) && content !== "---") {
    return {
      bom,
      lineEnding,
      hasFrontmatter: false,
      data: {},
      document: parseDocument("{}"),
      body: content,
      headerStart: -1,
      closingStart: -1,
      closingEnd: -1,
    }
  }

  const closingPattern = new RegExp(`(?:^|${lineEnding === "\r\n" ? "\\r\\n" : "\\n"})(---|\\.\\.\\.)(?:${lineEnding === "\r\n" ? "\\r\\n" : "\\n"}|$)`, "g")
  closingPattern.lastIndex = 3 + lineEnding.length
  const match = closingPattern.exec(content)
  if (!match) {
    throw new PublishError("Unterminated YAML frontmatter", 3, [
      diag("E_FRONTMATTER_PARSE", sourcePath, "unterminated-frontmatter"),
    ])
  }

  const delimiterOffset = match.index + (match[0].startsWith(lineEnding) ? lineEnding.length : 0)
  const closingEnd = match.index + match[0].length
  const yamlText = content.slice(3 + lineEnding.length, delimiterOffset)
  const document = parseDocument(yamlText, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new PublishError("Invalid YAML frontmatter", 3, [
      diag("E_FRONTMATTER_PARSE", sourcePath, document.errors[0].code ?? "yaml-error"),
    ])
  }
  const value = document.toJS()
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new PublishError("Frontmatter must be a mapping", 3, [
      diag("E_FRONTMATTER_PARSE", sourcePath, "frontmatter-not-a-mapping"),
    ])
  }

  return {
    bom,
    lineEnding,
    hasFrontmatter: true,
    data: value ?? {},
    document,
    body: content.slice(closingEnd),
    headerStart: 3 + lineEnding.length,
    closingStart: delimiterOffset,
    closingEnd,
    original: content,
  }
}

function renderDocument(document, body, { bom = "", lineEnding = "\n" } = {}) {
  const yaml = document.toString({ lineWidth: 0 }).replace(/\n/g, lineEnding)
  return `${bom}---${lineEnding}${yaml}---${lineEnding}${body.replace(/^\r?\n/, "")}`
}

function insertFrontmatterFields(text, parsed, fields) {
  const lineEnding = parsed.lineEnding
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  if (!parsed.hasFrontmatter) {
    return `${parsed.bom}---${lineEnding}${lines.join(lineEnding)}${lineEnding}---${lineEnding}${parsed.body}`
  }
  const before = parsed.original.slice(0, parsed.closingStart)
  const separator = before.endsWith(lineEnding) ? "" : lineEnding
  const after = parsed.original.slice(parsed.closingStart)
  return `${parsed.bom}${before}${separator}${lines.join(lineEnding)}${lineEnding}${after}`
}

function setFrontmatterField(text, parsed, key, value) {
  if (!Object.hasOwn(parsed.data, key)) return insertFrontmatterFields(text, parsed, { [key]: value })
  if (parsed.data[key] === value) return text
  const node = parsed.document.get(key, true)
  if (!node?.range || node.range.length < 2) {
    throw new PublishError("Cannot update derived frontmatter field", 3, [
      diag("E_FRONTMATTER_PARSE", key, "field-range-unavailable"),
    ])
  }
  const start = parsed.headerStart + node.range[0]
  const end = parsed.headerStart + node.range[1]
  const content = parsed.original
  return `${parsed.bom}${content.slice(0, start)}${JSON.stringify(value)}${content.slice(end)}`
}

async function readJsonIfExists(file, fallback, invalidCode = "E_CONFIG_INVALID") {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback)
    throw new PublishError(`Cannot parse ${file}`, 2, [
      diag(invalidCode, path.basename(file), error instanceof SyntaxError ? "invalid-json" : error.code),
    ])
  }
}

function validateConfig(config) {
  const problems = []
  if (config.contractVersion !== 1) problems.push("contractVersion")
  if (
    typeof config.source?.root !== "string" ||
    config.source.root.trim() === "" ||
    path.isAbsolute(config.source.root) ||
    normalizeRelative(config.source.root).startsWith("../")
  ) {
    problems.push("source.root")
  }
  if (typeof config.source?.publishAll !== "boolean") problems.push("source.publishAll")
  if (config.frontmatter?.publishedValueType !== "boolean" || config.frontmatter?.publishedValue !== true) {
    problems.push("frontmatter.publish")
  }
  if (typeof config.frontmatter?.publicUrlField !== "string" || config.frontmatter.publicUrlField.trim() === "") {
    problems.push("frontmatter.publicUrlField")
  }
  if (config.rid?.pattern !== RID_PATTERN.source || config.rid?.format !== "uuid-v4") {
    problems.push("rid")
  }
  if (config.routes?.pagePattern !== "/r/{rid}" || config.routes?.rawPattern !== "/raw/{rid}.md") {
    problems.push("routes")
  }
  try {
    const publicBaseUrl = new URL(config.routes?.publicBaseUrl)
    if (
      publicBaseUrl.protocol !== "https:" ||
      publicBaseUrl.username ||
      publicBaseUrl.password ||
      publicBaseUrl.search ||
      publicBaseUrl.hash ||
      (publicBaseUrl.pathname !== "/" && publicBaseUrl.pathname.endsWith("/")) ||
      `${publicBaseUrl.origin}${publicBaseUrl.pathname === "/" ? "" : publicBaseUrl.pathname}` !== config.routes.publicBaseUrl
    ) {
      problems.push("routes.publicBaseUrl")
    }
  } catch {
    problems.push("routes.publicBaseUrl")
  }
  if (config.state?.registry !== "publishing/registry.json") problems.push("registry")
  if (config.state?.manifest !== "publishing/manifest.json") problems.push("manifest")
  if (config.staging?.root !== ".publish-stage") problems.push("staging.root")
  if (config.features?.pdf !== false || config.features?.oss !== false) problems.push("features")
  if (!Array.isArray(config.attachments?.allowedLocalRoots) || config.attachments.allowedLocalRoots.length === 0) {
    problems.push("attachments.allowedLocalRoots")
  }
  if (!["error", "quarantine"].includes(config.attachments?.localImages?.onMissing)) {
    problems.push("attachments.localImages.onMissing")
  }
  const expectedCodes = [
    "E_CONFIG_INVALID",
    "E_FRONTMATTER_PARSE",
    "E_PUBLISH_TYPE",
    "E_RID_MISSING",
    "E_RID_INVALID",
    "E_RID_DUPLICATE",
    "E_RID_REUSED",
    "E_PERMALINK_MISSING",
    "E_PERMALINK_MISMATCH",
    "E_ATTACHMENT_MISSING",
    "E_ATTACHMENT_ESCAPE",
    "E_ATTACHMENT_TYPE",
    "E_ATTACHMENT_AMBIGUOUS",
    "E_PRIVATE_EMBED",
    "E_FEATURE_DISABLED",
  ]
  for (const code of expectedCodes) {
    if (!config.diagnostics?.errors?.includes(code)) problems.push(`diagnostics.${code}`)
  }
  if (problems.length > 0) {
    throw new PublishError("Publishing configuration violates contract v1", 2, [
      diag("E_CONFIG_INVALID", "publishing/config.json", problems),
    ])
  }
}

export async function loadConfig(root) {
  const configPath = path.join(root, "publishing", "config.json")
  const config = await readJsonIfExists(configPath, null) ?? await readJsonIfExists(DEFAULT_CONFIG_PATH, null)
  if (!config) throw new PublishError("Missing publisher configuration", 2, [
    diag("E_CONFIG_INVALID", "site/publisher.config.json", "missing"),
  ])
  validateConfig(config)
  return config
}

function excludedDirectory(config, relativePath) {
  const posix = toPosix(relativePath)
  return config.source.exclude.some((pattern) => {
    if (pattern.endsWith("*/**")) {
      const prefix = pattern.slice(0, -4)
      return posix.startsWith(prefix)
    }
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3)
      return posix === prefix || posix.startsWith(`${prefix}/`)
    }
    return posix === pattern
  })
}

async function walkMarkdown(root, config) {
  const found = []
  const sourceRelative = normalizeRelative(config.source.root)
  const sourceRoot = path.resolve(root, fromPosix(sourceRelative))
  if (!isWithin(root, sourceRoot)) {
    throw new PublishError("Source root escapes the workspace", contractExit(config), [
      diag("E_CONFIG_INVALID", "publishing/config.json", "unsafe-source-root"),
    ])
  }
  try {
    const stat = await fs.lstat(sourceRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PublishError("Source root must be a real directory", contractExit(config), [
        diag("E_CONFIG_INVALID", sourceRelative, "invalid-source-root"),
      ])
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new PublishError("Configured source root is missing", contractExit(config), [
        diag("E_CONFIG_INVALID", sourceRelative, "missing-source-root"),
      ])
    }
    throw error
  }
  async function visit(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"))
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!excludedDirectory(config, relative)) {
          await visit(path.join(directory, entry.name), relative)
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !excludedDirectory(config, relative)) {
        found.push(normalizeRelative(relative))
      }
    }
  }
  await visit(sourceRoot, sourceRelative)
  return found
}

function insideConfiguredSource(config, relativePath) {
  const sourceRelative = normalizeRelative(config.source.root)
  if (sourceRelative === ".") return true
  return relativePath === sourceRelative || relativePath.startsWith(`${sourceRelative}/`)
}

async function scanNotes(root, config) {
  const diagnostics = []
  const notes = []
  for (const relativePath of await walkMarkdown(root, config)) {
    const absolutePath = path.join(root, fromPosix(relativePath))
    const text = await fs.readFile(absolutePath, "utf8")
    let parsed
    try {
      parsed = parseFrontmatter(text, relativePath)
    } catch (error) {
      if (error instanceof PublishError) {
        diagnostics.push(...error.diagnostics)
        notes.push({ relativePath, absolutePath, text, parsed: null, data: {}, published: false })
        continue
      }
      throw error
    }
    const data = parsed.data
    const publishField = config.frontmatter.publishField
    const hasPublish = Object.hasOwn(data, publishField)
    if (!config.source.publishAll && hasPublish && typeof data[publishField] !== "boolean") {
      diagnostics.push(diag("E_PUBLISH_TYPE", relativePath, typeof data[publishField]))
    }
    const published =
      config.source.publishAll ||
      (data[publishField] === true && typeof data[publishField] === "boolean")
    const rid = data[config.frontmatter.ridField]
    const permalink = data[config.frontmatter.permalinkField]
    if (rid !== undefined && (typeof rid !== "string" || !RID_PATTERN.test(rid))) {
      diagnostics.push(diag("E_RID_INVALID", relativePath, typeof rid === "string" ? rid : typeof rid))
    } else if (
      typeof rid === "string" &&
      permalink !== undefined &&
      permalink !== config.routes.pagePattern.replace("{rid}", rid)
    ) {
      diagnostics.push(
        diag("E_PERMALINK_MISMATCH", relativePath, {
          expected: config.routes.pagePattern.replace("{rid}", rid),
        }),
      )
    }
    notes.push({
      relativePath,
      absolutePath,
      text,
      parsed,
      data,
      published,
      rid: typeof rid === "string" ? rid : undefined,
      permalink,
    })
  }

  const byRid = new Map()
  for (const note of notes) {
    if (!note.rid || !RID_PATTERN.test(note.rid)) continue
    const group = byRid.get(note.rid) ?? []
    group.push(note)
    byRid.set(note.rid, group)
  }
  for (const [rid, group] of byRid) {
    if (group.length > 1) {
      diagnostics.push(diag("E_RID_DUPLICATE", undefined, {
        rid,
        paths: group.map((note) => note.relativePath).sort(),
      }))
    }
  }
  return { notes, diagnostics, byRid }
}

function emptyRegistry() {
  return { version: 1, resources: {}, events: [] }
}

function emptyManifest() {
  return { version: 1, generatedAt: null, resources: [] }
}

async function loadState(root, config) {
  const registryPath = path.join(root, fromPosix(config.state.registry))
  const manifestPath = path.join(root, fromPosix(config.state.manifest))
  const journalPath = path.join(root, "publishing", ".publish-transaction.json")
  if (await pathExists(journalPath)) {
    throw new PublishError("An incomplete publishing transaction requires recovery", 4, [
      diag("E_CONFIG_INVALID", "publishing/.publish-transaction.json", "incomplete-transaction"),
    ])
  }
  const registry = await readJsonIfExists(registryPath, emptyRegistry())
  const manifest = await readJsonIfExists(manifestPath, emptyManifest())
  if (
    registry?.version !== 1 ||
    typeof registry.resources !== "object" ||
    registry.resources === null ||
    Array.isArray(registry.resources) ||
    manifest?.version !== 1 ||
    !Array.isArray(manifest.resources)
  ) {
    throw new PublishError("Invalid publishing state", contractExit(config), [
      diag("E_CONFIG_INVALID", "publishing", "invalid-state-schema"),
    ])
  }
  if (!Array.isArray(registry.events)) registry.events = []
  return { registry, manifest, registryPath, manifestPath }
}

function validateIdentityAgainstRegistry(scan, registry) {
  const diagnostics = []
  const noteByPath = new Map(scan.notes.map((note) => [note.relativePath, note]))
  for (const [rid, group] of scan.byRid) {
    const entry = registry.resources[rid]
    // The content repository is intentionally document-only. Existing frontmatter
    // is authoritative when no legacy registry entry exists; duplicate RIDs are
    // still rejected by scanNotes before this check.
    if (!entry) continue
    if (entry.status === "retired") {
      diagnostics.push(diag("E_RID_REUSED", group[0].relativePath, { rid, reason: "retired" }))
      continue
    }
    if (group.length === 1 && entry.lastKnownSourcePath && entry.lastKnownSourcePath !== group[0].relativePath) {
      const previous = noteByPath.get(entry.lastKnownSourcePath)
      if (previous && previous.rid !== rid) {
        diagnostics.push(
          diag("E_RID_REUSED", group[0].relativePath, {
            rid,
            reason: "previous-owner-still-exists",
            previousPath: entry.lastKnownSourcePath,
          }),
        )
      }
    }
  }
  for (const [rid, entry] of Object.entries(registry.resources)) {
    if (!RID_PATTERN.test(rid) || !["active", "retired"].includes(entry.status)) {
      diagnostics.push(diag("E_CONFIG_INVALID", configPathForState(), { rid, reason: "invalid-registry-entry" }))
    }
  }
  return diagnostics
}

function configPathForState() {
  return "publishing/registry.json"
}

function stripQueryAndFragment(rawTarget) {
  let target = rawTarget
  let suffix = ""
  const query = target.search(/[?#]/)
  if (query >= 0) {
    suffix = target.slice(query)
    target = target.slice(0, query)
  }
  return { target, suffix }
}

function decodeLocalTarget(rawTarget) {
  let target = rawTarget.trim()
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1)
  const separated = stripQueryAndFragment(target)
  try {
    target = decodeURIComponent(separated.target)
  } catch {
    return { error: "invalid-url-encoding" }
  }
  return { target, suffix: separated.suffix }
}

function remoteScheme(target) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)
  return match ? match[1].toLowerCase() : null
}

async function exactPathStatus(root, relativePath) {
  const segments = normalizeRelative(relativePath).split("/").filter(Boolean)
  let current = root
  for (const segment of segments) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
      throw error
    })
    if (!entries) return { kind: "missing" }
    const exact = entries.filter((entry) => entry.name === segment)
    if (exact.length !== 1) {
      const folded = entries.filter((entry) => entry.name.toLowerCase() === segment.toLowerCase())
      return folded.length > 0 ? { kind: "ambiguous" } : { kind: "missing" }
    }
    const entry = exact[0]
    if (entry.isSymbolicLink()) return { kind: "escape" }
    current = path.join(current, segment)
  }
  return { kind: "ok", absolutePath: current }
}

async function findByBasename(root, allowedRoots, basename) {
  const matches = []
  async function visit(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), childRelative)
      else if (entry.isFile() && entry.name === basename) matches.push(childRelative)
    }
  }
  for (const allowed of allowedRoots) {
    await visit(path.join(root, fromPosix(allowed)), allowed)
  }
  return matches
}

function expectedImageType(extension) {
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg"
  return extension.slice(1)
}

async function detectImageType(file) {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(32)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif"
    if (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "webp"
    if (
      bytes.length >= 12 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))
    ) return "avif"
    return null
  } finally {
    await handle.close()
  }
}

function encodePublicPath(relativePath) {
  return relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/")
}

async function resolveAttachment(root, config, note, rawTarget) {
  let schemeTarget = rawTarget.trim()
  if (schemeTarget.startsWith("<") && schemeTarget.endsWith(">")) schemeTarget = schemeTarget.slice(1, -1)
  const initialScheme = remoteScheme(schemeTarget)
  if (initialScheme === "http" || initialScheme === "https") {
    return {
      remote: true,
      rewritten: rawTarget,
      diagnostic: diag("W_REMOTE_ASSET", note.relativePath, { url: rawTarget }),
    }
  }
  const decoded = decodeLocalTarget(rawTarget)
  if (decoded.error) {
    return { diagnostic: diag("E_ATTACHMENT_MISSING", note.relativePath, decoded.error) }
  }
  const scheme = remoteScheme(decoded.target)
  if (scheme || decoded.target.startsWith("/") || decoded.target.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(decoded.target)) {
    return { diagnostic: diag("E_ATTACHMENT_ESCAPE", note.relativePath, { target: rawTarget }) }
  }

  const slashTarget = decoded.target.replaceAll("\\", "/")
  const allowedRoots = config.attachments.allowedLocalRoots.map((item) => item.replace(/\/+$/, ""))
  let candidate
  if (allowedRoots.some((allowed) => slashTarget === allowed || slashTarget.startsWith(`${allowed}/`))) {
    candidate = normalizeRelative(slashTarget)
  } else {
    candidate = normalizeRelative(path.join(path.dirname(fromPosix(note.relativePath)), fromPosix(slashTarget)))
  }
  let allowedRoot = allowedRoots.find((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`))

  if (!allowedRoot && !slashTarget.includes("/") && !slashTarget.includes("\\")) {
    const matches = await findByBasename(root, allowedRoots, slashTarget)
    if (matches.length > 1) {
      return { diagnostic: diag("E_ATTACHMENT_AMBIGUOUS", note.relativePath, { target: rawTarget }) }
    }
    if (matches.length === 1) {
      candidate = matches[0]
      allowedRoot = allowedRoots.find((allowed) => candidate.startsWith(`${allowed}/`))
    }
  }
  if (!allowedRoot) {
    return { diagnostic: diag("E_ATTACHMENT_ESCAPE", note.relativePath, { target: rawTarget }) }
  }

  const status = await exactPathStatus(root, candidate)
  if (status.kind === "ambiguous") {
    return { diagnostic: diag("E_ATTACHMENT_AMBIGUOUS", note.relativePath, { target: rawTarget }) }
  }
  if (status.kind === "escape") {
    return { diagnostic: diag("E_ATTACHMENT_ESCAPE", note.relativePath, { target: rawTarget }) }
  }
  if (status.kind !== "ok") {
    return { diagnostic: diag("E_ATTACHMENT_MISSING", note.relativePath, { target: rawTarget }) }
  }

  const allowedAbsolute = path.resolve(root, fromPosix(allowedRoot))
  const realAllowed = await fs.realpath(allowedAbsolute)
  const realFile = await fs.realpath(status.absolutePath)
  if (!isWithin(realAllowed, realFile)) {
    return { diagnostic: diag("E_ATTACHMENT_ESCAPE", note.relativePath, { target: rawTarget }) }
  }
  const stat = await fs.stat(realFile)
  if (!stat.isFile()) {
    return { diagnostic: diag("E_ATTACHMENT_TYPE", note.relativePath, { target: rawTarget, reason: "not-file" }) }
  }
  const extension = path.extname(realFile).toLowerCase()
  if (!config.attachments.localImages.extensions.includes(extension)) {
    return { diagnostic: diag("E_ATTACHMENT_TYPE", note.relativePath, { target: rawTarget, extension }) }
  }
  const actualType = await detectImageType(realFile)
  if (actualType !== expectedImageType(extension)) {
    return {
      diagnostic: diag("E_ATTACHMENT_TYPE", note.relativePath, {
        target: rawTarget,
        extension,
        detected: actualType,
      }),
    }
  }

  // Compare canonical paths on platforms where a temporary directory may be
  // reached through an alias (for example /var -> /private/var on macOS).
  const assetPath = toPosix(path.relative(realAllowed, realFile))
  const rewritten = `/assets/${note.rid}/${encodePublicPath(assetPath)}${decoded.suffix}`
  return {
    remote: false,
    sourcePath: realFile,
    sourceRelativePath: candidate,
    assetPath,
    rewritten,
  }
}

function parseMarkdownDestination(group) {
  const leading = group.match(/^\s*/)?.[0].length ?? 0
  let value = group.slice(leading).trimEnd()
  let offset = leading
  if (value.startsWith("<")) {
    const end = value.indexOf(">")
    if (end > 0) return { target: value.slice(1, end), offset: offset + 1, length: end - 1 }
  }
  const titleMatch = /^(.*?)(?:\s+["'][^"']*["'])$/.exec(value)
  if (titleMatch) value = titleMatch[1].trimEnd()
  return { target: value, offset, length: value.length }
}

function collectMarkupReferences(body) {
  const references = []
  function add(start, end, target, kind) {
    if (references.some((item) => start < item.end && end > item.start)) return
    references.push({ start, end, target, kind })
  }

  for (const match of body.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
    const raw = match[1]
    const target = raw.split("|", 1)[0].trim()
    const offset = match[0].indexOf(raw)
    add(match.index + offset, match.index + offset + target.length, target, "obsidian-embed")
  }
  for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const offset = match[0].indexOf(match[2])
    add(match.index + offset, match.index + offset + match[2].length, match[2], "html-image")
  }
  for (const match of body.matchAll(/!\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const parsed = parseMarkdownDestination(match[1])
    const groupOffset = match[0].indexOf(match[1])
    add(
      match.index + groupOffset + parsed.offset,
      match.index + groupOffset + parsed.offset + parsed.length,
      parsed.target,
      "image",
    )
  }
  for (const match of body.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    if (match.index > 0 && body[match.index - 1] === "!") continue
    const parsed = parseMarkdownDestination(match[2])
    const groupOffset = match[0].lastIndexOf(match[2])
    add(
      match.index + groupOffset + parsed.offset,
      match.index + groupOffset + parsed.offset + parsed.length,
      parsed.target,
      "link",
    )
  }
  for (const match of body.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)) {
    const raw = match[1]
    const [target, alias] = raw.split("|", 2)
    add(match.index, match.index + match[0].length, target.trim(), "obsidian-link")
    references.at(-1).replacementText = alias?.trim() || path.basename(target.trim(), path.extname(target.trim()))
  }
  return references.sort((a, b) => a.start - b.start)
}

function localExtension(target) {
  const decoded = decodeLocalTarget(target)
  if (decoded.error) return ""
  return path.extname(decoded.target).toLowerCase()
}

function firstHeadingTitle(body) {
  let fence
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = undefined
      continue
    }
    if (fence) continue
    const heading = /^#(?!#)\s+(.+?)\s*#*\s*$/.exec(line.trim())
    if (heading?.[1]?.trim()) return heading[1].trim()
  }
  return undefined
}

function displayTitle(note) {
  if (typeof note.data.title === "string" && note.data.title.trim()) {
    return note.data.title.trim()
  }
  const heading = firstHeadingTitle(note.parsed.body)
  if (heading) return heading
  return path.posix.basename(note.relativePath, path.posix.extname(note.relativePath))
}

async function processPublishedNote(root, config, note, publishedByPath) {
  const diagnostics = []
  const assets = new Map()
  const replacements = []
  const references = collectMarkupReferences(note.parsed.body)
  const htmlImageCount = [...note.parsed.body.matchAll(/<img\b/gi)].length
  const parsedHtmlImageCount = references.filter((reference) => reference.kind === "html-image").length
  if (htmlImageCount > parsedHtmlImageCount) {
    diagnostics.push(diag("E_ATTACHMENT_TYPE", note.relativePath, { reason: "unparseable-html-image" }))
  }

  for (const reference of references) {
    if (reference.kind === "obsidian-link") {
      diagnostics.push(diag("W_PRIVATE_LINK", note.relativePath, { kind: "obsidian-note-link" }))
      replacements.push({ ...reference, rewritten: reference.replacementText })
      continue
    }
    let schemeTarget = reference.target.trim()
    if (schemeTarget.startsWith("<") && schemeTarget.endsWith(">")) {
      schemeTarget = schemeTarget.slice(1, -1)
    }
    if (reference.kind === "link" && remoteScheme(schemeTarget)) {
      continue
    }
    const extension = localExtension(reference.target)
    if (reference.kind === "link" && extension === ".md") {
      const decoded = decodeLocalTarget(reference.target)
      const candidate = normalizeRelative(
        path.join(path.dirname(fromPosix(note.relativePath)), fromPosix(decoded.target)),
      )
      const publishedTarget = publishedByPath.get(candidate)
      if (publishedTarget) {
        replacements.push({ ...reference, rewritten: `/r/${publishedTarget.rid}` })
      } else {
        diagnostics.push(diag("W_PRIVATE_LINK", note.relativePath, { kind: "markdown-note-link" }))
        replacements.push({ ...reference, rewritten: "#" })
      }
      continue
    }
    if (reference.kind === "link") {
      const decoded = decodeLocalTarget(reference.target)
      if (!decoded.error) {
        const candidate = normalizeRelative(
          path.join(path.dirname(fromPosix(note.relativePath)), fromPosix(decoded.target)),
        )
        const localAssetLink = config.attachments.allowedLocalRoots.some(
          (allowed) => candidate === allowed || candidate.startsWith(`${allowed.replace(/\/+$/, "")}/`),
        )
        if (localAssetLink) {
          diagnostics.push(diag("W_PRIVATE_LINK", note.relativePath, { kind: "unpublished-local-asset" }))
          replacements.push({ ...reference, rewritten: "#" })
          continue
        }
      }
    }
    if (extension === ".pdf") {
      diagnostics.push(diag("E_FEATURE_DISABLED", note.relativePath, { feature: "pdf" }))
      continue
    }
    if (reference.kind === "link" && !config.attachments.localImages.extensions.includes(extension)) {
      continue
    }
    if (reference.kind === "obsidian-embed" && !config.attachments.localImages.extensions.includes(extension)) {
      diagnostics.push(diag("E_PRIVATE_EMBED", note.relativePath, { target: reference.target }))
      continue
    }
    const resolved = await resolveAttachment(root, config, note, reference.target)
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic)
    if (resolved.rewritten) replacements.push({ ...reference, rewritten: resolved.rewritten })
    if (resolved.sourcePath) assets.set(resolved.sourceRelativePath, resolved)
  }

  const coverField = config.attachments.localImages.frontmatterFields[0]
  const pageDocument = note.parsed.document.clone()
  const rawDocument = note.parsed.document.clone()
  if (Object.hasOwn(note.data, coverField)) {
    if (typeof note.data[coverField] !== "string") {
      diagnostics.push(diag("E_ATTACHMENT_TYPE", note.relativePath, { field: coverField, reason: "not-string" }))
    } else {
      const resolved = await resolveAttachment(root, config, note, note.data[coverField])
      if (resolved.diagnostic) diagnostics.push(resolved.diagnostic)
      if (resolved.rewritten) {
        pageDocument.set(coverField, resolved.rewritten)
        rawDocument.set(coverField, resolved.rewritten)
      }
      if (resolved.sourcePath) assets.set(resolved.sourceRelativePath, resolved)
    }
  }
  if (Object.hasOwn(note.data, config.frontmatter.pdfField)) {
    diagnostics.push(diag("E_FEATURE_DISABLED", note.relativePath, { feature: "pdf" }))
  }
  const title = displayTitle(note)
  pageDocument.set("title", title)
  for (const field of config.quartzAdapter.stripFrontmatterFields) pageDocument.delete(field)

  let rewrittenBody = note.parsed.body
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewrittenBody =
      rewrittenBody.slice(0, replacement.start) + replacement.rewritten + rewrittenBody.slice(replacement.end)
  }
  return {
    diagnostics,
    title,
    assets: [...assets.values()].sort((a, b) => a.assetPath.localeCompare(b.assetPath, "en")),
    pageText: renderDocument(pageDocument, rewrittenBody, note.parsed),
    rawText: renderDocument(rawDocument, rewrittenBody, note.parsed),
  }
}

function validatePublishedIdentity(config, note) {
  const diagnostics = []
  if (!note.rid) diagnostics.push(diag("E_RID_MISSING", note.relativePath))
  else if (!RID_PATTERN.test(note.rid)) diagnostics.push(diag("E_RID_INVALID", note.relativePath, note.rid))
  if (note.permalink === undefined) diagnostics.push(diag("E_PERMALINK_MISSING", note.relativePath))
  return diagnostics
}

export async function analyzeWorkspace(rootInput, { includeRendered = false } = {}) {
  const root = path.resolve(rootInput)
  const config = await loadConfig(root)
  const state = await loadState(root, config)
  const scan = await scanNotes(root, config)
  const diagnostics = [...scan.diagnostics, ...validateIdentityAgainstRegistry(scan, state.registry)]
  const published = scan.notes.filter((note) => note.published)
  for (const note of published) diagnostics.push(...validatePublishedIdentity(config, note))

  const publishedByPath = new Map(published.map((note) => [note.relativePath, note]))
  let rendered = []
  if (!hasErrors(diagnostics)) {
    for (const note of published) {
      const result = await processPublishedNote(root, config, note, publishedByPath)
      rendered.push({ note, ...result })
    }
    if (config.attachments.localImages.onMissing === "quarantine") {
      const quarantined = rendered.filter((item) => {
        const errors = item.diagnostics.filter((diagnostic) => diagnostic.level === "error")
        return errors.length > 0 && errors.every((diagnostic) => diagnostic.code === "E_ATTACHMENT_MISSING")
      })
      const quarantinedPaths = new Set(quarantined.map((item) => item.note.relativePath))
      for (const item of quarantined) {
        diagnostics.push(...item.diagnostics.filter((diagnostic) => diagnostic.level === "warning"))
        diagnostics.push(diag("W_NOTE_QUARANTINED", item.note.relativePath, {
          reason: "missing-local-assets",
          missingCount: item.diagnostics.filter((diagnostic) => diagnostic.code === "E_ATTACHMENT_MISSING").length,
        }))
      }
      if (quarantinedPaths.size > 0) {
        const safeNotes = published.filter((note) => !quarantinedPaths.has(note.relativePath))
        const safeByPath = new Map(safeNotes.map((note) => [note.relativePath, note]))
        rendered = []
        for (const note of safeNotes) {
          const result = await processPublishedNote(root, config, note, safeByPath)
          diagnostics.push(...result.diagnostics)
          rendered.push({ note, ...result })
        }
      } else {
        for (const item of rendered) diagnostics.push(...item.diagnostics)
      }
    } else {
      for (const item of rendered) diagnostics.push(...item.diagnostics)
    }
  }
  return { root, config, state, scan, published, diagnostics, rendered: includeRendered ? rendered : rendered }
}

function diagnosticSummary(analysis) {
  const quarantinedCount = analysis.diagnostics.filter((item) => item.code === "W_NOTE_QUARANTINED").length
  return {
    notesScanned: analysis.scan.notes.length,
    candidateCount: analysis.published.length,
    publishedCount: analysis.rendered.length,
    quarantinedCount,
    warningCount: analysis.diagnostics.filter((item) => item.level === "warning").length,
    errorCount: analysis.diagnostics.filter((item) => item.level === "error").length,
    diagnostics: analysis.diagnostics,
  }
}

export async function validate(root) {
  const analysis = await analyzeWorkspace(root)
  const summary = diagnosticSummary(analysis)
  return {
    ok: summary.errorCount === 0,
    command: "validate",
    ...summary,
    exitCode: summary.errorCount === 0 ? 0 : contentExit(analysis.config),
  }
}

function substitute(pattern, values) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), pattern)
}

function nextRegistryForBuild(analysis, timestamp) {
  const next = structuredClone(analysis.state.registry)
  const noteByRid = new Map(
    analysis.scan.notes
      .filter((note) => note.rid && RID_PATTERN.test(note.rid))
      .map((note) => [note.rid, note]),
  )
  for (const [rid, entry] of Object.entries(next.resources)) {
    const note = noteByRid.get(rid)
    if (!note) {
      if (entry.status === "active") {
        entry.status = "retired"
        entry.retiredAt = timestamp
        entry.retiredReason = "source-deleted"
        next.events.push({ type: "retired", rid, at: timestamp, reason: "source-deleted" })
      }
      continue
    }
    if (entry.lastKnownSourcePath !== note.relativePath) {
      next.events.push({
        type: "moved",
        rid,
        at: timestamp,
        from: entry.lastKnownSourcePath,
        to: note.relativePath,
      })
    }
    entry.lastKnownSourcePath = note.relativePath
    if (note.published) {
      if (!entry.everPublished) {
        entry.everPublished = true
        entry.firstPublishedAt = timestamp
        next.events.push({ type: "published", rid, at: timestamp, sourcePath: note.relativePath })
      }
    } else if (entry.everPublished && entry.status === "active") {
      entry.status = "retired"
      entry.retiredAt = timestamp
      entry.retiredReason = "unpublished"
      next.events.push({ type: "retired", rid, at: timestamp, reason: "unpublished" })
    }
  }
  return next
}

function buildManifest(analysis, timestamp) {
  const resources = analysis.rendered.map((item) => {
    const rid = item.note.rid
    return {
      rid,
      title: item.title,
      sourcePath: item.note.relativePath,
      page: analysis.config.routes.pagePattern.replace("{rid}", rid),
      raw: analysis.config.routes.rawPattern.replace("{rid}", rid),
      assets: item.assets.map((asset) => `/assets/${rid}/${encodePublicPath(asset.assetPath)}`),
      artifacts: [
        substitute(analysis.config.staging.quartzContentPattern, { rid }),
        substitute(analysis.config.staging.rawPattern, { rid }),
        ...item.assets.map((asset) =>
          substitute(analysis.config.staging.assetPattern, { rid, assetPath: asset.assetPath }),
        ),
      ].sort(),
    }
  })
  resources.sort((a, b) => a.rid.localeCompare(b.rid, "en"))
  return { version: 1, generatedAt: timestamp, resources }
}

function planBuild(analysis) {
  const previous = new Set(analysis.state.manifest.resources.map((item) => item.rid))
  const current = new Set(analysis.rendered.map((item) => item.note.rid))
  const retired = [...previous].filter((rid) => !current.has(rid)).sort()
  const removedArtifacts = analysis.state.manifest.resources
    .filter((item) => retired.includes(item.rid))
    .flatMap((item) => item.artifacts ?? [])
    .sort()
  return {
    published: analysis.rendered.map((item) => ({
      rid: item.note.rid,
      sourcePath: item.note.relativePath,
      page: analysis.config.routes.pagePattern.replace("{rid}", item.note.rid),
      raw: analysis.config.routes.rawPattern.replace("{rid}", item.note.rid),
      assets: item.assets.map((asset) => asset.sourceRelativePath),
    })),
    retired,
    removedArtifacts,
  }
}

async function writeStage(analysis, temporaryRoot, manifest, registry) {
  await fs.mkdir(temporaryRoot, { recursive: true })
  for (const item of analysis.rendered) {
    const rid = item.note.rid
    const pageRelative = substitute(analysis.config.staging.quartzContentPattern, { rid })
    const rawRelative = substitute(analysis.config.staging.rawPattern, { rid })
    const pageTarget = path.join(temporaryRoot, fromPosix(pageRelative))
    const rawTarget = path.join(temporaryRoot, fromPosix(rawRelative))
    await fs.mkdir(path.dirname(pageTarget), { recursive: true })
    await fs.mkdir(path.dirname(rawTarget), { recursive: true })
    await fs.writeFile(pageTarget, item.pageText, "utf8")
    await fs.writeFile(rawTarget, item.rawText, "utf8")
    for (const asset of item.assets) {
      const assetRelative = substitute(analysis.config.staging.assetPattern, {
        rid,
        assetPath: asset.assetPath,
      })
      const assetTarget = path.join(temporaryRoot, fromPosix(assetRelative))
      await fs.mkdir(path.dirname(assetTarget), { recursive: true })
      await fs.copyFile(asset.sourcePath, assetTarget)
    }
  }
  const stateRoot = path.join(temporaryRoot, ".publishing-state")
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.writeFile(path.join(stateRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await fs.writeFile(path.join(stateRoot, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8")
}

async function removeIfExists(target) {
  await fs.rm(target, { recursive: true, force: true })
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function replaceFileWithBackup(target, content, transactionId) {
  const temporary = `${target}.tmp-${transactionId}`
  const backup = `${target}.backup-${transactionId}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(temporary, content, "utf8")
  let hadOriginal = false
  try {
    await fs.rename(target, backup)
    hadOriginal = true
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    if (hadOriginal) await fs.rename(backup, target).catch(() => {})
    throw error
  }
  return { target, backup, hadOriginal }
}

async function rollbackFile(replacement) {
  await fs.rm(replacement.target, { force: true }).catch(() => {})
  if (replacement.hadOriginal) await fs.rename(replacement.backup, replacement.target).catch(() => {})
}

async function finalizeReplacement(replacement) {
  if (replacement.hadOriginal) await fs.rm(replacement.backup, { force: true }).catch(() => {})
}

function buildTransactionPaths(root, config, transactionId) {
  const stageRoot = path.resolve(root, config.staging.root)
  const registryPath = path.join(root, fromPosix(config.state.registry))
  const manifestPath = path.join(root, fromPosix(config.state.manifest))
  return {
    journal: path.join(root, "publishing", ".publish-transaction.json"),
    stage: stageRoot,
    stageTemporary: `${stageRoot}.tmp-${transactionId}`,
    stageBackup: `${stageRoot}.backup-${transactionId}`,
    registry: registryPath,
    registryTemporary: `${registryPath}.tmp-${transactionId}`,
    registryBackup: `${registryPath}.backup-${transactionId}`,
    manifest: manifestPath,
    manifestTemporary: `${manifestPath}.tmp-${transactionId}`,
    manifestBackup: `${manifestPath}.backup-${transactionId}`,
  }
}

async function cleanOrphanTransactions(root, config) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      /^\.publish-stage\.(?:tmp|backup)-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)
    ) {
      await removeIfExists(path.join(root, entry.name))
    }
  }
}

async function recoverBuildTransaction(root, config) {
  const journal = path.join(root, "publishing", ".publish-transaction.json")
  let record
  try {
    record = JSON.parse(await fs.readFile(journal, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") {
      await cleanOrphanTransactions(root, config)
      return
    }
    throw new PublishError("Publishing transaction journal is invalid", filesystemExit(config), [
      diag("E_CONFIG_INVALID", "publishing/.publish-transaction.json", "invalid-transaction-journal"),
    ])
  }
  if (!RID_PATTERN.test(record.id) || !["prepared", "committed"].includes(record.phase)) {
    throw new PublishError("Publishing transaction journal is unsafe", filesystemExit(config), [
      diag("E_CONFIG_INVALID", "publishing/.publish-transaction.json", "unsafe-transaction-journal"),
    ])
  }
  const paths = buildTransactionPaths(root, config, record.id)
  if (record.phase === "prepared") {
    for (const [target, backup, hadOriginal] of [
      [paths.manifest, paths.manifestBackup, record.hadManifest],
      [paths.registry, paths.registryBackup, record.hadRegistry],
      [paths.stage, paths.stageBackup, record.hadStage],
    ]) {
      if (await pathExists(backup)) {
        await removeIfExists(target)
        await fs.rename(backup, target)
      } else if (!hadOriginal && !(await pathExists(`${target}.tmp-${record.id}`))) {
        await removeIfExists(target)
      }
    }
  }
  await removeIfExists(paths.stageTemporary)
  await removeIfExists(paths.registryTemporary)
  await removeIfExists(paths.manifestTemporary)
  await removeIfExists(paths.stageBackup)
  await removeIfExists(paths.registryBackup)
  await removeIfExists(paths.manifestBackup)
  await fs.rm(paths.journal, { force: true })
  await cleanOrphanTransactions(root, config)
}

async function commitBuild(analysis, transactionId, registry, manifest) {
  const stageRoot = path.resolve(analysis.root, analysis.config.staging.root)
  const paths = buildTransactionPaths(analysis.root, analysis.config, transactionId)
  const record = {
    version: 1,
    id: transactionId,
    phase: "prepared",
    hadStage: await pathExists(paths.stage),
    hadRegistry: await pathExists(paths.registry),
    hadManifest: await pathExists(paths.manifest),
  }
  try {
    if (record.hadStage) {
      const stat = await fs.lstat(stageRoot)
      if (stat.isSymbolicLink()) {
        throw new PublishError("Refusing symlink staging root", filesystemExit(analysis.config), [
          diag("E_CONFIG_INVALID", analysis.config.staging.root, "staging-root-is-symlink"),
        ])
      }
    }
    await fs.writeFile(paths.registryTemporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
    await fs.writeFile(paths.manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(paths.journal, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    if (record.hadStage) await fs.rename(paths.stage, paths.stageBackup)
    if (record.hadRegistry) await fs.rename(paths.registry, paths.registryBackup)
    if (record.hadManifest) await fs.rename(paths.manifest, paths.manifestBackup)
    await fs.rename(paths.stageTemporary, paths.stage)
    await fs.rename(paths.registryTemporary, paths.registry)
    await fs.rename(paths.manifestTemporary, paths.manifest)
    record.phase = "committed"
    await fs.writeFile(paths.journal, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await fs.rm(paths.journal, { force: true })
    await removeIfExists(paths.stageBackup)
    await removeIfExists(paths.registryBackup)
    await removeIfExists(paths.manifestBackup)
  } catch (error) {
    await recoverBuildTransaction(analysis.root, analysis.config).catch(() => {})
    if (error instanceof PublishError) throw error
    throw new PublishError("Failed to commit staging transaction", filesystemExit(analysis.config), [
      diag("E_CONFIG_INVALID", analysis.config.staging.root, error.code ?? "io-failure"),
    ])
  }
}

export async function build(root, { dryRun = false, now = () => new Date().toISOString() } = {}) {
  const resolvedRoot = path.resolve(root)
  const initialConfig = await loadConfig(resolvedRoot)
  if (!dryRun) await recoverBuildTransaction(resolvedRoot, initialConfig)
  const analysis = await analyzeWorkspace(root, { includeRendered: true })
  const summary = diagnosticSummary(analysis)
  const plan = planBuild(analysis)
  if (summary.errorCount > 0) {
    return {
      ok: false,
      command: dryRun ? "build --dry-run" : "build",
      dryRun,
      ...summary,
      plan,
      exitCode: contentExit(analysis.config),
    }
  }
  if (dryRun) {
    return {
      ok: true,
      command: "build --dry-run",
      dryRun: true,
      ...summary,
      plan,
      wrote: [],
      exitCode: 0,
    }
  }

  const timestamp = now()
  const registry = nextRegistryForBuild(analysis, timestamp)
  const manifest = buildManifest(analysis, timestamp)
  const stageRoot = path.resolve(analysis.root, analysis.config.staging.root)
  if (!isWithin(analysis.root, stageRoot) || stageRoot === analysis.root) {
    throw new PublishError("Unsafe staging root", filesystemExit(analysis.config), [
      diag("E_CONFIG_INVALID", analysis.config.staging.root, "unsafe-staging-root"),
    ])
  }
  const transactionId = crypto.randomUUID()
  const temporaryRoot = `${stageRoot}.tmp-${transactionId}`
  try {
    await writeStage(analysis, temporaryRoot, manifest, registry)
    await commitBuild(analysis, transactionId, registry, manifest)
  } catch (error) {
    await removeIfExists(temporaryRoot).catch(() => {})
    if (error instanceof PublishError) throw error
    throw new PublishError("Failed to build staging tree", filesystemExit(analysis.config), [
      diag("E_CONFIG_INVALID", analysis.config.staging.root, error.code ?? "io-failure"),
    ])
  }
  return {
    ok: true,
    command: "build",
    dryRun: false,
    ...summary,
    plan,
    manifest,
    wrote: [analysis.config.staging.root, analysis.config.state.registry, analysis.config.state.manifest],
    exitCode: 0,
  }
}

async function transactionalWriteFiles(entries) {
  const transactionId = crypto.randomUUID()
  const replacements = []
  try {
    for (const entry of entries) {
      replacements.push(await replaceFileWithBackup(entry.path, entry.content, transactionId))
    }
    for (const replacement of replacements) await finalizeReplacement(replacement)
  } catch (error) {
    for (const replacement of replacements.reverse()) await rollbackFile(replacement)
    throw error
  }
}

export async function assignId(rootInput, noteInput, { now = () => new Date().toISOString(), uuid = crypto.randomUUID } = {}) {
  const root = path.resolve(rootInput)
  const config = await loadConfig(root)
  const state = await loadState(root, config)
  const noteAbsolute = path.resolve(root, noteInput)
  if (
    !isWithin(root, noteAbsolute) ||
    noteAbsolute === root ||
    path.extname(noteAbsolute).toLowerCase() !== ".md"
  ) {
    throw new PublishError("Note path is outside the source workspace", contractExit(config), [
      diag("E_CONFIG_INVALID", noteInput, "unsafe-note-path"),
    ])
  }
  const relativePath = normalizeRelative(path.relative(root, noteAbsolute))
  if (!insideConfiguredSource(config, relativePath) || excludedDirectory(config, relativePath)) {
    throw new PublishError("Note path is excluded", contractExit(config), [
      diag("E_CONFIG_INVALID", relativePath, "excluded-note-path"),
    ])
  }
  const scan = await scanNotes(root, config)
  const identityDiagnostics = [
    ...scan.diagnostics.filter((item) => IDENTITY_CODES.has(item.code)),
    ...validateIdentityAgainstRegistry(scan, state.registry).filter(
      (item) =>
        !(
          item.code === "E_RID_REUSED" &&
          item.path === relativePath &&
          item.detail?.reason === "unregistered"
        ),
    ),
  ]
  const target = scan.notes.find((note) => note.relativePath === relativePath)
  if (!target) {
    throw new PublishError("Note does not exist or path case is not exact", contractExit(config), [
      diag("E_CONFIG_INVALID", relativePath, "note-not-found"),
    ])
  }
  if (hasErrors(identityDiagnostics)) {
    throw new PublishError("Cannot assign identity while identity scan fails", contentExit(config), identityDiagnostics)
  }

  let rid = target.rid
  let generated = false
  if (!rid) {
    const occupied = new Set([...scan.byRid.keys(), ...Object.keys(state.registry.resources)])
    do rid = uuid()
    while (!RID_PATTERN.test(rid) || occupied.has(rid))
    generated = true
  }
  const permalink = config.routes.pagePattern.replace("{rid}", rid)
  if (target.permalink !== undefined && target.permalink !== permalink) {
    throw new PublishError("Existing permalink does not match rid", contentExit(config), [
      diag("E_PERMALINK_MISMATCH", relativePath, { expected: permalink }),
    ])
  }
  const existing = state.registry.resources[rid]
  if (existing?.status === "retired") {
    throw new PublishError("RID has been retired", contentExit(config), [
      diag("E_RID_REUSED", relativePath, { rid, reason: "retired" }),
    ])
  }
  if (existing && existing.lastKnownSourcePath !== relativePath) {
    const previousStillExists = scan.notes.some((note) => note.relativePath === existing.lastKnownSourcePath)
    if (previousStillExists) {
      throw new PublishError("RID belongs to another resource", contentExit(config), [
        diag("E_RID_REUSED", relativePath, { rid, previousPath: existing.lastKnownSourcePath }),
      ])
    }
  }

  const missingFields = {}
  if (!target.rid) missingFields[config.frontmatter.ridField] = rid
  if (target.permalink === undefined) missingFields[config.frontmatter.permalinkField] = permalink
  const nextText =
    Object.keys(missingFields).length > 0 ? insertFrontmatterFields(target.text, target.parsed, missingFields) : target.text
  const timestamp = now()
  const nextRegistry = structuredClone(state.registry)
  if (!nextRegistry.resources[rid]) {
    nextRegistry.resources[rid] = {
      firstAssignedPath: relativePath,
      lastKnownSourcePath: relativePath,
      status: "active",
      assignedAt: timestamp,
      everPublished: false,
    }
    nextRegistry.events.push({ type: "assigned", rid, at: timestamp, sourcePath: relativePath })
  } else {
    nextRegistry.resources[rid].lastKnownSourcePath = relativePath
  }
  const writes = []
  if (nextText !== target.text) writes.push({ path: noteAbsolute, content: nextText })
  if (JSON.stringify(nextRegistry) !== JSON.stringify(state.registry)) {
    writes.push({ path: state.registryPath, content: `${JSON.stringify(nextRegistry, null, 2)}\n` })
  }
  try {
    if (writes.length > 0) await transactionalWriteFiles(writes)
  } catch (error) {
    throw new PublishError("Failed to assign identity atomically", filesystemExit(config), [
      diag("E_CONFIG_INVALID", relativePath, error.code ?? "io-failure"),
    ])
  }
  return {
    ok: true,
    command: "assign-id",
    path: relativePath,
    rid,
    permalink,
    generated,
    changed: writes.length > 0,
    publishChanged: false,
    exitCode: 0,
  }
}

export async function prepareAll(rootInput) {
  const root = path.resolve(rootInput)
  const config = await loadConfig(root)
  const state = await loadState(root, config)
  const scan = await scanNotes(root, config)
  const diagnostics = [
    ...scan.diagnostics,
    ...validateIdentityAgainstRegistry(scan, state.registry),
  ]
  if (hasErrors(diagnostics)) {
    throw new PublishError("Cannot prepare notes while validation fails", contentExit(config), diagnostics)
  }

  const prepared = []
  for (const note of scan.notes) {
    if (note.rid && note.permalink !== undefined) continue
    const result = await assignId(root, note.relativePath)
    prepared.push({
      path: result.path,
      rid: result.rid,
      permalink: result.permalink,
    })
  }
  return {
    ok: true,
    command: "prepare",
    notesScanned: scan.notes.length,
    prepared,
    preparedCount: prepared.length,
    exitCode: 0,
  }
}

export async function annotatePublicUrls(rootInput) {
  const root = path.resolve(rootInput)
  const config = await loadConfig(root)
  const state = await loadState(root, config)
  const scan = await scanNotes(root, config)
  const diagnostics = [
    ...scan.diagnostics,
    ...validateIdentityAgainstRegistry(scan, state.registry),
  ]
  for (const note of scan.notes.filter((candidate) => candidate.published)) {
    if (!note.rid) diagnostics.push(diag("E_RID_MISSING", note.relativePath))
    else if (note.permalink === undefined) diagnostics.push(diag("E_PERMALINK_MISSING", note.relativePath))
  }
  if (hasErrors(diagnostics)) {
    throw new PublishError("Cannot annotate public URLs while identity validation fails", contentExit(config), diagnostics)
  }

  const field = config.frontmatter.publicUrlField
  const baseUrl = config.routes.publicBaseUrl.replace(/\/$/, "")
  const annotated = []
  const writes = []
  for (const note of scan.notes.filter((candidate) => candidate.published)) {
    const url = `${baseUrl}${config.routes.pagePattern.replace("{rid}", note.rid)}`
    const previous = note.data[field]
    const nextText = setFrontmatterField(note.text, note.parsed, field, url)
    if (nextText === note.text) continue
    writes.push({ path: note.absolutePath, content: nextText })
    annotated.push({
      path: note.relativePath,
      url,
      action: previous === undefined ? "added" : "corrected",
    })
  }
  try {
    if (writes.length > 0) await transactionalWriteFiles(writes)
  } catch (error) {
    if (error instanceof PublishError) throw error
    throw new PublishError("Failed to annotate public URLs atomically", filesystemExit(config), [
      diag("E_CONFIG_INVALID", config.source.root, error.code ?? "io-failure"),
    ])
  }
  return {
    ok: true,
    command: "annotate-urls",
    notesScanned: scan.notes.length,
    annotated,
    annotatedCount: annotated.length,
    exitCode: 0,
  }
}

export async function clean(rootInput) {
  const root = path.resolve(rootInput)
  const config = await loadConfig(root)
  await recoverBuildTransaction(root, config)
  const configured = config.staging.root
  const target = path.resolve(root, configured)
  if (configured !== ".publish-stage" || target === root || !isWithin(root, target)) {
    throw new PublishError("Unsafe clean target", filesystemExit(config), [
      diag("E_CONFIG_INVALID", configured, "unsafe-clean-target"),
    ])
  }
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) {
      throw new PublishError("Refusing to clean symlink", filesystemExit(config), [
        diag("E_CONFIG_INVALID", configured, "staging-root-is-symlink"),
      ])
    }
    await fs.rm(target, { recursive: true, force: false })
    return { ok: true, command: "clean", removed: [configured], exitCode: 0 }
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, command: "clean", removed: [], exitCode: 0 }
    if (error instanceof PublishError) throw error
    throw new PublishError("Failed to clean staging root", filesystemExit(config), [
      diag("E_CONFIG_INVALID", configured, error.code ?? "io-failure"),
    ])
  }
}

export function formatFailure(error) {
  if (error instanceof PublishError) {
    return {
      ok: false,
      error: error.message,
      diagnostics: error.diagnostics,
      exitCode: error.exitCode,
    }
  }
  return {
    ok: false,
    error: "Unexpected internal error",
    diagnostics: [],
    exitCode: 5,
  }
}

export const internals = {
  RID_PATTERN,
  parseFrontmatter,
  collectMarkupReferences,
  resolveAttachment,
  detectImageType,
}
