/**
 * 设置持久化。存放在 userData/settings.json，同样走原子写入。
 * 读取时对每个字段做校验和回落，坏掉的配置文件不会让程序起不来。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { atomicWriteText } from './atomic'
import { TYPOGRAPHY_DEFAULTS, TYPOGRAPHY_RANGE, MARK_COLOR_DEFAULT, ZOOM_RANGE } from '@shared/defaults'
import type { PageSize, PdfOptions, Settings, ThemeName, WindowBounds } from '@shared/types'

const PAGE_SIZES: PageSize[] = ['A4', 'A5', 'A3', 'Letter']
const AUTOSAVE_MIN = 300
const AUTOSAVE_MAX = 30000
const MARGIN_MIN = 5
const MARGIN_MAX = 60
const RECENT_LIMIT = 8

export function defaultSettings(): Settings {
  return {
    vaultPath: null,
    recentVaults: [],
    theme: 'light',
    autosaveMs: 1500,
    showLineNumbers: false,
    previewVisible: false,
    previewOnly: false,
    previewFontPt: TYPOGRAPHY_DEFAULTS.previewFontPt,
    paragraphIndent: false,
    editorLineHeight: TYPOGRAPHY_DEFAULTS.editorLineHeight,
    previewLineHeight: TYPOGRAPHY_DEFAULTS.previewLineHeight,
    previewParagraphGap: TYPOGRAPHY_DEFAULTS.previewParagraphGap,
    lastBackupDir: null,
    zoomLevel: 0,
    sidebarVisible: true,
    statusbarVisible: true,
    previewPageMode: false,
    pdfToc: true,
    markColor: MARK_COLOR_DEFAULT,
    rightPanelVisible: true,
    rightPanelTab: 'outline',
    outlineMaxLevel: 6,
    exportDir: null,
    backupDir: null,
    pdf: {
      pageSize: 'A4',
      marginMm: 20,
      pageNumbers: true,
      printBackground: true
    },
    windowBounds: null,
    lastOpenedFile: null
  }
}

let cache: Settings | null = null

export function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 取小数。
 * 注意不能复用 pickNumber：那个是给「自动保存毫秒」「页边距」这类整数用的，
 * 里面带 Math.round，会把 2.6 的行距四舍五入成 3。
 */
function pickFloat(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100))
}

function pickString(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 颜色只接受 #rgb / #rrggbb，避免把任意字符串塞进 CSS */
function pickColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed) ? trimmed : fallback
}

function normalizePdf(raw: unknown): PdfOptions {
  const fallback = defaultSettings().pdf
  if (!isRecord(raw)) return fallback
  const pageSize = PAGE_SIZES.includes(raw.pageSize as PageSize) ? (raw.pageSize as PageSize) : fallback.pageSize
  return {
    pageSize,
    marginMm: pickNumber(raw.marginMm, MARGIN_MIN, MARGIN_MAX, fallback.marginMm),
    pageNumbers: pickBoolean(raw.pageNumbers, fallback.pageNumbers),
    printBackground: pickBoolean(raw.printBackground, fallback.printBackground)
  }
}

function normalizeBounds(raw: unknown): WindowBounds | null {
  if (!isRecord(raw)) return null
  const width = pickNumber(raw.width, 400, 10000, 0)
  const height = pickNumber(raw.height, 300, 10000, 0)
  if (width < 400 || height < 300) return null
  return {
    x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? Math.round(raw.x) : 0,
    y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? Math.round(raw.y) : 0,
    width,
    height
  }
}

