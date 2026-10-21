import { t } from '../i18n'

// HTTP client for /api/v1. Authentication is the HttpOnly session cookie;
// state-changing requests echo the CSRF cookie in X-CSRF-Token
// (double-submit). Nothing is cached in browser storage.

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const CSRF_COOKIE = 'portal_csrf'

function readCookie(name: string): string {
  const prefix = name + '='
  for (const part of document.cookie.split(';')) {
    const c = part.trim()
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length))
  }
  return ''
}

let unauthorizedHandler: (() => void) | null = null

/** Registers a callback invoked when the server answers 401. */
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn
}

export async function refreshCSRF(): Promise<void> {
  await fetch('/api/v1/auth/csrf', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json()
    if (body?.error) return new ApiError(res.status, body.error.code, body.error.message)
  } catch {
    // not JSON
  }
  if (res.status === 413) return new ApiError(413, 'payload_too_large', 'Request too large (413)')
  return new ApiError(res.status, 'http_' + res.status, `${t.app.loadError} (HTTP ${res.status})`)
}

type Body = unknown

async function request<T>(method: string, path: string, body?: Body, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = readCookie(CSRF_COOKIE)
  }
  let res: Response
  try {
    res = await fetch('/api/v1' + path, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'network', t.app.networkError)
  }
  if (!res.ok) {
    const err = await parseError(res)
    if (err.code === 'csrf_failed' && !retried) {
      await refreshCSRF()
      return request<T>(method, path, body, true)
    }
    if (err.status === 401 && unauthorizedHandler && !path.startsWith('/auth/login')) {
      unauthorizedHandler()
    }
    throw err
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('Content-Type') || ''
  if (!ct.includes('application/json')) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: Body) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: Body) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: Body) => request<T>('PATCH', path, body ?? {}),
  del: <T = void>(path: string) => request<T>('DELETE', path),
}

/** Builds a query string from an object, skipping empty values. Arrays repeat the key. */
export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    if (Array.isArray(v)) v.forEach((x) => x && sp.append(k, x))
    else sp.set(k, v === true ? '1' : String(v))
  }
  const s = sp.toString()
  return s ? '?' + s : ''
}

/**
 * Uploads one file with progress reporting (XMLHttpRequest exposes upload
 * progress, fetch does not). Retries once if the CSRF token was stale.
 */
export function uploadFile<T>(
  path: string,
  file: File,
  category: string,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const send = (retried: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/v1' + path + qs({ category }))
      xhr.withCredentials = true
      xhr.setRequestHeader('X-CSRF-Token', readCookie(CSRF_COOKIE))
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
      }
      xhr.onerror = () => reject(new ApiError(0, 'network', t.app.networkError))
      xhr.onload = async () => {
        let body: { error?: { code: string; message: string } } | undefined
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          body = undefined
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as T)
          return
        }
        const err = body?.error
          ? new ApiError(xhr.status, body.error.code, body.error.message)
          : new ApiError(xhr.status, 'http_' + xhr.status, `HTTP ${xhr.status}`)
        if (err.code === 'csrf_failed' && !retried) {
          await refreshCSRF()
          send(true).then(resolve, reject)
          return
        }
        if (err.status === 401 && unauthorizedHandler) unauthorizedHandler()
        reject(err)
      }
      const fd = new FormData()
      fd.append('file', file, file.name)
      xhr.send(fd)
    })
  return send(false)
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return t.app.loadError
}
