/**
 * Opt-in WooCommerce connection authorization.
 * Credentials are released only after authenticated, same-origin owner approval.
 */
import { wcErrorResponse } from '../auth.js'
import type { WooEmulateApiKey, WooEmulateConfig, WooEmulateKeyPermissions, WooEmulateOAuthAuthorizedPayload } from '../types.js'

const privateHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
}

function error(code: string, message: string, status: number): Response {
  return wcErrorResponse(code, message, status, privateHeaders)
}

const REQUIRED_PARAMS = ['app_name', 'scope', 'user_id', 'return_url', 'callback_url'] as const
const SCOPES: WooEmulateKeyPermissions[] = ['read', 'write', 'read_write']
const SCOPE_TEXT: Record<WooEmulateKeyPermissions, string> = {
  read: 'read',
  write: 'write',
  read_write: 'read and write',
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseUrl(value: string | null, protocols: string[]): string | null {
  if (!value) return null
  // WooCommerce URL-decodes these parameters again, so accept values that were encoded twice.
  let candidate = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /%[0-9a-f]{2}/i.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      return null
    }
  }
  try {
    const url = new URL(candidate)
    if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) return null
    return url.href
  } catch {
    return null
  }
}

function httpsUrl(value: string | null): string | null {
  return parseUrl(value, ['https:'])
}

/** WooCommerce requires an HTTPS callback but allows an HTTP return URL. */
function returnUrlOf(value: string | null): string | null {
  return parseUrl(value, ['https:', 'http:'])
}

