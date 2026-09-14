/**
 * Markdown 渲染 + 打印文档生成 + 字数统计。
 *
 * 关键点：
 * - html: false，不允许文稿里塞原始 HTML。安全，也避免样式被稿子里的 HTML 搞乱。
 * - 相对路径的图片要重写成 file:// 绝对路径，否则预览和 PDF 里全是裂图。
 * - 导出 PDF 用的是「和预览完全相同的 HTML + 同一份 CSS」，
 *   这样用户看到的就是导出的，不会出现两套渲染结果。
 */
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import { centeredHeading } from './centered-heading'
import { cnMark } from './mark-text'
import { pageBoxMm } from './paginate'
import previewCss from './preview.css?raw'
import type { ThemeName } from '@shared/types'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    if (lang && lang.length < 32) {
      const name = lang.toLowerCase()
      if (hljs.getLanguage(name)) {
        try {
          const result = hljs.highlight(code, { language: name, ignoreIllegals: true })
          return `<pre class="hljs"><code class="language-${escapeHtml(name)}">${result.value}</code></pre>`
        } catch {
          // 落到下面的兜底
        }
      }
    }
    if (code.length <= 4000) {
      try {
        const auto = hljs.highlightAuto(code)
        return `<pre class="hljs"><code>${auto.value}</code></pre>`
      } catch {
        // 落到 markdown-it 默认转义
      }
    }
    return ''
  }
})

// 自定义居中标题语法：`#@ 标题`
md.use(centeredHeading)
// 自定义标记语法：`【文字】`
md.use(cnMark)

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderMarkdown(text: string): string {
  return md.render(text)
}

