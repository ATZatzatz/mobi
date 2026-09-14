/**
 * 文档库全文搜索。
 *
 * 设计取舍：
 * - 不建索引。文稿是普通文件，用户随时会在外部改动，索引一致性的维护成本远高于收益；
 *   写作库一般也就几百到几千个文件，直接扫一遍足够快。
 * - 只在文件名范围搜索时完全不读文件内容，所以「只看文件名」几乎瞬时出结果。
 * - 正文搜索有多重上限（文件数、单文件大小、命中数），保证不会因为一个超大文档库卡死界面。
 * - 支持取消：渲染层每次输入都会带上新的搜索，主进程发现 id 变了就立刻收手。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isIgnoredRel, isTextFileName, joinRel } from './relpath'
import { getRoot } from './vault'
import type { SearchHit, SearchLine, SearchRequest, SearchResult } from '@shared/types'

/** 最多扫描多少个文稿 */
const MAX_FILES = 5000
/** 最多返回多少个命中文件 */
const MAX_HITS = 200
/** 每个文件最多列出几行 */
const MAX_LINES_PER_FILE = 6
/** 超过这个大小的文件不搜正文（避免读一个几十兆的文件） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 单行显示长度上限 */
const SNIPPET_MAX = 160
/** 并发读取的文件数 */
const CONCURRENCY = 8

/** 每次搜索自增，用来判断某次搜索是不是已经过期 */
let currentSearchId = 0

function stemOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return base.replace(/\.[^.]+$/, '')
}

/** 收集所有候选文稿（跳过 .mobiwriter 和点开头的条目） */
async function collectFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue: string[] = ['']
  let truncated = false

  while (queue.length > 0) {
    const rel = queue.shift() as string
    let entries
    try {
      entries = await fs.readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const childRel = joinRel(rel, entry.name)
      if (isIgnoredRel(childRel)) continue
      if (entry.isDirectory()) {
        queue.push(childRel)
      } else if (isTextFileName(entry.name)) {
        files.push(childRel)
        if (files.length >= MAX_FILES) {
          truncated = true
          return { files, truncated }
        }
      }
    }
  }
  return { files, truncated }
}

async function matchContent(
  root: string,
  rel: string,
  needle: string,
  caseSensitive: boolean
): Promise<SearchLine[]> {
  const abs = join(root, rel)
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return []
    const text = await fs.readFile(abs, 'utf8')
    const lines = text.split(/\r\n|\r|\n/)
    const found: SearchLine[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? ''
      const haystack = caseSensitive ? raw : raw.toLowerCase()
      const at = haystack.indexOf(needle)
      if (at === -1) continue
      found.push({
        line: index + 1,
        text: raw.length > SNIPPET_MAX ? `${raw.slice(0, SNIPPET_MAX)}…` : raw,
        column: at
      })
      if (found.length >= MAX_LINES_PER_FILE) break
    }
    return found
  } catch {
    return []
  }
}

export async function runSearch(request: SearchRequest): Promise<SearchResult> {
  const started = Date.now()
  const id = ++currentSearchId
  const query = request.query.trim()
  const scope = request.scope
  const caseSensitive = request.caseSensitive

  const base: SearchResult = {
    query,
    scope,
    hits: [],
    scanned: 0,
    truncated: false,
    elapsedMs: 0
  }

  const root = getRoot()
  if (!root || query.length === 0) return { ...base, elapsedMs: Date.now() - started }

  const needle = caseSensitive ? query : query.toLowerCase()
  const { files, truncated: tooManyFiles } = await collectFiles(root)
  const hitsByRel = new Map<string, SearchHit>()
  let truncated = tooManyFiles

  // 1) 先做文件名匹配。树上不显示后缀，所以拿去掉后缀的名字来比。
  for (const rel of files) {
    if (hitsByRel.size >= MAX_HITS) {
      truncated = true
      break
    }
    const stem = stemOf(rel)
    const haystack = caseSensitive ? stem : stem.toLowerCase()
    if (haystack.includes(needle)) {
      hitsByRel.set(rel, { rel, name: stem, kind: 'name', lines: [] })
    }
  }

  // 2) 再搜正文。文件名命中的文件如果正文也命中，直接并到同一条里。
  if (scope === 'all') {
    let cursor = 0
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        // 有更新的一次搜索进来了，立刻收手
        if (id !== currentSearchId) return
        if (hitsByRel.size >= MAX_HITS) {
          truncated = true
          return
        }
        const index = cursor
        cursor += 1
        const rel = files[index]
        if (rel === undefined) return

        const lines = await matchContent(root, rel, needle, caseSensitive)
        if (lines.length > 0) {
          const existing = hitsByRel.get(rel)
          if (existing) {
            existing.lines = lines
          } else {
            hitsByRel.set(rel, { rel, name: stemOf(rel), kind: 'content', lines })
          }
        }
      }
    })
    await Promise.all(workers)
  }

  // 文件名命中排在前面，正文命中排在后面
  const hits = [...hitsByRel.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'name' ? -1 : 1
    return a.rel.localeCompare(b.rel, 'zh-Hans-CN')
  })

  return {
    query,
    scope,
    hits,
    scanned: files.length,
    truncated,
    elapsedMs: Date.now() - started
  }
}