export async function handleOAuthAuthorize(
  config: WooEmulateConfig,
  request: Request
): Promise<Response> {
  const oauth = config.oauth
  if (!oauth || typeof oauth.authorize !== 'function') {
    return error('woocommerce_rest_oauth_disabled', 'One-click authorization is not configured.', 403)
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return error('woocommerce_rest_invalid_method', 'Method not allowed.', 405)
  }

  const url = new URL(request.url)
  const storeUrl = httpsUrl(config.store.url)
  if (!storeUrl || url.origin !== new URL(storeUrl).origin) {
    return error('woocommerce_rest_oauth_origin', 'Authorization must use the configured HTTPS store origin.', 403)
  }

  const missing = REQUIRED_PARAMS.find((name) => !url.searchParams.get(name))
  if (missing) {
    return error('woocommerce_rest_oauth_missing_param', `Missing parameter ${missing}.`, 400)
  }

  const callbackUrl = httpsUrl(url.searchParams.get('callback_url'))
  const returnUrl = returnUrlOf(url.searchParams.get('return_url'))
  if (
    !callbackUrl || !returnUrl ||
    !oauth.allowedCallbackUrls.some((allowed) => httpsUrl(allowed) === callbackUrl) ||
    !oauth.allowedReturnUrls.some((allowed) => returnUrlOf(allowed) === returnUrl)
  ) {
    return error('woocommerce_rest_oauth_url', 'Callback and return URLs must match configured HTTPS URLs.', 400)
  }

  // With a key store that can mint keys, each app gets its own key with the requested scope.
  // Otherwise the single configured key is shared, so the scope must match its permissions.
  const scope = url.searchParams.get('scope') as WooEmulateKeyPermissions
  if (!SCOPES.includes(scope)) {
    return error('woocommerce_rest_oauth_scope', 'Invalid scope. Use read, write, or read_write.', 400)
  }
  const mintsKeys = Boolean(config.apiKeys?.createApiKey)
  const sharedPermissions = config.auth && typeof config.auth === 'object' ? config.auth.permissions ?? 'read_write' : 'read_write'
  if (!mintsKeys && scope !== sharedPermissions) {
    return error('woocommerce_rest_oauth_scope', `Only ${sharedPermissions} credentials are available.`, 400)
  }

  const connection: WooEmulateOAuthAuthorizedPayload = {
    appName: url.searchParams.get('app_name')!,
    userId: url.searchParams.get('user_id')!,
    scope,
    callbackUrl,
    returnUrl,
  }

  // Browsers send Origin on an HTTPS form POST. Reject missing or foreign origins.
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(storeUrl).origin) {
    return error('woocommerce_rest_oauth_origin', 'Approval requires a same-origin POST.', 403)
  }

  let authorized = false
  try {
    authorized = (await oauth.authorize(request, connection)) === true
  } catch {
    authorized = false
  }
  if (!authorized) {
    if (request.method === 'GET' && oauth.loginUrl) {
      try {
        const login = new URL(oauth.loginUrl(url.href), storeUrl)
        if (login.protocol === 'https:' || login.protocol === 'http:') {
          return new Response(null, { status: 302, headers: { ...privateHeaders, Location: login.href } })
        }
      } catch {
        // Fall through to the error below.
      }
    }
    return error('woocommerce_rest_oauth_forbidden', 'Store-owner authorization is required.', 403)
  }

  if (request.method === 'GET') {
    const denyUrl = new URL(returnUrl)
    denyUrl.searchParams.set('success', '0')
    denyUrl.searchParams.set('user_id', connection.userId)
    const html = [
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<style>",
      "body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }",
      ".card { background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); max-width: 440px; width: 100%; padding: 32px; text-align: center; }",
      "h1 { font-size: 22px; font-weight: 700; margin-top: 0; margin-bottom: 12px; }",
      "p { font-size: 14px; color: #64748b; line-height: 1.6; margin-bottom: 24px; }",
      ".badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 9999px; font-weight: 600; font-size: 12px; margin-bottom: 16px; }",
      ".btn { display: block; width: 100%; padding: 12px 20px; border-radius: 10px; font-weight: 600; font-size: 14px; text-decoration: none; border: none; cursor: pointer; box-sizing: border-box; }",
      ".btn-primary { background: #2563eb; color: #ffffff; margin-bottom: 10px; }",
      ".btn-primary:hover { background: #1d4ed8; }",
      ".btn-secondary { background: #f1f5f9; color: #475569; }",
      ".btn-secondary:hover { background: #e2e8f0; }",
      "</style>",
      '<title>Connect an app</title></head><body><main class="card">',
      '<h1>Connect ' + escapeHtml(connection.appName) + '</h1>',
      '<p>Grant ' + SCOPE_TEXT[scope] + ' API access to ' + escapeHtml(config.store.name) + '.</p>',
      '<p>' + (mintsKeys ? 'This creates API credentials for' : 'This shares the configured API credentials with') +
        ' <strong>' + escapeHtml(callbackUrl) + '</strong>.</p>',
      '<form method="POST"><button class="btn btn-primary" type="submit">Approve Connection</button></form>',
      '<a class="btn btn-secondary" href="' + escapeHtml(denyUrl.href) + '">Deny Access</a>',
      '</main></body></html>',
    ].join('')
    return new Response(html, {
      headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Resolve credentials only after explicit approval. Authentication failures never dispatch keys.
  let minted: { keyId: number } | undefined
  try {
    let key: Pick<WooEmulateApiKey, 'keyId' | 'consumerKey' | 'consumerSecret'>
    if (mintsKeys) {
      const consumerKey = 'ck_' + randomHex(20)
      const consumerSecret = 'cs_' + randomHex(20)
      minted = await config.apiKeys!.createApiKey!({
        consumerKey,
        consumerSecret,
        permissions: scope,
        description: `${connection.appName.slice(0, 170)} - API (${new Date().toISOString().slice(0, 19).replace('T', ' ')})`,
        userId: connection.userId,
        appName: connection.appName,
      })
      key = { keyId: minted.keyId, consumerKey, consumerSecret }
    } else {
      const credentials = typeof config.auth === 'function' ? await config.auth(request) : config.auth
      if (
        !credentials || !('consumerKey' in credentials) ||
        typeof credentials.consumerKey !== 'string' || !credentials.consumerKey ||
        typeof credentials.consumerSecret !== 'string' || !credentials.consumerSecret
      ) {
        return error('woocommerce_rest_oauth_credentials', 'No API credentials are available for this connection.', 403)
      }
      key = { keyId: credentials.keyId ?? 1, consumerKey: credentials.consumerKey, consumerSecret: credentials.consumerSecret }
    }

    const callback = await fetch(callbackUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(oauth.callbackTimeoutMs ?? 30_000),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'WooCommerce/' + (config.store.version || '8.5.0') + ' (' + config.store.name + ')',
      },
      body: JSON.stringify({
        key_id: key.keyId,
        user_id: connection.userId,
        consumer_key: key.consumerKey,
        consumer_secret: key.consumerSecret,
        key_permissions: scope,
      }),
    })
    // WooCommerce accepts the callback only when it answers exactly HTTP 200.
    if (callback.status !== 200) {
      await revoke(config, minted)
      return error('woocommerce_rest_oauth_dispatch_error', 'The callback did not accept the connection.', 502)
    }

    await config.adapter.onOAuthAuthorized?.(connection)
    const redirectTarget = new URL(returnUrl)
    redirectTarget.searchParams.set('success', '1')
    redirectTarget.searchParams.set('user_id', connection.userId)
    return new Response(null, {
      status: 302,
      headers: { ...privateHeaders, Location: redirectTarget.href },
    })
  } catch {
    await revoke(config, minted)
    return error('woocommerce_rest_oauth_dispatch_error', 'Failed to complete the connection.', 502)
  }
}

/** Deletes a minted key whose callback failed, as WooCommerce does. */
async function revoke(config: WooEmulateConfig, minted: { keyId: number } | undefined): Promise<void> {
  if (!minted) return
  try {
    await config.apiKeys?.deleteApiKey?.(minted.keyId)
  } catch {
    // The connection already failed; a cleanup error must not change the response.
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
