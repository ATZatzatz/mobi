/**
 * 轻量模态框。
 *
 * 为什么不用 window.prompt：Electron 里 Chromium 直接禁用了 prompt，
 * 调它只会返回 null，必须自己实现。
 */
import { api } from './api'
import { TYPOGRAPHY_DEFAULTS, TYPOGRAPHY_RANGE } from '@shared/defaults'
import { byId, el } from './dom'

export interface PromptOptions {
  title: string
  label?: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 默认选中扩展名之前的部分，重命名时很顺手 */
  selectStem?: boolean
}

export function promptText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'modal-input',
      type: 'text',
      value: options.value ?? '',
      placeholder: options.placeholder ?? ''
    })

    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(value)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    }

    const form = el('form', { class: 'modal-form', method: 'dialog' }, [
      el('div', { class: 'modal-title', text: options.title }),
      options.label ? el('div', { class: 'modal-label', text: options.label }) : null,
      input
    ])

    const dialog = el('dialog', { class: 'modal' }, [
      form,
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: options.cancelLabel ?? '取消',
          onclick: () => finish(null)
        }),
        el('button', {
          class: 'btn primary',
          type: 'button',
          text: options.confirmLabel ?? '确定',
          onclick: () => finish(input.value)
        })
      ])
    ])

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      finish(input.value)
    })

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(null)
    })

    document.addEventListener('keydown', onKey, true)
    byId('app').append(dialog)
    dialog.showModal()
    input.focus()

    if (options.selectStem) {
      const dot = input.value.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
    } else {
      input.select()
    }
  })
}

/* ------------------------------ 设置面板 ------------------------------ */

export interface SettingsDialogResult {
  autosaveMs: number
  showLineNumbers: boolean
  previewVisible: boolean
  previewOnly: boolean
  previewPageMode: boolean
  markColor: string
  previewFontPt: number
  paragraphIndent: boolean
  pdfToc: boolean
  exportDir: string | null
  backupDir: string | null
  editorLineHeight: number
  previewLineHeight: number
  previewParagraphGap: number
  pageSize: 'A4' | 'A5' | 'A3' | 'Letter'
  marginMm: number
  pageNumbers: boolean
  printBackground: boolean
}

export interface SettingsDialogOptions {
  version?: string
  /** 点「立即备份」时执行，返回的 Promise 用来控制按钮的忙碌态 */
  onBackup?: () => Promise<void>
  /** 当前界面缩放级别 */
  zoomLevel?: number
  /** 点缩放按钮时执行，返回新的级别 */
  onZoom?: (action: 'in' | 'out' | 'reset') => Promise<number>
}

