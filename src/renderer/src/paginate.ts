/**
 * 按纸张分页 + 自动目录。
 *
 * 为什么自己分页：浏览器在屏幕上不翻页，打印时又是 Chromium 按它的算法断页，
 * 两边不可能天然一致。要做到「预览和导出一模一样」，只能自己按块边界分页，
 * 然后把同一份分页结果同时交给预览和打印。
 *
 * 目录能算出准确页码，靠的也正是「页码是自己排的」——
 * 用 Chromium 自动分页的编辑器做不到这一点。
 */
import { MM_PER_PX, PAGE_SIZES_MM } from '@shared/defaults'

export interface PageLayout {
  pageSize: string
  marginMm: number
  pageNumbers: boolean
  /** 在最前面生成目录（分页模式下有效） */
  toc?: boolean
}

export interface Heading {
  level: number
  text: string
  /** 相对正文第一页的页码（1 开始） */
  page: number
}

export interface PaginateResult {
  /** 每页的 HTML 片段 */
  pages: string[]
  /** 是否存在超过一页高度的单个块 */
  overflow: boolean
  /** 抽出来的标题（用于目录、也可以给大纲用） */
  headings: Heading[]
}

export function pageBoxMm(pageSize: string): { width: number; height: number } {
  return PAGE_SIZES_MM[pageSize] ?? (PAGE_SIZES_MM['A4'] as { width: number; height: number })
}

/** 页面尺寸与页边距写成 CSS 变量，预览和打印共用同一套 */
export function pageVars(layout: PageLayout): Record<string, string> {
  const size = pageBoxMm(layout.pageSize)
  return {
    '--page-width': `${size.width}mm`,
    '--page-height': `${size.height}mm`,
    '--page-margin': `${layout.marginMm}mm`
  }
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function renderPage(
  blocks: HTMLElement[],
  index: number,
  total: number,
  pageNumbers: boolean
): string {
  const number = index + 1
  const footer = pageNumbers ? `<div class="md-page-no">${number} / ${total}</div>` : ''
  return (
    `<section class="md-page" data-page="${number}">` +
    `<div class="md-page-body markdown-body">${blocks.map((block) => block.outerHTML).join('')}</div>` +
    footer +
    '</section>'
  )
}

/** 量一次高度：容器宽度必须和真实正文宽度一致，否则量出来的高度不作数 */
function measureContainer(layout: PageLayout): { sandbox: HTMLElement; host: HTMLElement } {
  const size = pageBoxMm(layout.pageSize)
  const sandbox = document.createElement('div')
  sandbox.className = 'md-measure-sandbox'
  const host = document.createElement('div')
  host.className = 'md-page-body markdown-body md-measure'
  host.style.width = `${(size.width - layout.marginMm * 2) * MM_PER_PX}px`
  sandbox.append(host)
  document.body.append(sandbox)
  return { sandbox, host }
}

interface BlockGrouping {
  groups: HTMLElement[][]
  headings: Heading[]
  overflow: boolean
}

/** 把一批块按页高切分 */
function groupBlocks(blocks: HTMLElement[], layout: PageLayout): BlockGrouping {
  const size = pageBoxMm(layout.pageSize)
  const contentHeightPx = (size.height - layout.marginMm * 2) * MM_PER_PX
  const { sandbox, host } = measureContainer(layout)
  for (const block of blocks) host.append(block)

  const groups: HTMLElement[][] = []
  let current: HTMLElement[] = []
  let pageTop = 0
  let overflow = false
  const origin = host.getBoundingClientRect().top
  const headings: Heading[] = []

  for (const block of [...host.children] as HTMLElement[]) {
    const rect = block.getBoundingClientRect()
    const top = rect.top - origin
    const bottom = rect.bottom - origin
    const height = bottom - top

    if (bottom - pageTop > contentHeightPx && current.length > 0) {
      groups.push(current)
      current = []
      pageTop = top
    }
    if (height > contentHeightPx) overflow = true
    if (HEADING_TAGS.has(block.tagName)) {
      headings.push({
        level: Number(block.tagName.slice(1)),
        text: block.textContent ?? '',
        page: groups.length + 1
      })
    }
    current.push(block)
  }
  if (current.length > 0) groups.push(current)

  sandbox.remove()
  return { groups, headings, overflow }
}

function renderTocBlocks(headings: Heading[], offset: number): HTMLElement[] {
  const title = document.createElement('div')
  title.className = 'md-toc-title'
  title.textContent = '目录'
  const blocks: HTMLElement[] = [title]
  for (const heading of headings) {
    const item = document.createElement('div')
    item.className = `md-toc-item lv${Math.min(heading.level, 6)}`
    const text = document.createElement('span')
    text.className = 'md-toc-text'
    text.textContent = heading.text
    const dots = document.createElement('span')
    dots.className = 'md-toc-dots'
    const page = document.createElement('span')
    page.className = 'md-toc-page'
    page.textContent = String(heading.page + offset)
    item.append(text, dots, page)
    blocks.push(item)
  }
  return blocks
}

/** 从一段 HTML 里切出顶层块 */
function blocksFromHtml(html: string, layout: PageLayout): HTMLElement[] {
  const { sandbox, host } = measureContainer(layout)
  host.innerHTML = html
  const blocks = [...host.children] as HTMLElement[]
  // 先把元素摘出来，measure 容器整块丢掉再复用这批节点
  for (const block of blocks) block.remove()
  sandbox.remove()
  return blocks
}

export function paginate(bodyHtml: string, layout: PageLayout): PaginateResult {
  const content = groupBlocks(blocksFromHtml(bodyHtml, layout), layout)

  if (!layout.toc || content.headings.length === 0) {
    const total = content.groups.length
    return {
      pages: content.groups.map((blocks, index) => renderPage(blocks, index, total, layout.pageNumbers)),
      overflow: content.overflow,
      headings: content.headings
    }
  }

  /*
   * 目录页数会影响正文的页号，而正文页号又写进目录里 —— 先试算一轮拿到目录页数，
   * 再用这个偏移重建目录。目录条目高度基本不随页码宽度变化，两轮足够收敛。
   */
  let offset = 1
  let tocGroups = groupBlocks(renderTocBlocks(content.headings, offset), layout).groups
  offset = tocGroups.length
  tocGroups = groupBlocks(renderTocBlocks(content.headings, offset), layout).groups
  offset = tocGroups.length

  const total = content.groups.length + offset
  const pages: string[] = []
  tocGroups.forEach((blocks, index) => pages.push(renderPage(blocks, index, total, layout.pageNumbers)))
  content.groups.forEach((blocks, index) => pages.push(renderPage(blocks, index + offset, total, layout.pageNumbers)))

  return { pages, overflow: content.overflow, headings: content.headings }
}
