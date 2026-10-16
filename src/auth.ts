/**
 * WooEMulate Authentication
 * Validates WooCommerce REST API credentials the way WooCommerce does: query-string
 * credentials first, then HTTP Basic, with constant-time secret comparison.
 */

import { CORS_HEADERS } from './http.js'
import type { WooEmulateAuthConfig, WooEmulateAuthResult, WooEmulateConfig } from './types.js'

/**
 * Standard WooCommerce REST API error response helper.
 */
export function wcErrorResponse(
  code: string,
  message: string,
  status = 400,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      code,
      message,
      data: { status },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Robots-Tag': 'noindex',
        ...CORS_HEADERS,
        ...extraHeaders,
      },
    }
  )
}

export const BASIC_AUTH_REALM =
  'Basic realm="WooCommerce API. Use a consumer key in the username field and a consumer secret in the password field."'

export interface ResolvedApiKey {
  keyId: number
  permissions: 'read' | 'write' | 'read_write'
  userId?: string | number
}

/**
 * Outcome of credential checks:
 * - `ok`: a key authenticated the request.
 * - `anonymous`: no usable credentials, or an unknown key. The route's own "cannot view/edit"
 *   error applies, as in WooCommerce.
 * - `error`: credentials were rejected with a specific error (for example an invalid secret).
 */
export type AuthOutcome =
  | { status: 'ok'; key: ResolvedApiKey }
  | { status: 'anonymous'; message?: string; httpStatus?: number }
  | { status: 'error'; code: string; message: string; httpStatus: number; headers?: Record<string, string> }

/** Compares two strings without short-circuiting on the first difference. */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

interface ProvidedCredentials {
  consumerKey: string
  consumerSecret: string
  method: 'query' | 'basic'
}

interface KnownKey extends ResolvedApiKey {
  consumerKey: string
  consumerSecret: string
}

function readCredentials(request: Request): ProvidedCredentials | null {
  try {
    const query = new URL(request.url).searchParams
    const key = query.get('consumer_key')
    const secret = query.get('consumer_secret')
    if (key && secret) return { consumerKey: key, consumerSecret: secret, method: 'query' }
  } catch {
    // ignore URL parsing error
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
    try {
      // atob is available in modern Web, Node 16+, Cloudflare Workers, Deno, Bun
      const decoded = atob(authHeader.slice(6).trim())
      const colonIndex = decoded.indexOf(':')
      if (colonIndex > 0 && colonIndex < decoded.length - 1) {
        return {
          consumerKey: decoded.slice(0, colonIndex),
          consumerSecret: decoded.slice(colonIndex + 1),
          method: 'basic',
        }
      }
    } catch {
      // ignore base64 decode failure
    }
  }
  return null
}

function invalidSecret(method?: ProvidedCredentials['method']): AuthOutcome {
  return {
    status: 'error',
    code: 'woocommerce_rest_authentication_error',
    message: 'Consumer secret is invalid.',
    httpStatus: 401,
    headers: method === 'basic' ? { 'WWW-Authenticate': BASIC_AUTH_REALM } : undefined,
  }
}

function fromStatic(key: WooEmulateAuthConfig): KnownKey {
  return {
    keyId: key.keyId ?? 1,
    permissions: key.permissions ?? 'read_write',
    consumerKey: key.consumerKey,
    consumerSecret: key.consumerSecret,
  }
}

/**
 * Finds the key for a consumer key: the key store first, then the static or resolved `auth`
 * key. Returns null for unknown keys and a final outcome when a custom resolver decided.
 */
async function findKey(
  request: Request,
  config: WooEmulateConfig,
  consumerKey: string
): Promise<KnownKey | AuthOutcome | null> {
  if (config.apiKeys) {
    const stored = await config.apiKeys.findApiKey(consumerKey)
    if (stored && timingSafeEqual(stored.consumerKey, consumerKey)) {
      return {
        keyId: stored.keyId,
        permissions: stored.permissions,
        userId: stored.userId,
        consumerKey: stored.consumerKey,
        consumerSecret: stored.consumerSecret,
      }
    }
  }
  if (!config.auth) return null
  const resolved = typeof config.auth === 'function' ? await config.auth(request) : config.auth
  if ('authenticated' in resolved) {
    const result = resolved as WooEmulateAuthResult
    return result.authenticated
      ? { status: 'ok', key: { keyId: 1, permissions: 'read_write' } }
      : { status: 'anonymous', message: result.error, httpStatus: result.status }
  }
  const key = resolved as WooEmulateAuthConfig
  return key.consumerKey && timingSafeEqual(consumerKey, key.consumerKey) ? fromStatic(key) : null
}

function isOutcome(value: KnownKey | AuthOutcome | null): value is AuthOutcome {
  return Boolean(value && 'status' in value)
}

/** Resolves the credentials on a request to an API key. */
export async function authenticateApi(request: Request, config: WooEmulateConfig): Promise<AuthOutcome> {
  const provided = readCredentials(request)
  if (provided) {
    const key = await findKey(request, config, provided.consumerKey)
    if (isOutcome(key)) return key
    if (!key) return { status: 'anonymous' }
    if (!key.consumerSecret || !timingSafeEqual(provided.consumerSecret, key.consumerSecret)) {
      return invalidSecret(provided.method)
    }
    return { status: 'ok', key: { keyId: key.keyId, permissions: key.permissions, userId: key.userId } }
  }

  if (config.oauth1) {
    const outcome = await authenticateOAuth1(request, config)
    if (outcome) return outcome
  }

  // A custom resolver may authenticate requests that carry no WooCommerce credentials.
  if (typeof config.auth === 'function') {
    const resolved = await config.auth(request)
    if ('authenticated' in resolved) {
      const result = resolved as WooEmulateAuthResult
      return result.authenticated
        ? { status: 'ok', key: { keyId: 1, permissions: 'read_write' } }
        : { status: 'anonymous', message: result.error, httpStatus: result.status }
    }
  }
  return { status: 'anonymous' }
}

