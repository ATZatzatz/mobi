import type { MobiApi } from '@shared/api'
import type { Result } from '@shared/types'

declare global {
  interface Window {
    mobi: MobiApi
  }
}

/** 由 preload 注入的窄接口 */
export const api: MobiApi = window.mobi

export function isOk<T>(result: Result<T>): result is { ok: true; data: T } {
  return result.ok
}

/** 取数据，失败就抛错。调用方在最外层统一 catch，然后弹提示。 */
export function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

/** 出错时返回兜底值，不打断主流程 */
export function fallback<T>(result: Result<T>, value: T): T {
  return result.ok ? result.data : value
}
