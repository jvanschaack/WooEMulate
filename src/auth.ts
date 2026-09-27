/**
 * WooEMulate Authentication
 * Validates WooCommerce REST API credentials via Basic Auth header or query params.
 */

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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-WP-Nonce',
        ...extraHeaders,
      },
    }
  )
}

/**
 * Extracts and validates credentials for an incoming request.
 */
export async function authenticateRequest(
  request: Request,
  config: WooEmulateConfig
): Promise<WooEmulateAuthResult> {
  // If custom auth function is provided, invoke it
  if (typeof config.auth === 'function') {
    const customResult = await config.auth(request)
    if ('authenticated' in customResult) {
      return customResult as WooEmulateAuthResult
    }
    return validateAgainstKeys(request, customResult as WooEmulateAuthConfig)
  }

  return validateAgainstKeys(request, config.auth)
}

function validateAgainstKeys(
  request: Request,
  authConfig: WooEmulateAuthConfig
): WooEmulateAuthResult {
  let providedKey: string | null = null
  let providedSecret: string | null = null

  // 1. Check HTTP Basic Authorization header
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization')
  if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const base64Credentials = authHeader.slice(6).trim()
      // atob is available in modern Web, Node 16+, Cloudflare Workers, Deno, Bun
      const decoded = atob(base64Credentials)
      const colonIndex = decoded.indexOf(':')
      if (colonIndex !== -1) {
        providedKey = decoded.slice(0, colonIndex)
        providedSecret = decoded.slice(colonIndex + 1)
      }
    } catch {
      // ignore base64 decode failure
    }
  }

  // 2. Check query parameters
  if (!providedKey || !providedSecret) {
    try {
      const url = new URL(request.url)
      providedKey = providedKey || url.searchParams.get('consumer_key')
      providedSecret = providedSecret || url.searchParams.get('consumer_secret')
    } catch {
      // ignore URL parsing error
    }
  }

  if (!providedKey || !providedSecret) {
    return {
      authenticated: false,
      error: 'Missing WooCommerce authentication credentials (consumer_key / consumer_secret required).',
      status: 401,
    }
  }

  const keyMatches = providedKey === authConfig.consumerKey
  const secretMatches = providedSecret === authConfig.consumerSecret

  if (!keyMatches || !secretMatches) {
    return {
      authenticated: false,
      error: 'Invalid WooCommerce Consumer Key or Consumer Secret.',
      status: 401,
    }
  }

  return { authenticated: true }
}
