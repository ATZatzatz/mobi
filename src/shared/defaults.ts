/**
 * 排版与阅读相关的默认值。
 *
 * 主进程（settings.ts 的默认值与取值范围）和渲染层（设置面板的「恢复默认」）
 * 都要用同一份，所以放在 shared 里，避免两边各写一遍写歪。
 */

export interface Typography {
  /** 正文字号（pt），预览与导出共用 */
  previewFontPt: number
  /** 编辑区行距 */
  editorLineHeight: number
  /** 预览与导出的行距 */
  previewLineHeight: number
  /** 预览与导出的段后距（em） */
  previewParagraphGap: number
}

export const TYPOGRAPHY_DEFAULTS: Typography = {
  previewFontPt: 12,
  editorLineHeight: 2,
  previewLineHeight: 1.85,
  previewParagraphGap: 1
}

export const TYPOGRAPHY_RANGE = {
  fontSizePt: { min: 8, max: 24, step: 0.5 },
  lineHeight: { min: 1.2, max: 3, step: 0.05 },
  paragraphGap: { min: 0, max: 3, step: 0.1 }
} as const

/** 【】标记文字的默认颜色（朱砂红） */
export const MARK_COLOR_DEFAULT = '#c0392b'

export const ZOOM_RANGE = { min: -4, max: 6 }

/** 纸张尺寸（毫米），预览分页与导出共用 */
export const PAGE_SIZES_MM: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  A3: { width: 297, height: 420 },
  Letter: { width: 215.9, height: 279.4 }
}

/** CSS 里 1 英寸 = 96 像素 */
export const MM_PER_PX = 96 / 25.4
