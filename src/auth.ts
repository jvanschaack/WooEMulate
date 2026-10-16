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

function invalidSecret(method: ProvidedCredentials['method']): AuthOutcome {
  return {
    status: 'error',
    code: 'woocommerce_rest_authentication_error',
    message: 'Consumer secret is invalid.',
    httpStatus: 401,
    headers: method === 'basic' ? { 'WWW-Authenticate': BASIC_AUTH_REALM } : undefined,
  }
}

function checkStaticKey(provided: ProvidedCredentials, key: WooEmulateAuthConfig): AuthOutcome {
  if (!key.consumerKey || !timingSafeEqual(provided.consumerKey, key.consumerKey)) {
    return { status: 'anonymous' }
  }
  if (!key.consumerSecret || !timingSafeEqual(provided.consumerSecret, key.consumerSecret)) {
    return invalidSecret(provided.method)
  }
  return { status: 'ok', key: { keyId: 1, permissions: 'read_write' } }
}

/** Resolves the credentials on a request to an API key. */
export async function authenticateApi(request: Request, config: WooEmulateConfig): Promise<AuthOutcome> {
  if (typeof config.auth === 'function') {
    const customResult = await config.auth(request)
    if ('authenticated' in customResult) {
      const result = customResult as WooEmulateAuthResult
      return result.authenticated
        ? { status: 'ok', key: { keyId: 1, permissions: 'read_write' } }
        : { status: 'anonymous', message: result.error, httpStatus: result.status }
    }
    const provided = readCredentials(request)
    return provided ? checkStaticKey(provided, customResult as WooEmulateAuthConfig) : { status: 'anonymous' }
  }

  const provided = readCredentials(request)
  if (!provided || !config.auth) return { status: 'anonymous' }
  return checkStaticKey(provided, config.auth)
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
