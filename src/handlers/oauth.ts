/**
 * Opt-in WooCommerce connection authorization.
 * Credentials are released only after authenticated, same-origin owner approval.
 */
import { wcErrorResponse } from '../auth.js'
import type { WooEmulateConfig, WooEmulateOAuthAuthorizedPayload } from '../types.js'

const privateHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
}

function error(code: string, message: string, status: number): Response {
  return wcErrorResponse(code, message, status, privateHeaders)
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null
    return url.href
  } catch {
    return null
  }
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

  const callbackUrl = httpsUrl(url.searchParams.get('callback_url'))
  const returnUrl = httpsUrl(url.searchParams.get('return_url'))
  if (
    !callbackUrl || !returnUrl ||
    !oauth.allowedCallbackUrls.some((allowed) => httpsUrl(allowed) === callbackUrl) ||
    !oauth.allowedReturnUrls.some((allowed) => httpsUrl(allowed) === returnUrl)
  ) {
    return error('woocommerce_rest_oauth_url', 'Callback and return URLs must match configured HTTPS URLs.', 400)
  }

  // The current key configuration has no per-key scope enforcement.
  const scope = url.searchParams.get('scope') || 'read_write'
  if (scope !== 'read_write') {
    return error('woocommerce_rest_oauth_scope', 'Only read_write credentials are supported.', 400)
  }

  const connection: WooEmulateOAuthAuthorizedPayload = {
    appName: url.searchParams.get('app_name') || 'Connected App',
    userId: url.searchParams.get('user_id') || '1',
    scope,
    callbackUrl,
    returnUrl,
  }

  // Browsers send Origin on an HTTPS form POST. Reject missing or foreign origins.
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(storeUrl).origin) {
    return error('woocommerce_rest_oauth_origin', 'Approval requires a same-origin POST.', 403)
  }

  try {
    if (await oauth.authorize(request, connection) !== true) {
      return error('woocommerce_rest_oauth_forbidden', 'Store-owner authorization is required.', 403)
    }
  } catch {
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
      '<p>Grant read and write API access to ' + escapeHtml(config.store.name) + '.</p>',
      '<p>This shares the configured API credentials with <strong>' + escapeHtml(callbackUrl) + '</strong>.</p>',
      '<form method="POST"><button class="btn btn-primary" type="submit">Approve Connection</button></form>',
      '<a class="btn btn-secondary" href="' + escapeHtml(denyUrl.href) + '">Deny Access</a>',
      '</main></body></html>',
    ].join('')
    return new Response(html, {
      headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Resolve credentials only after explicit approval. Authentication failures never dispatch keys.
  try {
    const credentials = typeof config.auth === 'function'
      ? await config.auth(request)
      : config.auth
    if (
      !('consumerKey' in credentials) ||
      typeof credentials.consumerKey !== 'string' || !credentials.consumerKey ||
      typeof credentials.consumerSecret !== 'string' || !credentials.consumerSecret
    ) {
      return error('woocommerce_rest_oauth_credentials', 'No API credentials are available for this connection.', 403)
    }

    const callback = await fetch(callbackUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'WooCommerce/' + (config.store.version || '8.5.0') + ' (' + config.store.name + ')',
      },
      body: JSON.stringify({
        key_id: 1,
        user_id: connection.userId,
        consumer_key: credentials.consumerKey,
        consumer_secret: credentials.consumerSecret,
        key_permissions: scope,
      }),
    })
    if (!callback.ok) {
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
    return error('woocommerce_rest_oauth_dispatch_error', 'Failed to complete the connection.', 502)
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