export interface PreviewHandlers {
  onOpenFile: (rel: string) => void
  onExternal: (url: string) => void
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 把 baseDirAbs 和相对路径拼成一个 file:// URL */
function toFileUrl(baseDirAbs: string, relative: string): string {
  const segments = safeDecode(relative).split(/[\\/]+/)
  const out = baseDirAbs.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(segment)
  }
  return `file:///${encodeURI(out.join('/'))}`
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i

/** 把 img / video / audio / source 里的相对路径改成绝对 file:// 路径 */
export function rewriteRelativeUrls(container: HTMLElement, docDirAbs: string | null): void {
  if (!docDirAbs) return
  const nodes = container.querySelectorAll('img, video, audio, source')
  for (const node of nodes) {
    const value = node.getAttribute('src')
    if (!value) continue
    if (ABSOLUTE_URL.test(value) || value.startsWith('//')) continue
    node.setAttribute('src', toFileUrl(docDirAbs, value))
  }
}

/** 相对链接 -> 文件库相对路径，处理 ../ 和开头的 / */
export function resolveVaultPath(baseDirRel: string, target: string): string {
  const decoded = safeDecode(target).replace(/^\/+/, '')
  const parts = (baseDirRel ? baseDirRel.split('/') : []).concat(decoded.split('/'))
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

function isMarkdownLink(target: string): boolean {
  return /\.(md|markdown|mdx|txt)$/i.test(target.split('#')[0] ?? '')
}

export function decorateLinks(
  container: HTMLElement,
  getBaseDirRel: () => string,
  handlers: PreviewHandlers
): void {
  container.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    if (href.startsWith('#')) return

    event.preventDefault()
    if (ABSOLUTE_URL.test(href) && !href.startsWith('file:')) {
      if (/^https?:|^mailto:/i.test(href)) handlers.onExternal(href)
      return
    }
    const clean = href.replace(/^file:\/\/\//i, '')
    const hashIndex = clean.indexOf('#')
    const path = hashIndex === -1 ? clean : clean.slice(0, hashIndex)
    if (isMarkdownLink(path)) {
      handlers.onOpenFile(resolveVaultPath(getBaseDirRel(), path))
    }
  })
}

export interface TextStats {
  /** 中文按字算，英文按词算 */
  words: number
  /** 不含空白字符的字符数 */
  chars: number
  lines: number
  paragraphs: number
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/g
const LATIN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g

export function countText(text: string): TextStats {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.match(LATIN_WORD)?.length ?? 0
  const chars = text.replace(/\s/g, '').length
  const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length
  const paragraphs = text.split(/\r\n\r\n|\n\n|\r\r/).filter((block) => block.trim().length > 0).length
  return { words: cjk + latin, chars, lines, paragraphs }
}

const PRINT_CSS = `
@page { margin: 0; }
html, body { background: #ffffff !important; margin: 0; padding: 0; }
body.print-document {
  color: #2f2c29;
  font-family: 'MiSans', var(--preview-font, 'Microsoft YaHei', 'PingFang SC', sans-serif);
  letter-spacing: 0.012em;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.markdown-body { max-width: none !important; margin: 0 !important; padding: 0 !important; font-size: 11.5pt; line-height: 1.75; }
.markdown-body h1 { font-size: 19pt; }
.markdown-body h2 { font-size: 15pt; }
.markdown-body h3 { font-size: 13pt; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 {
  page-break-after: avoid;
  break-after: avoid;
}
.markdown-body p, .markdown-body li, .markdown-body blockquote, .markdown-body table, .markdown-body figure, .markdown-body img {
  page-break-inside: avoid;
  break-inside: avoid;
}
.markdown-body h1 { page-break-before: auto; }
.markdown-body pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.markdown-body code { word-break: break-word; }
.markdown-body img { max-width: 100%; height: auto; }
.markdown-body table { width: 100%; }
.markdown-body a { color: inherit; text-decoration: none; }
`

export interface PrintDocumentArgs {
  title: string
  bodyHtml: string
  docDirAbs: string | null
  theme: ThemeName
  /** 用户在设置里调的行距与段后距，导出时要跟着一起变 */
  typography?: { lineHeight: number; paragraphGap: number; fontPt?: number; indent?: boolean }
  /** 自己分好页了：打印时不要再让 Chromium 断页，也不要页眉页脚 */
  paginated?: { pageSize: string; marginMm: number; markColor: string }
}

/**
 * 生成一个自带样式、可以直接打印的完整 HTML 文档。
 * 主进程会在 <head> 里补一个 <base>，用来解析图片的相对路径。
 */
export function buildPrintDocument(args: PrintDocumentArgs): string {
  const holder = document.createElement('div')
  holder.className = 'markdown-body'
  holder.innerHTML = args.bodyHtml
  rewriteRelativeUrls(holder, args.docDirAbs)

  // preview.css 里的行距/段后距是 var(--…, 默认值)，导出文档里没有 styles.css，
  // 所以把用户设置显式写成变量，否则导出会退回默认值。
  const vars: string[] = []
  if (args.typography) {
    vars.push(`--preview-line-height:${args.typography.lineHeight}`)
    vars.push(`--preview-para-gap:${args.typography.paragraphGap}em`)
  }
  if (args.paginated) {
    vars.push(`--preview-mark:${args.paginated.markColor}`)
    const size = pageBoxMm(args.paginated.pageSize)
    vars.push(`--page-width:${size.width}mm`)
    vars.push(`--page-height:${size.height}mm`)
    vars.push(`--page-margin:${args.paginated.marginMm}mm`)
  }
  const typographyCss = vars.length > 0 ? `:root{${vars.join(';')}}` : ''

  // 自己的分页：每个 .md-page 严丝合缝是一张纸，让它逐页断开即可
  const pagedCss = args.paginated
    ? `@page{size:${args.paginated.pageSize};margin:0}
html,body{margin:0;padding:0;background:#fff}
.print-document .md-page{break-after:page;box-shadow:none;margin:0}
.print-document .md-page:last-child{break-after:auto}`
    : ''

  return `<!doctype html>
<html lang="zh-CN" data-theme="${args.theme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(args.title)}</title>
<style>
${typographyCss}
${previewCss}
${PRINT_CSS}
${pagedCss}
</style>
</head>
<body class="print-document">
${args.paginated ? holder.innerHTML : `<article class="markdown-body">${holder.innerHTML}</article>`}
</body>
</html>`
}
