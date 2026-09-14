/**
 * 一键备份。
 *
 * 做法很土但很可靠：把文档库整个复制到一个带时间戳的新目录里。
 * 不做增量、不做打包压缩——因为这样备份出来的东西是「人能直接看懂、能直接打开、
 * 网盘也能直接同步」的普通文件夹，而不是一个只有本程序认识的归档文件。
 *
 * 不备份 .mobiwriter（回收站和历史快照）：那是内部数据，体量大且不属于「文稿内容」。
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { META_DIR, formatStamp } from './relpath'
import { requireRoot } from './vault'
import type { BackupResult } from '@shared/types'

/** 备份目录名：文稿库名-备份-时间戳 */
function backupDirName(root: string): string {
  return `${basename(root)}-备份-${formatStamp(new Date())}`
}

export async function backupLibrary(destParent: string): Promise<BackupResult> {
  const root = requireRoot()
  // 目标就是文档库自己或它的子目录时，会递归复制到自己里面，必须拦住
  const source = root.replace(/[\\/]+$/, '')
  const target = join(destParent, backupDirName(root))
  const normalizedTarget = target.replace(/[\\/]+$/, '')
  if (normalizedTarget === source || normalizedTarget.startsWith(`${source}\\`) || normalizedTarget.startsWith(`${source}/`)) {
    throw new Error('备份位置不能放在文档库里面')
  }

  await fs.mkdir(target, { recursive: true })

  let files = 0
  let bytes = 0

  const walk = async (rel: string): Promise<void> => {
    const srcDir = join(root, rel)
    const destDir = join(target, rel)
    await fs.mkdir(destDir, { recursive: true })
    let entries
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === META_DIR) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(childRel)
      } else if (entry.isFile()) {
        const src = join(root, childRel)
        const dest = join(destDir, entry.name)
        try {
          await fs.copyFile(src, dest)
          const stat = await fs.stat(src)
          files += 1
          bytes += stat.size
        } catch {
          // 单个文件失败不影响整体备份
        }
      }
    }
  }

  await walk('')
  return { destination: target, files, bytes }
}
