/**
 * WooEMulate OAuth 1-Click Handshake Handler
 * Implements the standard WooCommerce /wc-auth/v1/authorize flow used by Pirate Ship & third-party apps.
 */

import { wcErrorResponse } from '../auth.js'
import type { WooEmulateConfig } from '../types.js'

export async function handleOAuthAuthorize(
  config: WooEmulateConfig,
  request: Request
): Promise<Response> {
  const url = new URL(request.url)
  const appName = url.searchParams.get('app_name') || 'Shipping App'
  const scope = url.searchParams.get('scope') || 'read_write'
  const userId = url.searchParams.get('user_id') || '1'
  const returnUrl = url.searchParams.get('return_url')
  const callbackUrl = url.searchParams.get('callback_url')

  // Resolve keys
  let consumerKey = ''
  let consumerSecret = ''
  if (typeof config.auth === 'function') {
    const res = await config.auth(request)
    if ('consumerKey' in res) {
      consumerKey = res.consumerKey
      consumerSecret = res.consumerSecret
    }
  } else {
    consumerKey = config.auth.consumerKey
    consumerSecret = config.auth.consumerSecret
  }

  // Automatic approval if both callback_url & return_url are present, or on POST
  const isPost = request.method === 'POST'
  const isDirectAutoApproval = request.method === 'GET' && Boolean(callbackUrl && returnUrl)

  if (isPost || isDirectAutoApproval) {
    let dispatchError: string | null = null

    if (callbackUrl) {
      try {
        const payload = {
          key_id: 1,
          user_id: userId,
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          key_permissions: scope,
        }

        const wcVersion = config.store.version || '8.5.0'
        await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': `WooCommerce/${wcVersion} (${config.store.name})`,
          },
          body: JSON.stringify(payload),
        })

        if (config.adapter.onOAuthAuthorized) {
          await config.adapter.onOAuthAuthorized({
            appName,
            userId,
            scope,
            returnUrl: returnUrl || undefined,
            callbackUrl,
          })
        }
      } catch (err: any) {
        dispatchError = err.message || 'Failed to dispatch credentials'
      }
    }

    if (!dispatchError && returnUrl) {
      try {
        const redirectTarget = new URL(returnUrl)
        redirectTarget.searchParams.set('success', '1')
        if (userId) redirectTarget.searchParams.set('user_id', userId)
        return new Response(null, {
          status: 302,
          headers: {
            Location: redirectTarget.toString(),
          },
        })
      } catch {
        return wcErrorResponse(
          'woocommerce_rest_oauth_error',
          'Invalid return_url provided',
          400
        )
      }
    }

    if (dispatchError) {
      return wcErrorResponse(
        'woocommerce_rest_oauth_dispatch_error',
        dispatchError,
        502
      )
    }
  }

  // Render clean neutral authorization page if GET without auto-approval
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(appName)} - ${escapeHtml(config.store.name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); max-width: 440px; width: 100%; padding: 32px; text-align: center; }
    h2 { font-size: 22px; font-weight: 700; margin-top: 0; margin-bottom: 12px; }
    p { font-size: 14px; color: #64748b; line-height: 1.6; margin-bottom: 24px; }
    .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 9999px; font-weight: 600; font-size: 12px; margin-bottom: 16px; }
    .btn { display: block; width: 100%; padding: 12px 20px; border-radius: 10px; font-weight: 600; font-size: 14px; text-decoration: none; border: none; cursor: pointer; box-sizing: border-box; }
    .btn-primary { background: #2563eb; color: #ffffff; margin-bottom: 10px; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #f1f5f9; color: #475569; }
    .btn-secondary:hover { background: #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${escapeHtml(config.store.name)} API</div>
    <h2>Connect ${escapeHtml(appName)}</h2>
    <p><strong>${escapeHtml(appName)}</strong> is requesting <code>${escapeHtml(scope)}</code> access to your store to view and manage orders.</p>
    <form method="POST">
      <button type="submit" class="btn btn-primary">Approve Connection</button>
      ${
        returnUrl
          ? `<a href="${escapeHtml(returnUrl)}${returnUrl.includes('?') ? '&' : '?'}success=0" class="btn btn-secondary">Deny Access</a>`
          : ''
      }
    </form>
  </div>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
