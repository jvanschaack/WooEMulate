/**
 * WooEMulate System Status Handler
 * Emulates the WooCommerce system status report required by certain diagnostic tools and partners.
 */

import { authenticateRequest, wcErrorResponse } from '../auth.js'
import type { WooEmulateConfig } from '../types.js'

export async function handleSystemStatus(
  config: WooEmulateConfig,
  request: Request
): Promise<Response> {
  const auth = await authenticateRequest(request, config)
  if (!auth.authenticated) {
    return wcErrorResponse(
      'woocommerce_rest_cannot_view',
      auth.error || 'Authentication required',
      auth.status || 401
    )
  }

  const origin = new URL(request.url).origin || config.store.url
  const wcVersion = config.store.version || '8.5.0'

  const statusReport = {
    environment: {
      home_url: origin,
      site_url: origin,
      version: wcVersion,
      wp_version: '6.4.3',
      wp_multisite: false,
      wp_memory_limit: 268435456,
      wp_debug_mode: false,
      wp_cron: true,
      language: 'en_US',
      server_info: 'WooEMulate Serverless Engine',
      php_version: '8.2.0',
      php_post_max_size: 67108864,
      php_max_execution_time: 300,
      php_max_input_vars: 1000,
      curl_version: '7.81.0',
      suhosin_installed: false,
      max_upload_size: 67108864,
      mysql_version: '8.0.32',
      default_timezone: 'UTC',
      fsockopen_or_curl_enabled: true,
      soapclient_enabled: true,
      domdocument_enabled: true,
      gzip_enabled: true,
      mbstring_enabled: true,
      remote_post_successful: true,
      remote_post_response: 200,
      remote_get_successful: true,
      remote_get_response: 200,
    },
    database: {
      wc_database_version: wcVersion,
      database_prefix: 'wp_',
      maxmind_geoip_database: '',
      database_tables: {
        woocommerce: {},
      },
    },
    active_plugins: [
      {
        plugin: 'woocommerce/woocommerce.php',
        name: 'WooCommerce',
        version: wcVersion,
        version_latest: wcVersion,
        url: 'https://woocommerce.com/',
        author_name: 'Automattic',
        author_url: 'https://woocommerce.com',
        network_activated: false,
      },
      {
        plugin: 'woocommerce-shipment-tracking/woocommerce-shipment-tracking.php',
        name: 'WooCommerce Shipment Tracking',
        version: '2.0.0',
        version_latest: '2.0.0',
        url: 'https://woocommerce.com/products/shipment-tracking/',
        author_name: 'WooCommerce',
        author_url: 'https://woocommerce.com',
        network_activated: false,
      },
    ],
    theme: {
      name: config.store.name,
      version: '1.0.0',
      author_url: origin,
      is_child_theme: false,
      has_woocommerce_support: true,
    },
    settings: {
      api_enabled: true,
      force_ssl: true,
      currency: config.store.currency || 'USD',
      currency_symbol: '$',
      currency_position: 'left',
      thousand_separator: ',',
      decimal_separator: '.',
      number_of_decimals: 2,
      geolocation_enabled: false,
      taxonomies: {},
      product_visibility_terms: {},
    },
    security: {
      secure_connection: true,
      hide_errors: true,
    },
  }

  return new Response(JSON.stringify(statusReport), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
