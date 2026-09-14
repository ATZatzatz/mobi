/**
 * 原子写入。
 *
 * 目标：任何时刻断电 / 进程被杀，磁盘上的目标文件要么是旧内容，要么是新内容，
 * 绝不能出现写了一半的残缺文件。
 *
 * 手段：写同目录临时文件 -> fsync -> rename 覆盖。
 *
 * 为什么同目录：rename 在同一分区内才是原子的；跨分区会退化成复制。
 *
 * Windows 特有的坑：杀毒软件、Windows Search、OneDrive 会短暂占用文件句柄，
 * 导致 rename 抛 EBUSY / EPERM / EACCES。这里做指数退避重试，最后兜底为直接覆盖写，
 * 宁可牺牲一点点原子性，也不能让用户看到“保存失败”。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ENOTEMPTY'])
const RENAME_ATTEMPTS = 6

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tempPathFor(filePath: string): string {
  const tag = `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`
  return join(dirname(filePath), `.${basename(filePath)}.${tag}.tmp`)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 20
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = typeof code === 'string' && RETRYABLE_CODES.has(code)
      if (!retryable) throw error
      if (attempt === RENAME_ATTEMPTS - 1) {
        await fs.copyFile(from, to)
        await fs.rm(from, { force: true })
        return
      }
      await sleep(delay)
      delay = Math.min(delay * 2, 400)
    }
  }
}

export async function atomicWriteBuffer(filePath: string, data: Uint8Array): Promise<void> {
  const tmp = tempPathFor(filePath)
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(tmp, 'wx')
    await handle.writeFile(data)
    // 先把数据刷到磁盘，再改名，否则断电可能拿到空文件
    await handle.sync()
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await renameWithRetry(tmp, filePath)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function atomicWriteText(filePath: string, data: string): Promise<void> {
  await atomicWriteBuffer(filePath, Buffer.from(data, 'utf8'))
}
