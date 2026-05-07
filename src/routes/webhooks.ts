/**
 * POST /api/webhooks/shopify/orders-paid
 *
 * Recibe la notificación de Shopify cuando se completa un pago.
 * Flujo:
 *   1. Verificar HMAC del webhook (seguridad)
 *   2. Idempotencia: ignorar si ya procesamos esta orden
 *   3. Por cada line_item de la orden:
 *      a. Buscar ticket_type por shopify_variant_id
 *      b. Crear registro en orders (tocata)
 *      c. Llamar a create_attendees_for_order() → genera QRs
 *   4. Leer los attendees recién creados
 *   5. Enviar email con QR al comprador
 *   6. Guardar en shopify_webhook_log
 *
 * IMPORTANTE: Shopify reenvía el webhook si no responde 200 en < 5s.
 * Por eso respondemos 200 rápido y procesamos async.
 */

import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabase'
import { sendTicketEmail } from '../lib/email'

const router = Router()

// ── Verificación HMAC de Shopify ───────────────────────────────────
function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[webhook] SHOPIFY_WEBHOOK_SECRET no configurado — saltando verificación')
    return true // en dev sin secret, permitir
  }
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64')
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader))
}

// ── Tipos Shopify ──────────────────────────────────────────────────
interface ShopifyLineItem {
  id: number
  variant_id: number | null
  title: string
  quantity: number
  price: string
  properties?: Array<{ name: string; value: string }>
}

interface ShopifyAddress {
  first_name?: string
  last_name?: string
  phone?: string
}

interface ShopifyOrder {
  id: number
  name: string              // "#1001"
  email: string
  phone?: string
  created_at: string
  total_price: string
  currency: string
  billing_address?: ShopifyAddress
  shipping_address?: ShopifyAddress
  line_items: ShopifyLineItem[]
}

// ── Handler principal ──────────────────────────────────────────────
router.post(
  '/shopify/orders-paid',
  // Necesitamos el body crudo para verificar HMAC
  express_raw_middleware,
  async (req: Request, res: Response) => {
    // 1. Verificar HMAC
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string
    const rawBody: Buffer = (req as any).rawBody

    if (hmacHeader && !verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn('[webhook] HMAC inválido — rechazando')
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // Procesar sincrónicamente antes de responder
    // (En Vercel serverless el proceso se mata al enviar la respuesta,
    //  por lo que async post-response no funciona)
    const order: ShopifyOrder = JSON.parse(rawBody.toString())
    try {
      await processShopifyOrder(order)
    } catch (err) {
      console.error('[webhook] Error procesando orden Shopify:', err)
      // Devolvemos 200 igual para que Shopify no reintente infinitamente
    }

    res.status(200).json({ received: true })
  }
)

// ── Middleware para capturar body crudo ────────────────────────────
function express_raw_middleware(
  req: Request,
  _res: Response,
  next: Function
) {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    (req as any).rawBody = Buffer.concat(chunks)
    next()
  })
}

