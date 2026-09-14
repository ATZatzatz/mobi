/**
 * 纯路径/名称工具。刻意不依赖其它模块，避免 vault 与 watcher 之间形成循环引用。
 */
import { basename, extname, relative, resolve, sep } from 'node:path'

/** 文件库内部的元数据目录：回收站、快照都在这里面 */
export const META_DIR = '.mobiwriter'

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt'])

export function isTextFileName(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase())
}

/** 绝对路径 -> 相对根目录的 posix 风格路径 */
export function toRelative(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/')
}

/**
 * 是否应该在树里隐藏。
 * 规则：元数据目录、任何点开头的条目、临时文件。
 */
export function isIgnoredRel(rel: string): boolean {
  if (!rel) return false
  const parts = rel.split('/')
  if (parts[0] === META_DIR) return true
  return parts.some((part) => part.startsWith('.'))
}

export function isIgnoredAbs(root: string, abs: string): boolean {
  const rel = toRelative(root, abs)
  if (rel.startsWith('..')) return true
  return isIgnoredRel(rel)
}

/** 我们自己生成的临时文件：.<名字>.<随机>.tmp */
export function isTempFileName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.tmp')
}

/** 名称是否包含路径分隔或非法字符 */
export function looksLikePath(name: string): boolean {
  return name.includes('/') || name.includes('\\')
}

export function baseNameOf(rel: string): string {
  const idx = rel.lastIndexOf('/')
  return idx === -1 ? rel : rel.slice(idx + 1)
}

export function parentRelOf(rel: string): string {
  const idx = rel.lastIndexOf('/')
  return idx === -1 ? '' : rel.slice(0, idx)
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function formatStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 把相对路径压成一个安全的单层目录名，用于快照目录 */
export function encodeRel(rel: string): string {
  return rel.replace(/[\\/]/g, '__')
}

export function sanitizeFileName(name: string, fallback = 'untitled'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
  return cleaned || fallback
}

export function uniqueName(candidate: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(candidate)) return candidate
  const ext = extname(candidate)
  const stem = ext ? candidate.slice(0, -ext.length) : candidate
  for (let i = 2; i < 1000; i += 1) {
    const next = `${stem} ${i}${ext}`
    if (!used.has(next)) return next
  }
  return `${stem} ${Date.now()}${ext}`
}

export function titleFromRel(rel: string): string {
  const base = basename(rel)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}
