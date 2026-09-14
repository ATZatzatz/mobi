/**
 * 文件监听。
 *
 * 两个关键点：
 * 1. 批量 + 去抖：一次操作可能触发十几个事件，合并在一次下发里。
 * 2. 抑制自我写入：我们自己保存文件也会触发事件，
 *    如果不屏蔽，就会变成「自己改自己 -> 监听 -> 重新加载 -> 光标跳走」的死循环。
 *    主进程在写盘前调用 noteSelfWrite 登记，事件回来时直接丢掉。
 */
import { watch, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { META_DIR, isTempFileName, toRelative } from './relpath'
import type { WatchPayload, WatchStatus } from '@shared/types'

const SELF_WRITE_WINDOW_MS = 2500
const DEBOUNCE_MS = 180
const MAX_RETRY = 5

type Emit = (payload: WatchPayload) => void
type Status = (status: WatchStatus) => void

let watcher: FSWatcher | null = null
let currentRoot: string | null = null
let emitFn: Emit | null = null
let statusFn: Status | null = null
let pending = new Set<string>()
let timer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let retryCount = 0

const selfWrites = new Map<string, number>()

/** 写盘前登记，告诉监听器“这条是我自己弄的，别当外部修改” */
export function noteSelfWrite(abs: string): void {
  selfWrites.set(resolve(abs), Date.now())
}

function pruneSelfWrites(): void {
  const now = Date.now()
  for (const [key, at] of selfWrites) {
    if (now - at > SELF_WRITE_WINDOW_MS) selfWrites.delete(key)
  }
}

function isSelfWrite(abs: string): boolean {
  const at = selfWrites.get(abs)
  if (at === undefined) return false
  if (Date.now() - at > SELF_WRITE_WINDOW_MS) {
    selfWrites.delete(abs)
    return false
  }
  return true
}

function shouldIgnore(abs: string): boolean {
  if (!currentRoot) return true
  if (!abs.startsWith(currentRoot + sep)) return true
  const name = basename(abs)
  if (name === META_DIR) return true
  if (abs.includes(sep + META_DIR + sep)) return true
  if (isTempFileName(name)) return true
  const parts = abs.slice(currentRoot.length + 1).split(sep)
  if (parts.some((part) => part.startsWith('.'))) return true
  return false
}

function onFsEvent(filename: string | Buffer | null): void {
  if (!filename || !currentRoot) return
  const raw = filename.toString()
  const abs = raw.includes(sep) || /^[A-Za-z]:/.test(raw) ? resolve(raw) : join(currentRoot, raw)
  if (shouldIgnore(abs)) return
  if (isSelfWrite(abs)) return
  pending.add(abs)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
}

function flush(): void {
  const current = currentRoot
  const emit = emitFn
  if (!current || !emit) {
    pending = new Set()
    return
  }
  const batch = pending
  pending = new Set()
  const files = new Set<string>()
  const removed = new Set<string>()
  const dirs = new Set<string>()

  for (const abs of batch) {
    let rel = ''
    try {
      rel = toRelative(current, abs)
    } catch {
      continue
    }
    if (!rel || rel.startsWith('..')) continue
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    let exists = false
    let isDir = false
    try {
      const stat = statSync(abs)
      exists = true
      isDir = stat.isDirectory()
    } catch {
      exists = false
    }
    if (!exists) {
      removed.add(rel)
      dirs.add(parent)
    } else if (isDir) {
      dirs.add(parent)
    } else {
      files.add(rel)
      dirs.add(parent)
    }
  }

  pruneSelfWrites()
  if (!files.size && !removed.size && !dirs.size) return
  emit({ dirs: [...dirs], files: [...files], removed: [...removed] })
}

function scheduleRetry(): void {
  if (retryCount >= MAX_RETRY) {
    statusFn?.({ watching: false, message: '文件监听已停止，外部改动的提示可能不及时' })
    return
  }
  retryCount += 1
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    if (currentRoot) startWatch(currentRoot, emitFn as Emit, statusFn as Status)
  }, 1200 * retryCount)
}

export function startWatch(rootDir: string, emit: Emit, status: Status): void {
  stopWatch()
  currentRoot = resolve(rootDir)
  emitFn = emit
  statusFn = status
  try {
    watcher = watch(currentRoot, { recursive: true, persistent: true })
    watcher.on('change', (_event, filename) => onFsEvent(filename))
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
      statusFn?.({ watching: false, message: '文件监听出错，正在重试…' })
      scheduleRetry()
    })
    retryCount = 0
    status({ watching: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status({ watching: false, message })
    scheduleRetry()
  }
}

export function stopWatch(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  pending = new Set()
  if (watcher) {
    watcher.removeAllListeners()
    watcher.close()
    watcher = null
  }
  currentRoot = null
  emitFn = null
  statusFn = null
}
