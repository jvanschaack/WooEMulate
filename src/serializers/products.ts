/**
 * WooEMulate product serializers
 * Products, variations, and catalog taxonomies in the WooCommerce REST API schema.
 * Weights are reported in pounds and dimensions in inches, matching `/settings/products`.
 */

import { wcDatePair } from '../dates.js'
import { getWcNumericId } from '../helpers.js'
import { metaDataArray } from '../serializer.js'
import type {
  WooEmulateAttributeTerm,
  WooEmulateCategory,
  WooEmulateGlobalAttribute,
  WooEmulateImage,
  WooEmulateProduct,
  WooEmulateProductVariation,
  WooEmulateStoreConfig,
  WooEmulateTag,
} from '../types.js'

export interface CatalogSerializeOptions {
  version?: 'v1' | 'v2' | 'v3'
  /** Absolute namespace URL used for `_links`. */
  apiBase?: string
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function price(cents: number | null | undefined): string {
  return typeof cents === 'number' && !isNaN(cents) ? (cents / 100).toFixed(2) : ''
}

function measure(value: number | undefined): string {
  return typeof value === 'number' && value > 0 ? String(value) : ''
}

type Priced = Pick<WooEmulateProduct, 'priceCents' | 'regularPriceCents' | 'salePriceCents'>

function prices(item: Priced) {
  const regular = item.regularPriceCents ?? null
  const sale = item.salePriceCents ?? null
  const onSale = sale !== null && (regular === null || sale < regular)
  const current = item.priceCents !== undefined ? item.priceCents : onSale ? sale : regular
  return { price: price(current), regular_price: price(regular), sale_price: price(sale), on_sale: onSale }
}

type Stocked = Pick<WooEmulateProduct, 'stockQuantity' | 'stockStatus' | 'backorders'>

function stock(item: Stocked, manageStock: boolean | 'parent') {
  const backorders = item.backorders ?? 'no'
  const quantity = manageStock ? item.stockQuantity ?? null : null
  // A variation with manage_stock "parent" reports the parent's stock.
  const status =
    item.stockStatus ??
    (manageStock !== false && quantity !== null
      ? quantity > 0
        ? 'instock'
        : backorders === 'no'
          ? 'outofstock'
          : 'onbackorder'
      : 'instock')
  return {
    manage_stock: manageStock,
    stock_quantity: quantity,
    stock_status: status,
    backorders,
    backorders_allowed: backorders !== 'no',
    backordered: status === 'onbackorder',
    low_stock_amount: null,
  }
}

function image(img: WooEmulateImage, dates: ReturnType<typeof wcDatePair>) {
  return {
    id: img.id ?? 0,
    date_created: dates.local,
    date_created_gmt: dates.gmt,
    date_modified: dates.local,
    date_modified_gmt: dates.gmt,
    src: img.src,
    name: img.name ?? '',
    alt: img.alt ?? '',
  }
}

export function productApiId(product: { id: string | number; wooCommerceId?: number }): number {
  return getWcNumericId(product.wooCommerceId ?? product.id)
}

export function serializeWcProduct(
  product: WooEmulateProduct,
  store: WooEmulateStoreConfig,
  options: CatalogSerializeOptions = {}
): Record<string, any> {
  const id = productApiId(product)
  const timeZone = store.timezone || 'UTC'
  const created = wcDatePair(product.createdAt, timeZone)
  const modified = product.updatedAt ? wcDatePair(product.updatedAt, timeZone) : created
  const variationIds = product.variationIds ?? []
  const type = product.type ?? (variationIds.length ? 'variable' : 'simple')
  const manageStock = product.manageStock ?? typeof product.stockQuantity === 'number'
  const pricing = prices(product)
  const status = product.status ?? 'publish'
  const slug = product.slug ?? slugify(product.name)
  const result: Record<string, any> = {
    id,
    name: product.name,
    slug,
    permalink: product.permalink ?? '',
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    type,
    status,
    featured: product.featured ?? false,
    catalog_visibility: 'visible',
    description: product.description ?? '',
    short_description: product.shortDescription ?? '',
    sku: product.sku ?? '',
    ...pricing,
    date_on_sale_from: null,
    date_on_sale_from_gmt: null,
    date_on_sale_to: null,
    date_on_sale_to_gmt: null,
    price_html: '',
    purchasable: status === 'publish' && pricing.price !== '',
    total_sales: product.totalSales ?? 0,
    virtual: product.virtual ?? false,
    downloadable: product.downloadable ?? false,
    downloads: [],
    download_limit: -1,
    download_expiry: -1,
    external_url: '',
    button_text: '',
    tax_status: product.taxStatus ?? 'taxable',
    tax_class: product.taxClass ?? '',
    ...stock(product, manageStock),
    sold_individually: false,
    weight: measure(product.weightLb),
    dimensions: {
      length: measure(product.dimensionsIn?.length),
      width: measure(product.dimensionsIn?.width),
      height: measure(product.dimensionsIn?.height),
    },
    shipping_required: !(product.virtual ?? false),
    shipping_taxable: (product.taxStatus ?? 'taxable') !== 'none',
    shipping_class: product.shippingClass ?? '',
    shipping_class_id: 0,
    reviews_allowed: false,
    average_rating: '0.00',
    rating_count: 0,
    related_ids: [],
    upsell_ids: [],
    cross_sell_ids: [],
    parent_id: product.parentId ?? 0,
    purchase_note: '',
    categories: (product.categories ?? []).map(({ id, name, slug }) => ({ id, name, slug })),
    tags: (product.tags ?? []).map(({ id, name, slug }) => ({ id, name, slug })),
    images: (product.images ?? []).map((img) => image(img, created)),
    attributes: (product.attributes ?? []).map((attribute, index) => ({
      id: attribute.id ?? 0,
      name: attribute.name,
      position: attribute.position ?? index,
      visible: attribute.visible ?? true,
      variation: attribute.variation ?? false,
      options: attribute.options,
    })),
    default_attributes: [],
    variations: variationIds,
    grouped_products: [],
    menu_order: product.menuOrder ?? 0,
    meta_data: metaDataArray(product.metadata),
  }
  if (options.version && options.version !== 'v3') result.in_stock = result.stock_status !== 'outofstock'
  if (options.apiBase) {
    result._links = {
      self: [{ href: `${options.apiBase}/products/${id}` }],
      collection: [{ href: `${options.apiBase}/products` }],
    }
  }
  return result
}

export function serializeWcVariation(
  variation: WooEmulateProductVariation,
  parent: WooEmulateProduct,
  store: WooEmulateStoreConfig,
  options: CatalogSerializeOptions = {}
): Record<string, any> {
  const id = productApiId(variation)
  const parentId = productApiId(parent)
  const timeZone = store.timezone || 'UTC'
  const created = wcDatePair(variation.createdAt, timeZone)
  const modified = variation.updatedAt ? wcDatePair(variation.updatedAt, timeZone) : created
  const status = variation.status ?? 'publish'
  const pricing = prices(variation)
  const manageStock = variation.manageStock ?? typeof variation.stockQuantity === 'number'
  const result: Record<string, any> = {
    id,
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    description: variation.description ?? '',
    permalink: variation.permalink ?? '',
    sku: variation.sku ?? '',
    ...pricing,
    date_on_sale_from: null,
    date_on_sale_from_gmt: null,
    date_on_sale_to: null,
    date_on_sale_to_gmt: null,
    status,
    purchasable: status === 'publish' && pricing.price !== '',
    virtual: variation.virtual ?? false,
    downloadable: variation.downloadable ?? false,
    downloads: [],
    download_limit: -1,
    download_expiry: -1,
    tax_status: variation.taxStatus ?? 'taxable',
    tax_class: variation.taxClass ?? '',
    ...stock(
      manageStock === 'parent'
        ? { ...variation, stockQuantity: parent.stockQuantity, stockStatus: variation.stockStatus ?? parent.stockStatus }
        : variation,
      manageStock
    ),
    weight: measure(variation.weightLb ?? parent.weightLb),
    dimensions: {
      length: measure(variation.dimensionsIn?.length ?? parent.dimensionsIn?.length),
      width: measure(variation.dimensionsIn?.width ?? parent.dimensionsIn?.width),
      height: measure(variation.dimensionsIn?.height ?? parent.dimensionsIn?.height),
    },
    shipping_class: variation.shippingClass ?? parent.shippingClass ?? '',
    shipping_class_id: 0,
    image: variation.image ? image(variation.image, created) : null,
    attributes: variation.attributes.map((attribute) => ({
      id: attribute.id ?? 0,
      name: attribute.name,
      option: attribute.option,
    })),
    menu_order: variation.menuOrder ?? 0,
    meta_data: metaDataArray(variation.metadata),
  }
  if (options.apiBase) {
    const parentPath = `${options.apiBase}/products/${parentId}`
    result._links = {
      self: [{ href: `${parentPath}/variations/${id}` }],
      collection: [{ href: `${parentPath}/variations` }],
      up: [{ href: parentPath }],
    }
  }
  return result
}

function links(apiBase: string | undefined, path: string, id: number) {
  return apiBase
    ? { _links: { self: [{ href: `${apiBase}${path}/${id}` }], collection: [{ href: `${apiBase}${path}` }] } }
    : {}
}

export function serializeWcCategory(category: WooEmulateCategory, apiBase?: string) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    parent: category.parent ?? 0,
    description: category.description ?? '',
    display: 'default',
    image: category.image
      ? { id: category.image.id ?? 0, src: category.image.src, name: category.image.name ?? '', alt: category.image.alt ?? '' }
      : null,
    menu_order: category.menuOrder ?? 0,
    count: category.count ?? 0,
    ...links(apiBase, '/products/categories', category.id),
  }
}

export function serializeWcTag(tag: WooEmulateTag, apiBase?: string) {
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    description: tag.description ?? '',
    count: tag.count ?? 0,
    ...links(apiBase, '/products/tags', tag.id),
  }
}

export function serializeWcAttribute(attribute: WooEmulateGlobalAttribute, apiBase?: string) {
  return {
    id: attribute.id,
    name: attribute.name,
    slug: attribute.slug ?? `pa_${slugify(attribute.name)}`,
    type: attribute.type ?? 'select',
    order_by: attribute.orderBy ?? 'menu_order',
    has_archives: attribute.hasArchives ?? false,
    ...links(apiBase, '/products/attributes', attribute.id),
  }
}

export function serializeWcAttributeTerm(term: WooEmulateAttributeTerm, attributeId: number, apiBase?: string) {
  return {
    id: term.id,
    name: term.name,
    slug: term.slug,
    description: term.description ?? '',
    menu_order: term.menuOrder ?? 0,
    count: term.count ?? 0,
    ...links(apiBase, `/products/attributes/${attributeId}/terms`, term.id),
  }
}
