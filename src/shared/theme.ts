/**
 * 标题栏与窗口底色。
 *
 * 窗口用的是「无边框 + 系统绘制窗口按钮」（titleBarOverlay）方案：
 * 原生标题栏被隐藏，Windows 只在右上角画出最小化/最大化/关闭三个按钮，
 * 按钮区域和符号的颜色由这里指定，从而和应用自己的顶栏颜色严丝合缝。
 *
 * 注意：这里的颜色必须和 src/renderer/src/styles.css 里的
 * --topbar-bg / --fg 保持一致，改配色时两处一起改。
 */
import type { ThemeName } from './types'

export interface TitleBarTheme {
  /** 窗口按钮所在区域的底色 */
  color: string
  /** 最小化/最大化/关闭符号的颜色 */
  symbolColor: string
}

export const TITLE_BAR_THEME: Record<ThemeName, TitleBarTheme> = {
  light: { color: '#f4f2ee', symbolColor: '#2f2c29' },
  dark: { color: '#16171a', symbolColor: '#d7d3cc' }
}

/** 窗口底色，用于避免启动瞬间或缩放时闪白 */
export const WINDOW_BACKGROUND: Record<ThemeName, string> = {
  light: '#f4f2ee',
  dark: '#16171a'
}

/** 必须与 styles.css 里 .topbar 的高度一致 */
export const TITLE_BAR_HEIGHT = 44

/** Windows 的窗口按钮大约占多宽（会随 DPI 缩放，留点余量） */
export const WINDOW_CONTROLS_WIDTH = 148
