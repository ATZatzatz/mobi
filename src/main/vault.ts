/**
 * 文件库服务：所有磁盘读写都从这里走。
 *
 * 设计原则：
 * 1. 文稿就是磁盘上的普通 .md 文件，不建数据库、不做私有格式。
 *    目录树的嵌套关系 = 真实文件夹结构，用户随时可以脱离本程序自己打开、备份、用 git 管。
 * 2. 所有写操作走原子写入，并且写之前先记录一次快照。
 * 3. 删除进回收站而不是真删。
 * 4. 所有路径都要过一遍越界检查，避免 ../ 逃出文件库。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { atomicWriteBuffer, atomicWriteText } from './atomic'
import {
  META_DIR,
  encodeRel,
  formatStamp,
  isIgnoredRel,
  isTempFileName,
  isTextFileName,
  joinRel,
  looksLikePath,
  parentRelOf,
  sanitizeFileName,
  toRelative
} from './relpath'
import { noteSelfWrite } from './watcher'
import type { DirEntry, ReadResult, SaveResult, StatResult } from '@shared/types'

const TRASH_DIR = 'trash'
const HISTORY_DIR = 'history'
/** 同一个文件两次快照之间至少隔这么久，避免自动保存把磁盘塞满 */
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000
const HISTORY_KEEP = 20
const MAX_NAME_BYTES = 200
const TEMP_SWEEP_MAX_ENTRIES = 5000

let root: string | null = null
const lastSnapshotAt = new Map<string, number>()

export function setRoot(next: string | null): void {
  root = next ? resolve(next) : null
  lastSnapshotAt.clear()
}

export function getRoot(): string | null {
  return root
}

export function requireRoot(): string {
  if (!root) throw new Error('还没有打开文件夹')
  return root
}

export function metaPath(...parts: string[]): string {
  return join(requireRoot(), META_DIR, ...parts)
}

