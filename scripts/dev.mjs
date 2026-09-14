/**
 * 开发 / 预览启动器。
 *
 * 为什么要多这一层：
 * 如果环境里存在 ELECTRON_RUN_AS_NODE，Electron 会退化成纯 Node 运行，
 * 窗口永远不出现（而且报错完全看不出原因）。这个变量在某些编辑器、
 * 终端或自动化环境里会被自动带上，跟项目本身没关系，用户也很难自查。
 *
 * 所以在启动前把它从子进程环境里删掉，让 npm run dev 在任何终端里都能正常开窗口。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? 'dev'

const env = { ...process.env }
if (env.ELECTRON_RUN_AS_NODE) {
  console.log('[墨笔] 检测到 ELECTRON_RUN_AS_NODE，本次启动已自动清除（不清会导致窗口打不开）')
  delete env.ELECTRON_RUN_AS_NODE
}

const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [bin, mode], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false
})

child.on('exit', (code, signal) => {
  if (signal) console.log(`[墨笔] electron-vite 被 ${signal} 结束`)
  process.exit(code === null ? 1 : code)
})
