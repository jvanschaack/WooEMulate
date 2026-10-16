/**
 * WooEMulate Settings Handler
 * Read-only `general` and `products` settings derived from the store configuration.
 */

import { wcErrorResponse } from '../auth.js'
import { jsonResponse, routeUrl, type RouteContext } from '../http.js'
import type { WooEmulateStoreConfig } from '../types.js'

interface Setting {
  id: string
  label: string
  type: string
  value: string
  default?: string
  description?: string
}

const GROUPS = [
  { id: 'general', label: 'General', description: '' },
  { id: 'products', label: 'Products', description: '' },
]

function settingsFor(group: string, store: WooEmulateStoreConfig): Setting[] | null {
  const address = store.address ?? {}
  const country = address.country ? (address.state ? `${address.country}:${address.state}` : address.country) : ''
  if (group === 'general') {
    return [
      { id: 'woocommerce_store_address', label: 'Address line 1', type: 'text', value: address.address1 ?? '' },
      { id: 'woocommerce_store_address_2', label: 'Address line 2', type: 'text', value: address.address2 ?? '' },
      { id: 'woocommerce_store_city', label: 'City', type: 'text', value: address.city ?? '' },
      { id: 'woocommerce_default_country', label: 'Country / State', type: 'select', value: country, default: 'US:CA' },
      { id: 'woocommerce_store_postcode', label: 'Postcode / ZIP', type: 'text', value: address.postalCode ?? '' },
      { id: 'woocommerce_calc_taxes', label: 'Enable taxes', type: 'checkbox', value: store.calcTaxes ? 'yes' : 'no', default: 'no' },
      { id: 'woocommerce_currency', label: 'Currency', type: 'select', value: store.currency || 'USD', default: 'USD' },
      { id: 'woocommerce_currency_pos', label: 'Currency position', type: 'select', value: store.currencyPosition ?? 'left', default: 'left' },
      { id: 'woocommerce_price_thousand_sep', label: 'Thousand separator', type: 'text', value: store.thousandSeparator ?? ',', default: ',' },
      { id: 'woocommerce_price_decimal_sep', label: 'Decimal separator', type: 'text', value: store.decimalSeparator ?? '.', default: '.' },
      { id: 'woocommerce_price_num_decimals', label: 'Number of decimals', type: 'number', value: String(store.decimals ?? 2), default: '2' },
    ]
  }
  if (group === 'products') {
    return [
      // WooEMulate's data model uses pounds and inches throughout.
      { id: 'woocommerce_weight_unit', label: 'Weight unit', type: 'select', value: 'lbs', default: 'kg' },
      { id: 'woocommerce_dimension_unit', label: 'Dimensions unit', type: 'select', value: 'in', default: 'cm' },
    ]
  }
  return null
}

function serialize(ctx: RouteContext, group: string, setting: Setting) {
  return {
    id: setting.id,
    label: setting.label,
    description: setting.description ?? '',
    type: setting.type,
    default: setting.default ?? '',
    value: setting.value,
    group_id: group,
    _links: {
      self: [{ href: routeUrl(ctx, `/settings/${group}/${setting.id}`) }],
      collection: [{ href: routeUrl(ctx, `/settings/${group}`) }],
    },
  }
}

export async function listSettingGroups(ctx: RouteContext): Promise<Response> {
  return jsonResponse(
    GROUPS.map((group) => ({
      ...group,
      parent_id: '',
      sub_groups: [],
      _links: { options: [{ href: routeUrl(ctx, `/settings/${group.id}`) }] },
    }))
  )
}

export async function listSettings(ctx: RouteContext): Promise<Response> {
  const settings = settingsFor(ctx.params.group_id, ctx.config.store)
  if (!settings) return wcErrorResponse('rest_setting_setting_group_invalid', 'Invalid setting group.', 404)
  return jsonResponse(settings.map((setting) => serialize(ctx, ctx.params.group_id, setting)))
}

export async function getSetting(ctx: RouteContext): Promise<Response> {
  const settings = settingsFor(ctx.params.group_id, ctx.config.store)
  if (!settings) return wcErrorResponse('rest_setting_setting_group_invalid', 'Invalid setting group.', 404)
  const setting = settings.find((row) => row.id === ctx.params.id)
  if (!setting) return wcErrorResponse('rest_setting_setting_invalid', 'Invalid setting.', 404)
  return jsonResponse(serialize(ctx, ctx.params.group_id, setting))
}