function normalize(raw: unknown): Settings {
  const fallback = defaultSettings()
  if (!isRecord(raw)) return fallback
  const recent = Array.isArray(raw.recentVaults)
    ? raw.recentVaults.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, RECENT_LIMIT)
    : []
  const theme: ThemeName = raw.theme === 'dark' ? 'dark' : 'light'
  return {
    vaultPath: pickString(raw.vaultPath, null),
    recentVaults: recent,
    theme,
    autosaveMs: pickNumber(raw.autosaveMs, AUTOSAVE_MIN, AUTOSAVE_MAX, fallback.autosaveMs),
    showLineNumbers: pickBoolean(raw.showLineNumbers, fallback.showLineNumbers),
    previewVisible: pickBoolean(raw.previewVisible, fallback.previewVisible),
    previewOnly: pickBoolean(raw.previewOnly, fallback.previewOnly),
    previewFontPt: pickFloat(
      raw.previewFontPt,
      TYPOGRAPHY_RANGE.fontSizePt.min,
      TYPOGRAPHY_RANGE.fontSizePt.max,
      fallback.previewFontPt
    ),
    paragraphIndent: pickBoolean(raw.paragraphIndent, fallback.paragraphIndent),
    pdfToc: pickBoolean(raw.pdfToc, fallback.pdfToc),
    editorLineHeight: pickFloat(
      raw.editorLineHeight,
      TYPOGRAPHY_RANGE.lineHeight.min,
      TYPOGRAPHY_RANGE.lineHeight.max,
      fallback.editorLineHeight
    ),
    previewLineHeight: pickFloat(
      raw.previewLineHeight,
      TYPOGRAPHY_RANGE.lineHeight.min,
      TYPOGRAPHY_RANGE.lineHeight.max,
      fallback.previewLineHeight
    ),
    previewParagraphGap: pickFloat(
      raw.previewParagraphGap,
      TYPOGRAPHY_RANGE.paragraphGap.min,
      TYPOGRAPHY_RANGE.paragraphGap.max,
      fallback.previewParagraphGap
    ),
    lastBackupDir: pickString(raw.lastBackupDir, null),
    zoomLevel: pickFloat(raw.zoomLevel, ZOOM_RANGE.min, ZOOM_RANGE.max, fallback.zoomLevel),
    sidebarVisible: pickBoolean(raw.sidebarVisible, fallback.sidebarVisible),
    statusbarVisible: pickBoolean(raw.statusbarVisible, fallback.statusbarVisible),
    previewPageMode: pickBoolean(raw.previewPageMode, fallback.previewPageMode),
    markColor: pickColor(raw.markColor, fallback.markColor),
    rightPanelVisible: pickBoolean(raw.rightPanelVisible, fallback.rightPanelVisible),
    rightPanelTab: ['outline', 'tools'].includes(String(raw.rightPanelTab))
      ? String(raw.rightPanelTab)
      : fallback.rightPanelTab,
    outlineMaxLevel: pickNumber(raw.outlineMaxLevel, 1, 6, fallback.outlineMaxLevel),
    exportDir: pickString(raw.exportDir, null),
    backupDir: pickString(raw.backupDir, null),
    pdf: normalizePdf(raw.pdf),
    windowBounds: normalizeBounds(raw.windowBounds),
    lastOpenedFile: pickString(raw.lastOpenedFile, null)
  }
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const text = await fs.readFile(settingsPath(), 'utf8')
    cache = normalize(JSON.parse(text))
  } catch {
    cache = defaultSettings()
  }
  return cache
}

export async function getSettings(): Promise<Settings> {
  return cache ?? (await loadSettings())
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = normalize({ ...current, ...patch })
  cache = next
  try {
    await atomicWriteText(settingsPath(), JSON.stringify(next, null, 2))
  } catch {
    // 设置写不进去不该阻断用户写作
  }
  return next
}

export async function pushRecentVault(vaultPath: string): Promise<Settings> {
  const current = await getSettings()
  const recent = [vaultPath, ...current.recentVaults.filter((item) => item !== vaultPath)].slice(0, RECENT_LIMIT)
  return patchSettings({ vaultPath, recentVaults: recent })
}

export async function removeRecentVault(vaultPath: string): Promise<Settings> {
  const current = await getSettings()
  return patchSettings({
    vaultPath: current.vaultPath === vaultPath ? null : current.vaultPath,
    recentVaults: current.recentVaults.filter((item) => item !== vaultPath)
  })
}