/** 把相对路径解析成绝对路径，并确保没有跑出文件库 */
export function resolveInside(rel: string): string {
  const base = requireRoot()
  const abs = resolve(base, rel || '.')
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越界：${rel}`)
  }
  return abs
}

export function relativeOf(abs: string): string {
  return toRelative(requireRoot(), abs)
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

/**
 * 名称校验：Windows 上一堆坑，必须提前拦住，
 * 否则用户会看到 fs 抛出的 EINVAL，完全看不懂。
 */
export function validateName(rawName: string): string {
  const name = rawName.trim()
  if (!name) throw new Error('名称不能为空')
  if (name === '.' || name === '..') throw new Error('名称不合法')
  if (looksLikePath(name)) throw new Error('名称不能包含 / 或 \\')
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) throw new Error('名称不能包含 < > : " | ? * 等字符')
  if (name.startsWith('.')) throw new Error('名称不能以点开头')
  if (name.endsWith('.') || name.endsWith(' ')) throw new Error('名称不能以点或空格结尾')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) throw new Error('这是 Windows 保留名称，换一个')
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw new Error('名称太长了')
  return name
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  try {
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  } catch {
    return a.name.localeCompare(b.name)
  }
}

export async function listDir(rel: string): Promise<DirEntry[]> {
  const abs = resolveInside(rel)
  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const dirent of dirents) {
    const childRel = joinRel(rel, dirent.name)
    if (isIgnoredRel(childRel)) continue
    if (dirent.isDirectory()) {
      out.push({ name: dirent.name, rel: childRel, kind: 'dir' })
    } else if (dirent.isFile() && isTextFileName(dirent.name) && !isTempFileName(dirent.name)) {
      out.push({ name: dirent.name, rel: childRel, kind: 'file' })
    }
  }
  out.sort(compareEntries)
  return out
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readText(rel: string): Promise<ReadResult> {
  const abs = resolveInside(rel)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw new Error(`不是文件：${rel}`)
  const buffer = await fs.readFile(abs)
  return { content: stripBom(buffer.toString('utf8')), mtimeMs: stat.mtimeMs, size: stat.size }
}

export async function statEntry(rel: string): Promise<StatResult> {
  try {
    const abs = resolveInside(rel)
    const stat = await fs.stat(abs)
    return { exists: true, isDir: stat.isDirectory(), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { exists: false, isDir: false, mtimeMs: 0, size: 0 }
  }
}

export async function writeText(rel: string, content: string): Promise<SaveResult> {
  const abs = resolveInside(rel)
  await snapshotIfNeeded(rel, abs)
  noteSelfWrite(abs)
  await atomicWriteText(abs, content)
  const stat = await fs.stat(abs)
  return { mtimeMs: stat.mtimeMs, size: stat.size }
}

/** 覆盖前留一份旧内容，防止误改 / 误删无法回溯。失败绝不影响保存。 */
async function snapshotIfNeeded(rel: string, abs: string): Promise<void> {
  const last = lastSnapshotAt.get(rel) ?? 0
  if (Date.now() - last < SNAPSHOT_MIN_INTERVAL_MS) return
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile() || stat.size === 0) return
    if (stat.size > 4 * 1024 * 1024) return
    const previous = await fs.readFile(abs)
    const dir = metaPath(HISTORY_DIR, encodeRel(rel))
    await fs.mkdir(dir, { recursive: true })
    await atomicWriteBuffer(join(dir, `${formatStamp(new Date())}.md`), previous)
    lastSnapshotAt.set(rel, Date.now())
    await pruneHistory(dir)
  } catch {
    // 快照只是保险，不是主流程
  }
}

async function pruneHistory(dir: string): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort()
    const extra = names.length - HISTORY_KEEP
    for (let i = 0; i < extra; i += 1) {
      const name = names[i]
      if (name) await fs.rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}

export async function createEntry(dirRel: string, rawName: string, kind: 'dir' | 'file'): Promise<DirEntry> {
  const dirAbs = resolveInside(dirRel)
  await fs.mkdir(dirAbs, { recursive: true })
  let name = validateName(rawName)
  if (kind === 'file' && !isTextFileName(name)) name = `${name}.md`
  const rel = joinRel(dirRel, name)
  const abs = resolveInside(rel)
  if (await exists(abs)) throw new Error(`「${name}」已经存在了`)
  if (kind === 'dir') {
    await fs.mkdir(abs, { recursive: false })
  } else {
    const handle = await fs.open(abs, 'wx')
    await handle.close()
  }
  noteSelfWrite(abs)
  return { name, rel, kind }
}

export async function renameEntry(rel: string, rawName: string): Promise<DirEntry> {
  const name = validateName(rawName)
  const abs = resolveInside(rel)
  const stat = await fs.stat(abs)
  const target = join(dirname(abs), name)
  if (target === abs) {
    return { name, rel, kind: stat.isDirectory() ? 'dir' : 'file' }
  }
  if (await exists(target)) throw new Error(`「${name}」已经存在了`)
  // 改名会让监听器看到「旧路径消失 + 新路径出现」两个事件，
  // 旧路径也必须登记成自我写入，否则会被当成「文稿被外部删了」而弹警告。
  noteSelfWrite(abs)
  await fs.rename(abs, target)
  noteSelfWrite(target)
  return { name, rel: relativeOf(target), kind: stat.isDirectory() ? 'dir' : 'file' }
}

export async function moveEntry(rel: string, destDirRel: string): Promise<DirEntry> {
  const abs = resolveInside(rel)
  const destAbs = resolveInside(destDirRel)
  const name = basename(abs)
  const target = join(destAbs, name)
  if (target === abs) return { name, rel, kind: (await fs.stat(abs)).isDirectory() ? 'dir' : 'file' }
  const stat = await fs.stat(abs)
  if (stat.isDirectory() && target.startsWith(abs + sep)) {
    throw new Error('不能把文件夹移动到它自己里面')
  }
  if (rel === destDirRel) return { name, rel, kind: 'dir' }
  await fs.mkdir(destAbs, { recursive: true }).catch(() => undefined)
  if (await exists(target)) throw new Error(`目标位置已经有「${name}」了`)
  noteSelfWrite(abs)
  await fs.rename(abs, target)
  noteSelfWrite(target)
  return { name, rel: relativeOf(target), kind: stat.isDirectory() ? 'dir' : 'file' }
}

/** 删除 = 移进文件库内的回收站，永远不真删 */
export async function trashEntry(rel: string): Promise<{ trashPath: string }> {
  const abs = resolveInside(rel)
  const name = basename(abs)
  const dir = metaPath(TRASH_DIR)
  await fs.mkdir(dir, { recursive: true })
  const stamp = formatStamp(new Date())
  let target = join(dir, `${stamp}__${name}`)
  let index = 1
  while (await exists(target)) {
    target = join(dir, `${stamp}__${index}__${name}`)
    index += 1
  }
  noteSelfWrite(abs)
  try {
    await fs.rename(abs, target)
  } catch {
    await fs.cp(abs, target, { recursive: true })
    await fs.rm(abs, { recursive: true, force: true })
  }
  noteSelfWrite(target)
  await atomicWriteText(
    `${target}.json`,
    JSON.stringify({ rel, name, deletedAt: new Date().toISOString() }, null, 2)
  ).catch(() => undefined)
  return { trashPath: target }
}

export function trashDirPath(): string {
  return metaPath(TRASH_DIR)
}

/** 允许导入的后缀 */
const IMPORTABLE = new Set(['.md', '.markdown', '.mdx', '.txt'])
/** 一次最多导入多少个文件，避免误选整个磁盘把界面卡死 */
const IMPORT_LIMIT = 500

/**
 * 批量导入：把外部选中的 Markdown 文件复制进文档库的某个目录。
 * 只复制，不动原文件；重名自动加序号，**绝不覆盖已有文稿**。
 */
export async function importFiles(
  dirRel: string,
  sources: string[]
): Promise<{ imported: string[]; renamed: string[]; skipped: string[] }> {
  const dirAbs = resolveInside(dirRel)
  await fs.mkdir(dirAbs, { recursive: true })

  const imported: string[] = []
  const renamed: string[] = []
  const skipped: string[] = []

  // 先把目录里已有的名字读进来，作为去重依据。
  // 不这么做的话，重名时算出来的「唯一名」还是原名，会直接覆盖已有文稿。
  const taken = new Set<string>()
  for (const name of await fs.readdir(dirAbs)) taken.add(name.toLowerCase())

  for (const source of sources.slice(0, IMPORT_LIMIT)) {
    const base = basename(source)
    const ext = extname(source).toLowerCase()
    if (!IMPORTABLE.has(ext)) {
      skipped.push(base)
      continue
    }

    let name = base
    try {
      validateName(name)
    } catch {
      name = sanitizeFileName(name)
    }

    if (taken.has(name.toLowerCase())) {
      const suffix = extname(name)
      const stem = suffix ? name.slice(0, -suffix.length) : name
      let index = 2
      while (taken.has(`${stem} ${index}${suffix}`.toLowerCase())) index += 1
      const unique = `${stem} ${index}${suffix}`
      renamed.push(`${base} → ${unique}`)
      name = unique
    }

    try {
      await fs.copyFile(source, join(dirAbs, name))
      taken.add(name.toLowerCase())
      noteSelfWrite(join(dirAbs, name))
      imported.push(joinRel(dirRel, name))
    } catch {
      skipped.push(base)
    }
  }
  return { imported, renamed, skipped }
}

/**
 * 清理上次崩溃 / 被杀留下的临时文件。
 * 有上限地遍历，大文件库不会在启动时卡住。
 */
export async function sweepTempFiles(): Promise<number> {
  const base = requireRoot()
  let removed = 0
  let visited = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || visited > TEMP_SWEEP_MAX_ENTRIES) return
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      visited += 1
      if (visited > TEMP_SWEEP_MAX_ENTRIES) return
      const abs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (dirent.name === META_DIR) continue
        if (dirent.name.startsWith('.')) continue
        await walk(abs, depth + 1)
      } else if (isTempFileName(dirent.name)) {
        await fs.rm(abs, { force: true }).then(
          () => {
            removed += 1
          },
          () => undefined
        )
      }
    }
  }
  await walk(base, 0)
  return removed
}

export function findNonEmptyParent(rel: string): string {
  return parentRelOf(rel)
}