// ---------------------------------------------------------------------------------------------
// OAuth 1.0a (one-legged), as WooCommerce accepts it for plain-HTTP stores.

const OAUTH_REQUIRED = ['oauth_consumer_key', 'oauth_timestamp', 'oauth_nonce', 'oauth_signature', 'oauth_signature_method']
const OAUTH_WINDOW_SECONDS = 15 * 60

/** PHP `rawurlencode`: RFC 3986 percent-encoding. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function readOAuthHeader(request: Request): Record<string, string> {
  const header = request.headers.get('authorization') || ''
  if (!/^oauth\s/i.test(header)) return {}
  const params: Record<string, string> = {}
  for (const match of header.slice(6).matchAll(/([\w-]+)="([^"]*)"/g)) {
    try {
      params[match[1]] = decodeURIComponent(match[2])
    } catch {
      params[match[1]] = match[2]
    }
  }
  return params
}

function oauthError(message: string): AuthOutcome {
  return { status: 'error', code: 'woocommerce_rest_authentication_error', message, httpStatus: 401 }
}

/** Builds WooCommerce's OAuth 1.0a signature base string. */
export function oauthBaseString(method: string, url: URL, params: Record<string, string>): string {
  const keys = Object.keys(params).filter((key) => key !== 'oauth_signature').sort()
  const pairs = keys.map((key) => rfc3986(`${rfc3986(key)}=${rfc3986(params[key])}`))
  return `${method.toUpperCase()}&${rfc3986(url.origin + url.pathname)}&${pairs.join('%26')}`
}

async function hmacBase64(algorithm: 'SHA-1' | 'SHA-256', key: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: algorithm }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Returns null when the request carries no OAuth 1.0a parameters. */
async function authenticateOAuth1(request: Request, config: WooEmulateConfig): Promise<AuthOutcome | null> {
  const url = new URL(request.url)
  const params: Record<string, string> = {}
  for (const [key, value] of url.searchParams) params[key] = value
  if (
    request.method !== 'GET' && request.method !== 'HEAD' &&
    (request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')
  ) {
    for (const [key, value] of new URLSearchParams(await request.clone().text())) params[key] = value
  }
  Object.assign(params, readOAuthHeader(request))
  if (!params.oauth_consumer_key) return null

  const missing = OAUTH_REQUIRED.filter((name) => !params[name])
  if (missing.length) return oauthError(`Missing OAuth parameter ${missing.join(', ')}`)

  const key = await findKey(request, config, params.oauth_consumer_key)
  if (isOutcome(key)) return key.status === 'ok' ? oauthError('Consumer key is invalid.') : key
  if (!key) return oauthError('Consumer key is invalid.')

  const method = params.oauth_signature_method.toUpperCase()
  if (method !== 'HMAC-SHA1' && method !== 'HMAC-SHA256') {
    return oauthError('Invalid signature - signature method is invalid.')
  }
  const expected = await hmacBase64(
    method === 'HMAC-SHA1' ? 'SHA-1' : 'SHA-256',
    `${key.consumerSecret}&`,
    oauthBaseString(request.method, url, params)
  )
  let provided = params.oauth_signature.replace(/ /g, '+')
  try {
    provided = decodeURIComponent(provided)
  } catch {
    // keep the raw value
  }
  if (!timingSafeEqual(provided, expected)) {
    return oauthError('Invalid signature - provided signature does not match.')
  }

  const timestamp = Number(params.oauth_timestamp)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > OAUTH_WINDOW_SECONDS) {
    return oauthError('Invalid timestamp.')
  }
  if (!(await config.oauth1!.useNonce(key.consumerKey, params.oauth_nonce, timestamp))) {
    return oauthError('Invalid nonce - nonce has already been used.')
  }
  return { status: 'ok', key: { keyId: key.keyId, permissions: key.permissions, userId: key.userId } }
}

/** Checks that a key may use the request method. OPTIONS never reaches this check. */
export function checkKeyPermission(key: ResolvedApiKey, method: string): AuthOutcome | null {
  const needsRead = method === 'GET' || method === 'HEAD'
  const allowed = needsRead
    ? key.permissions === 'read' || key.permissions === 'read_write'
    : key.permissions === 'write' || key.permissions === 'read_write'
  if (allowed) return null
  return {
    status: 'error',
    code: 'woocommerce_rest_authentication_error',
    message: `The API key provided does not have ${needsRead ? 'read' : 'write'} permissions.`,
    httpStatus: 401,
  }
}

/**
 * Extracts and validates credentials for an incoming request.
 * Kept for compatibility; the router uses `authenticateApi` directly.
 */
export async function authenticateRequest(
  request: Request,
  config: WooEmulateConfig
): Promise<WooEmulateAuthResult> {
  const outcome = await authenticateApi(request, config)
  if (outcome.status === 'ok') {
    const denied = checkKeyPermission(outcome.key, request.method)
    if (!denied) return { authenticated: true }
    return { authenticated: false, error: (denied as { message: string }).message, status: 401 }
  }
  if (outcome.status === 'error') {
    return { authenticated: false, error: outcome.message, status: outcome.httpStatus }
  }
  return {
    authenticated: false,
    error: outcome.message || 'Missing or invalid WooCommerce API credentials.',
    status: outcome.httpStatus || 401,
  }
}