// ── Lógica de procesamiento ────────────────────────────────────────
async function processShopifyOrder(order: ShopifyOrder): Promise<void> {
  const shopifyOrderId = String(order.id)
  console.log(`[webhook] Procesando orden Shopify ${shopifyOrderId} (${order.name})`)

  // 2. Idempotencia: verificar si ya fue procesada
  const { data: existing } = await supabaseAdmin
    .from('shopify_webhook_log')
    .select('id')
    .eq('shopify_order_id', shopifyOrderId)
    .single()

  if (existing) {
    console.log(`[webhook] Orden ${shopifyOrderId} ya procesada — ignorando`)
    return
  }

  // Datos del comprador
  const buyerName = [
    order.billing_address?.first_name || order.shipping_address?.first_name || '',
    order.billing_address?.last_name  || order.shipping_address?.last_name  || '',
  ].join(' ').trim() || order.email.split('@')[0]

  const buyerPhone = order.phone
    || order.billing_address?.phone
    || order.shipping_address?.phone
    || null

  const createdOrderIds: string[] = []

  // 3. Procesar cada line_item
  for (const item of order.line_items) {
    // Resolver variant_id: directo en el item (compra normal)
    // o desde properties._variant_id (Draft Order de precio libre)
    let resolvedVariantId: string | null = null
    if (item.variant_id != null) {
      resolvedVariantId = String(item.variant_id)
    } else {
      resolvedVariantId = item.properties?.find(p => p.name === '_variant_id')?.value ?? null
    }

    if (!resolvedVariantId) continue

    const variantGid = `gid://shopify/ProductVariant/${resolvedVariantId}`

    // 3a. Buscar ticket_type por shopify_variant_id
    const { data: ticketType } = await supabaseAdmin
      .from('ticket_types')
      .select(`
        id, event_id, name, price,
        events!inner(id, name, event_date, venue, city, cover_image_url, producer_id, commission_pct)
      `)
      .eq('shopify_variant_id', variantGid)
      .eq('is_active', true)
      .single()

    if (!ticketType) {
      console.warn(`[webhook] variant ${variantGid} no mapeado en ticket_types — saltando`)
      continue
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = (ticketType as any).events as {
      id: string; name: string; event_date: string
      venue: string; city: string; cover_image_url: string; producer_id: string; commission_pct: number
    }

    const unitPrice   = parseFloat(item.price)
    const quantity    = item.quantity
    const subtotal    = unitPrice * quantity
    const commissionPct = event.commission_pct ?? 5
    const platformFee   = subtotal * (commissionPct / 100)
    const producerAmt   = subtotal - platformFee

    // 3b. Crear orden en tocata
    const { data: newOrder, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        event_id:        event.id,
        ticket_type_id:  ticketType.id,
        buyer_name:      buyerName,
        buyer_email:     order.email,
        buyer_phone:     buyerPhone,
        quantity,
        unit_price:      unitPrice,
        subtotal,
        platform_fee:    platformFee,
        producer_amount: producerAmt,
        payment_method:  'shopify',
        payment_status:  'paid',
        payment_provider: 'mercadopago',
        payment_id:      shopifyOrderId,
      })
      .select('id')
      .single()

    if (orderError || !newOrder) {
      console.error('[webhook] Error creando orden:', orderError)
      continue
    }

    createdOrderIds.push(newOrder.id)

    // 3c. Generar attendees con QR
    const { error: attendeeError } = await supabaseAdmin
      .rpc('create_attendees_for_order', { order_id: newOrder.id })

    if (attendeeError) {
      console.error('[webhook] Error creando attendees:', attendeeError)
      continue
    }

    console.log(`[webhook] ✓ ${quantity} entrada(s) creada(s) para "${event.name}" → ${order.email}`)
  }

  if (createdOrderIds.length === 0) {
    console.warn('[webhook] No se crearon órdenes — ningún variant mapeado')
    return
  }

  // 4. Leer todos los attendees recién creados
  const { data: attendees } = await supabaseAdmin
    .from('attendees')
    .select(`
      attendee_name, attendee_email, qr_code,
      ticket_types(name),
      events!inner(name, event_date, venue, city)
    `)
    .in('order_id', createdOrderIds)
    .order('created_at', { ascending: true })

  if (!attendees || attendees.length === 0) {
    console.warn('[webhook] No se encontraron attendees para enviar email')
    return
  }

  // 5. Enviar email con QR(s) al comprador
  // Agrupar por evento (en caso de que una orden tenga varios eventos)
  const firstAttendee = attendees[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventData = (firstAttendee as any).events as { name: string; event_date: string; venue: string; city: string }

  try {
    await sendTicketEmail({
      buyerEmail: order.email,
      buyerName,
      eventName:  eventData.name,
      eventDate:  eventData.event_date,
      venue:      eventData.venue,
      city:       eventData.city,
      tickets: attendees.map(a => ({
        attendeeName:   a.attendee_name,
        ticketTypeName: ((a as any).ticket_types as { name: string } | null)?.name || 'General',
        qrCode:         a.qr_code,
      })),
    })
  } catch (emailErr) {
    // El email falló, pero las entradas ya están creadas — loguear sin relanzar
    console.error('[webhook] Email falló (entradas ya creadas):', emailErr)
  }

  // 6. Registrar en log de idempotencia
  await supabaseAdmin
    .from('shopify_webhook_log')
    .insert({
      shopify_order_id: shopifyOrderId,
      order_ids:        createdOrderIds,
      attendee_count:   attendees.length,
    })

  console.log(`[webhook] ✅ Orden ${shopifyOrderId} procesada: ${attendees.length} entrada(s) → ${order.email}`)
}

// ── POST /shopify/orders-cancelled ────────────────────────────────
/**
 * Shopify dispara este evento cuando se cancela una orden.
 * Flujo:
 *   1. Verificar HMAC (igual que orders-paid)
 *   2. Buscar en shopify_webhook_log las órdenes internas asociadas
 *   3. Marcar orders.payment_status = 'cancelled'
 *
 * El validador de QR (attendees.ts) rechaza entradas cuya orden esté cancelada.
 */
router.post(
  '/shopify/orders-refunded',
  express_raw_middleware,
  async (req: Request, res: Response) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string
    const rawBody: Buffer = (req as any).rawBody

    if (hmacHeader && !verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn('[webhook:cancel] HMAC inválido — rechazando')
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const payload = JSON.parse(rawBody.toString()) as { id: number }
    const shopifyOrderId = String(payload.id)

    try {
      await cancelShopifyOrder(shopifyOrderId)
    } catch (err) {
      console.error('[webhook:cancel] Error procesando cancelación:', err)
      // Devolvemos 200 igual para que Shopify no reintente infinitamente
    }

    res.status(200).json({ received: true })
  }
)

async function cancelShopifyOrder(shopifyOrderId: string): Promise<void> {
  console.log(`[webhook:cancel] Procesando cancelación orden Shopify ${shopifyOrderId}`)

  // Buscar las órdenes internas asociadas a este shopify_order_id
  const { data: logEntry } = await supabaseAdmin
    .from('shopify_webhook_log')
    .select('order_ids')
    .eq('shopify_order_id', shopifyOrderId)
    .single()

  if (!logEntry || !logEntry.order_ids) {
    console.warn(`[webhook:cancel] shopify_order_id ${shopifyOrderId} no encontrado en log — puede ser una orden anterior al sistema`)
    return
  }

  const orderIds: string[] = Array.isArray(logEntry.order_ids)
    ? logEntry.order_ids
    : [logEntry.order_ids]

  if (orderIds.length === 0) {
    console.warn(`[webhook:cancel] order_ids vacío para ${shopifyOrderId}`)
    return
  }

  // Leer quantity y ticket_type_id antes de marcar como refunded
  const { data: ordersData, error: fetchError } = await supabaseAdmin
    .from('orders')
    .select('id, ticket_type_id, quantity')
    .in('id', orderIds)

  if (fetchError || !ordersData) {
    console.error('[webhook:cancel] Error leyendo órdenes:', fetchError)
    throw fetchError
  }

  // Marcar órdenes como refunded
  const { error: updateError } = await supabaseAdmin
    .from('orders')
    .update({ payment_status: 'refunded' })
    .in('id', orderIds)

  if (updateError) {
    console.error('[webhook:cancel] Error actualizando órdenes:', updateError)
    throw updateError
  }

  // Decrementar sold en ticket_types por cada orden cancelada
  for (const order of ordersData) {
    const { error: soldError } = await supabaseAdmin
      .rpc('decrement_ticket_sold', {
        p_ticket_type_id: order.ticket_type_id,
        p_quantity:       order.quantity,
      })

    if (soldError) {
      // No relanzar — las órdenes ya están marcadas como refunded,
      // el sold es recuperable manualmente si falla
      console.error(`[webhook:cancel] Error decrementando sold para ticket_type ${order.ticket_type_id}:`, soldError)
    }
  }

  console.log(`[webhook:cancel] ✅ ${orderIds.length} orden(es) cancelada(s), sold decrementado en ticket_types`)
}

export default router