export function openSettingsDialog(
  current: SettingsDialogResult,
  options: SettingsDialogOptions = {}
): Promise<SettingsDialogResult | null> {
  return new Promise((resolve) => {
    const numberInput = (value: number, step: number, min: number, max: number): HTMLInputElement =>
      el('input', {
        class: 'modal-input',
        type: 'number',
        step: String(step),
        min: String(min),
        max: String(max),
        value: String(value)
      }) as HTMLInputElement

    const autosave = numberInput(current.autosaveMs, 100, 300, 30000)
    autosave.dataset['field'] = 'autosave'
    const editorLineHeight = numberInput(
      current.editorLineHeight,
      TYPOGRAPHY_RANGE.lineHeight.step,
      TYPOGRAPHY_RANGE.lineHeight.min,
      TYPOGRAPHY_RANGE.lineHeight.max
    )
    const previewLineHeight = numberInput(
      current.previewLineHeight,
      TYPOGRAPHY_RANGE.lineHeight.step,
      TYPOGRAPHY_RANGE.lineHeight.min,
      TYPOGRAPHY_RANGE.lineHeight.max
    )
    const paragraphGap = numberInput(
      current.previewParagraphGap,
      TYPOGRAPHY_RANGE.paragraphGap.step,
      TYPOGRAPHY_RANGE.paragraphGap.min,
      TYPOGRAPHY_RANGE.paragraphGap.max
    )
    const fontPt = numberInput(
      current.previewFontPt,
      TYPOGRAPHY_RANGE.fontSizePt.step,
      TYPOGRAPHY_RANGE.fontSizePt.min,
      TYPOGRAPHY_RANGE.fontSizePt.max
    )
    fontPt.dataset['field'] = 'previewFontPt'
    const indent = el('input', { type: 'checkbox' })
    indent.checked = current.paragraphIndent
    indent.dataset['field'] = 'paragraphIndent'
    const toc = el('input', { type: 'checkbox' })
    toc.checked = current.pdfToc
    toc.dataset['field'] = 'pdfToc'

    // 两个目录选择：默认导出目录 / 备份目录
    let exportDir = current.exportDir
    let backupDir = current.backupDir
    const exportDirText = el('div', { class: 'right-path', text: exportDir ?? '（未设置，导出时每次询问）', title: exportDir ?? '' })
    const backupDirText = el('div', { class: 'right-path', text: backupDir ?? '（未设置，一键备份时会先让你选一次）', title: backupDir ?? '' })
    const dirRow = (label: string, text: HTMLElement, title: string, apply: (dir: string) => void): HTMLElement => {
      const pick = el('button', {
        class: 'btn',
        type: 'button',
        text: '选择…',
        onclick: async () => {
          const result = await api.chooseDirectory(title)
          if (!result.ok || result.data === null) return
          apply(result.data)
        }
      })
      return el('div', { class: 'modal-row' }, [
        el('div', { class: 'modal-row-main' }, [el('label', { class: 'modal-row-label', text: label }), pick]),
        text
      ])
    }
    editorLineHeight.dataset['field'] = 'editorLineHeight'
    previewLineHeight.dataset['field'] = 'previewLineHeight'
    paragraphGap.dataset['field'] = 'paragraphGap'

    const lineNumbers = el('input', { type: 'checkbox' })
    lineNumbers.checked = current.showLineNumbers
    lineNumbers.dataset['field'] = 'showLineNumbers'
    const preview = el('input', { type: 'checkbox' })
    preview.checked = current.previewVisible
    preview.dataset['field'] = 'previewVisible'
    const pageMode = el('input', { type: 'checkbox' })
    pageMode.checked = current.previewPageMode
    pageMode.dataset['field'] = 'previewPageMode'
    const markColor = el('input', { class: 'modal-input modal-color', type: 'color' })
    markColor.value = current.markColor
    markColor.dataset['field'] = 'markColor'
    const pageNumbers = el('input', { type: 'checkbox' })
    pageNumbers.checked = current.pageNumbers
    pageNumbers.dataset['field'] = 'pageNumbers'
    const printBackground = el('input', { type: 'checkbox' })
    printBackground.checked = current.printBackground
    printBackground.dataset['field'] = 'printBackground'

    const pageSize = el('select', { class: 'modal-input' })
    for (const size of ['A4', 'A5', 'A3', 'Letter'] as const) {
      const option = el('option', { value: size, text: size })
      if (size === current.pageSize) option.selected = true
      pageSize.append(option)
    }

    const margin = numberInput(current.marginMm, 1, 5, 60)
    margin.dataset['field'] = 'marginMm'

    const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
      el('div', { class: 'modal-row' }, [
        el('div', { class: 'modal-row-main' }, [el('label', { class: 'modal-row-label', text: label }), control]),
        hint ? el('div', { class: 'modal-hint', text: hint }) : null
      ])

    const resetTypography = el('button', {
      class: 'link',
      type: 'button',
      text: '恢复默认行距 / 段后',
      onclick: () => {
        editorLineHeight.value = String(TYPOGRAPHY_DEFAULTS.editorLineHeight)
        previewLineHeight.value = String(TYPOGRAPHY_DEFAULTS.previewLineHeight)
        paragraphGap.value = String(TYPOGRAPHY_DEFAULTS.previewParagraphGap)
      }
    })

    // 界面缩放：立刻生效（不等「保存」），方便一边看一边调
    let zoomLevel = options.zoomLevel ?? 0
    const zoomLabel = el('span', {
      class: 'modal-zoom-value',
      text: `${Math.round(1.2 ** zoomLevel * 100)}%`
    })
    const zoom = async (action: 'in' | 'out' | 'reset'): Promise<void> => {
      if (!options.onZoom) return
      zoomLevel = await options.onZoom(action)
      zoomLabel.textContent = `${Math.round(1.2 ** zoomLevel * 100)}%`
    }

    const backupButton = el('button', {
      class: 'btn',
      type: 'button',
      text: '立即备份'
    })
    backupButton.addEventListener('click', () => {
      if (!options.onBackup) return
      backupButton.disabled = true
      const original = backupButton.textContent
      backupButton.textContent = '备份中…'
      void options
        .onBackup()
        .catch(() => undefined)
        .finally(() => {
          backupButton.disabled = false
          backupButton.textContent = original
        })
    })

    let settled = false
    const finish = (value: SettingsDialogResult | null): void => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      resolve(value)
    }

    const dialog = el('dialog', { class: 'modal modal-wide' }, [
      el('div', { class: 'modal-form' }, [
        el('div', { class: 'modal-title', text: '设置' }),

        el('div', { class: 'modal-subtitle', text: '写作' }),
        row('自动保存延迟（毫秒）', autosave, '停止输入多久后写盘。默认 1500，越小越安全，但会产生更多次磁盘写入。'),
        row('显示行号', lineNumbers),
        row('显示预览栏', preview),
        row('预览分页显示（按纸张）', pageMode, '开启后预览按下方「纸张大小」分页，导出 PDF 会用同一份分页结果，两边完全一致。'),
        el('div', {
          class: 'modal-hint',
          text: '预览就是阅读模式：打开预览时源代码会收起来，预览只读、不能编辑。'
        }),

        el('div', { class: 'modal-sep' }),
        el('div', { class: 'modal-subtitle', text: '排版' }),
        row('编辑区行距', editorLineHeight),
        row('正文字号（pt）', fontPt, '预览和导出 PDF 共用同一个字号。'),
        row('预览与导出行距', previewLineHeight),
        row('段后距（em）', paragraphGap, '只作用于段落和引用；列表项不吃这个间距，保持紧凑。'),
        row('正文首行缩进两格', indent, '中文文稿习惯。下栏也有一个开关，写作时随手可切。'),
        row('【标记】文字颜色', markColor, '正文里用【】框起来的文字会用这个颜色显示。'),
        el('div', { class: 'modal-foot' }, [resetTypography]),

        el('div', { class: 'modal-sep' }),
        el('div', { class: 'modal-subtitle', text: '界面' }),
        el('div', { class: 'modal-row' }, [
          el('div', { class: 'modal-row-main' }, [
            el('label', { class: 'modal-row-label', text: '界面缩放' }),
            el('button', { class: 'btn', type: 'button', text: '－', title: '缩小  Ctrl+-', onclick: () => void zoom('out') }),
            zoomLabel,
            el('button', { class: 'btn', type: 'button', text: '＋', title: '放大  Ctrl+=', onclick: () => void zoom('in') }),
            el('button', { class: 'btn', type: 'button', text: '恢复', onclick: () => void zoom('reset') })
          ]),
          el('div', { class: 'modal-hint', text: '快捷键：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 恢复。' })
        ]),

        el('div', { class: 'modal-sep' }),
        el('div', { class: 'modal-subtitle', text: '导出 PDF' }),
        row('纸张大小', pageSize),
        row('页边距（毫米）', margin, '开启页码时下边距至少 15mm，否则页码会压到正文。'),
        row('显示页码', pageNumbers),
        row('打印背景色', printBackground, '关闭后标题底色、代码块背景不会出现在 PDF 里。'),
        row('生成目录', toc, '开启预览分页后有效：自动在最前面加一页目录，页码按实际排版算出来。'),
        dirRow('默认导出目录', exportDirText, '选择默认导出目录', (dir) => {
          exportDir = dir
          exportDirText.textContent = dir
          exportDirText.title = dir
        }),

        el('div', { class: 'modal-sep' }),
        el('div', { class: 'modal-subtitle', text: '备份' }),
        el('div', { class: 'modal-row' }, [
          el('div', { class: 'modal-row-main' }, [el('label', { class: 'modal-row-label', text: '把整个文档库复制一份' }), backupButton]),
          el('div', {
            class: 'modal-hint',
            text: '备份是在你选的位置新建一个带时间戳的文件夹，里面是普通的文稿文件夹，可以直接被网盘同步。不含回收站和历史快照。'
          })
        ]),
        dirRow('默认备份目录', backupDirText, '选择默认备份目录', (dir) => {
          backupDir = dir
          backupDirText.textContent = dir
          backupDirText.title = dir
        }),

        el('div', { class: 'modal-sep' }),
        el('div', { class: 'modal-foot' }, [
          el('button', {
            class: 'link',
            type: 'button',
            text: '打开回收站',
            onclick: () => void api.openSpecial('trash')
          }),
          el('button', {
            class: 'link',
            type: 'button',
            text: '打开数据目录',
            onclick: () => void api.openSpecial('data-dir')
          }),
          el('span', {
            class: 'modal-version',
            text: options.version ? `MobiWriter ${options.version}` : ''
          })
        ])
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => finish(null) }),
        el('button', {
          class: 'btn primary',
          type: 'button',
          text: '保存',
          onclick: () =>
            finish({
              autosaveMs: Number(autosave.value) || current.autosaveMs,
              showLineNumbers: lineNumbers.checked,
              previewVisible: preview.checked,
              previewOnly: current.previewOnly,
              previewPageMode: pageMode.checked,
              markColor: markColor.value || current.markColor,
              previewFontPt: Number(fontPt.value) || TYPOGRAPHY_DEFAULTS.previewFontPt,
              paragraphIndent: indent.checked,
              pdfToc: toc.checked,
              exportDir,
              backupDir,
              editorLineHeight: Number(editorLineHeight.value) || TYPOGRAPHY_DEFAULTS.editorLineHeight,
              previewLineHeight: Number(previewLineHeight.value) || TYPOGRAPHY_DEFAULTS.previewLineHeight,
              previewParagraphGap: Number.isFinite(Number(paragraphGap.value))
                ? Number(paragraphGap.value)
                : TYPOGRAPHY_DEFAULTS.previewParagraphGap,
              pageSize: pageSize.value as SettingsDialogResult['pageSize'],
              marginMm: Number(margin.value) || current.marginMm,
              pageNumbers: pageNumbers.checked,
              printBackground: printBackground.checked
            })
        })
      ])
    ])

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(null)
    })

    byId('app').append(dialog)
    dialog.showModal()
    autosave.focus()
  })
}
