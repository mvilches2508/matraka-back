import { Router, Response } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { sendAdminReviewEmail, sendProducerApprovedEmail } from '../lib/email'

const ADMIN_EMAIL   = process.env.ADMIN_EMAIL   || 'hola@matraka-tickets.com'
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || process.env.JWT_SECRET || 'admin_secret'
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'tiketera-2.myshopify.com'
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || ''
const API_BASE_URL  = process.env.API_BASE_URL  || 'https://matraka-back.vercel.app'

// Genera / valida token HMAC para links de aprobación sin login
function makeApproveToken(eventId: string): string {
  return crypto.createHmac('sha256', ADMIN_SECRET).update(eventId).digest('hex').slice(0, 32)
}

// Llamada a Shopify Admin REST API
async function shopifyRequest(method: string, path: string, body?: object) {
  if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_ACCESS_TOKEN no configurado')
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-07/${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Shopify ${method} ${path} → ${res.status}: ${err}`)
  }
  return res.json()
}

const router = Router()

// ── Schemas de validación ──────────────────────────────────────────
const eventSchema = z.object({
  name: z.string().min(3).max(150),
  description: z.string().max(2000).optional(),
  category: z.enum([
    'Música en vivo', 'Teatro', 'Arte y cultura',
    'Fiesta / Reunión', 'Stand-up / Humor', 'Taller / Charla', 'Otro'
  ]).default('Música en vivo'),
  venue: z.string().min(2).max(200),
  address: z.string().max(300).optional(),
  city: z.string().max(100).default('Santiago'),
  event_date: z.string().datetime(),
  doors_open: z.string().datetime().optional(),
  cover_image_url: z.string().url().optional(),
  capacity: z.number().int().positive().optional(),
  age_restriction: z.number().int().min(0).max(21).default(0),
  commission_pct: z.number().min(5).max(15).default(5),
  tags: z.array(z.string()).max(10).default([]),
})

// ── GET /api/events — Listar eventos del productor (o todos si es admin) ──
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, limit = '20', offset = '0' } = req.query
  const isAdmin = req.user!.email === ADMIN_EMAIL

  let query = supabaseAdmin
    .from('events')
    .select(`
      *,
      ticket_types(id, name, price, quantity, sold, is_active)
    `)
    .order('event_date', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  // El admin ve todos los eventos; el productor solo los suyos
  if (!isAdmin) {
    query = query.eq('producer_id', req.user!.id)
  }

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Calcular revenue por evento
  const eventsWithStats = (data || []).map(event => {
    const tickets = event.ticket_types || []
    const total_capacity = tickets.reduce((s: number, t: { quantity: number }) => s + t.quantity, 0)
    const total_sold = tickets.reduce((s: number, t: { sold: number }) => s + t.sold, 0)
    const total_revenue = tickets.reduce(
      (s: number, t: { sold: number; price: number }) => s + t.sold * t.price, 0
    )
    return {
      ...event,
      stats: {
        total_capacity,
        total_sold,
        total_revenue,
        producer_revenue: total_revenue * (1 - event.commission_pct / 100),
        occupancy_pct: total_capacity > 0 ? Math.round((total_sold / total_capacity) * 100) : 0,
      },
    }
  })

  res.json({ data: eventsWithStats, count })
})

// ── GET /api/events/admin/pending — Lista para el admin ───────────
// IMPORTANTE: debe estar ANTES de /:id para que Express no lo capture como id='admin'
// Solo accesible con JWT del admin (hola@matraka-tickets.com)
router.get('/admin/pending', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.user!.email !== ADMIN_EMAIL) {
    res.status(403).json({ error: 'Solo el administrador puede ver esta ruta' })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .select(`
      *,
      ticket_types(id, name, price, quantity, sold),
      producers!events_producer_id_fkey(name, email)
    `)
    .eq('status', 'review')
    .order('updated_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data: data || [] })
})

// ── GET /api/events/:id — Detalle de un evento ────────────────────
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const isAdmin = req.user!.email === ADMIN_EMAIL

  let detailQuery = supabaseAdmin
    .from('events')
    .select('*, ticket_types(*)')
    .eq('id', req.params.id)

  if (!isAdmin) {
    detailQuery = detailQuery.eq('producer_id', req.user!.id)
  }

  const { data: event, error } = await detailQuery.single()

  if (error || !event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  // Estadísticas de ventas del evento
  const { data: orderStats } = await supabaseAdmin
    .from('orders')
    .select('quantity, subtotal, producer_amount, payment_status, created_at, buyer_name, buyer_email')
    .eq('event_id', req.params.id)
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false })

  const orders = orderStats || []
  const order_stats = {
    total_ventas: orders.length,
    total_entradas: orders.reduce((s, o) => s + o.quantity, 0),
    total_revenue: orders.reduce((s, o) => s + Number(o.subtotal), 0),
    producer_revenue: orders.reduce((s, o) => s + Number(o.producer_amount), 0),
    recientes: orders.slice(0, 10),
  }

  // Mismo stats que calcula el list endpoint (ticket_types.sold)
  const tickets = event.ticket_types || []
  const stats = {
    total_capacity:   tickets.reduce((s: number, t: { quantity: number }) => s + t.quantity, 0),
    total_sold:       tickets.reduce((s: number, t: { sold: number }) => s + t.sold, 0),
    total_revenue:    tickets.reduce((s: number, t: { sold: number; price: number }) => s + t.sold * t.price, 0),
    producer_revenue: tickets.reduce((s: number, t: { sold: number; price: number }) => s + t.sold * t.price, 0) * (1 - event.commission_pct / 100),
    occupancy_pct:    tickets.length > 0 && tickets.reduce((s: number, t: { quantity: number }) => s + t.quantity, 0) > 0
      ? Math.round((tickets.reduce((s: number, t: { sold: number }) => s + t.sold, 0) / tickets.reduce((s: number, t: { quantity: number }) => s + t.quantity, 0)) * 100)
      : 0,
  }

  res.json({ ...event, stats, order_stats })
})

// ── POST /api/events — Crear evento ──────────────────────────────
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = eventSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .insert({
      ...parsed.data,
      producer_id: req.user!.id,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json(data)
})

// ── PATCH /api/events/:id — Actualizar evento ─────────────────────
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  // Verificar que el evento pertenece al productor
  const { data: existing } = await supabaseAdmin
    .from('events')
    .select('id, status, producer_id')
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .single()

  if (!existing) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  if (['cancelled', 'finished'].includes(existing.status)) {
    res.status(400).json({ error: 'No se puede modificar un evento cancelado o terminado' })
    return
  }

  const parsed = eventSchema.partial().safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  // No permitir cambiar commission_pct si ya hay ventas
  if (parsed.data.commission_pct !== undefined) {
    const { count } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', req.params.id)
      .eq('payment_status', 'paid')

    if ((count || 0) > 0) {
      delete parsed.data.commission_pct
    }
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .update(parsed.data)
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json(data)
})

// ── POST /api/events/:id/submit — Enviar a revisión ───────────────
router.post('/:id/submit', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('*, ticket_types(*)')
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  if (event.status !== 'draft') {
    res.status(400).json({ error: `No se puede enviar un evento en estado: ${event.status}` })
    return
  }

  if (!event.ticket_types || event.ticket_types.length === 0) {
    res.status(400).json({ error: 'El evento debe tener al menos un tipo de entrada' })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .update({ status: 'review' })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Obtener datos del productor
  const { data: producer } = await supabaseAdmin
    .from('producers')
    .select('name, email')
    .eq('id', req.user!.id)
    .single()

  // Generar link de aprobación directa (sin login)
  const approveToken = makeApproveToken(req.params.id)
  const approveUrl = `${API_BASE_URL}/api/events/${req.params.id}/approve?token=${approveToken}`

  // Enviar email al admin (sin bloquear la respuesta)
  sendAdminReviewEmail({
    eventId:      req.params.id,
    eventName:    event.name,
    producerName: producer?.name || 'Productor',
    producerEmail: producer?.email || req.user!.email,
    venue:        event.venue,
    city:         event.city,
    eventDate:    event.event_date,
    ticketTypes:  event.ticket_types || [],
    approveUrl,
  }).catch(err => console.error('[submit] Error enviando email admin:', err))

  res.json({ message: 'Evento enviado a revisión. Te contactamos en menos de 24 horas.', event: data })
})

// ── POST /api/events/:id/approve — Admin aprueba evento ───────────
// Soporta dos modos: (1) token en query param (link directo desde email),
//                    (2) autenticación Bearer + email admin
router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
  const eventId = req.params.id

  // Verificar autorización: token en query O bearer del admin
  const queryToken = req.query.token as string | undefined
  const expectedToken = makeApproveToken(eventId)

  if (queryToken) {
    // Validación por link directo (no requiere login)
    if (queryToken !== expectedToken) {
      res.status(403).json({ error: 'Token de aprobación inválido' })
      return
    }
  } else {
    // Validación por JWT Bearer — debe ser el admin
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Autorización requerida' })
      return
    }
    const token = authHeader.split(' ')[1]
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !user || user.email !== ADMIN_EMAIL) {
      res.status(403).json({ error: 'Solo el administrador puede aprobar eventos' })
      return
    }
  }

  // Cargar evento con ticket_types
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('*, ticket_types(*)')
    .eq('id', eventId)
    .single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  if (event.status !== 'review') {
    res.status(400).json({ error: `El evento no está en revisión (estado: ${event.status})` })
    return
  }

  let shopifyCollectionId: string | undefined
  let shopifyUrl: string | undefined

  // Crear colección + productos en Shopify (si hay token configurado)
  if (SHOPIFY_TOKEN) {
    try {
      const dateStr = new Date(event.event_date).toLocaleDateString('es-CL', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })

      // 1. Crear colección personalizada
      const collectionRes = await shopifyRequest('POST', 'custom_collections.json', {
        custom_collection: {
          title: event.name,
          body_html: `<p>${event.description || ''}</p><p>📍 ${event.venue}, ${event.city}</p><p>📅 ${dateStr}</p>`,
          image: event.cover_image_url ? { src: event.cover_image_url } : undefined,
        },
      }) as { custom_collection: { id: number } }
      shopifyCollectionId = String(collectionRes.custom_collection.id)

      // 2. Crear un producto por cada tipo de entrada
      const tickets = event.ticket_types || []
      for (const ticket of tickets) {
        const productRes = await shopifyRequest('POST', 'products.json', {
          product: {
            title: `${event.name} — ${ticket.name}`,
            body_html: `<p>Entrada tipo <strong>${ticket.name}</strong> para ${event.name}</p>`,
            product_type: 'Entrada',
            tags: `evento,${event.category?.toLowerCase() || 'musica'}`,
            variants: [{
              price: String(ticket.price),
              inventory_management: 'shopify',
              inventory_quantity: ticket.quantity - (ticket.sold || 0),
              inventory_policy: 'deny',
              fulfillment_service: 'manual',
              requires_shipping: false,
              taxable: false,
            }],
            images: event.cover_image_url ? [{ src: event.cover_image_url }] : [],
          },
        }) as { product: { id: number; variants: Array<{ id: number }> } }

        const productId   = productRes.product.id
        const variantId   = productRes.product.variants[0]?.id

        // Guardar shopify_variant_id en el ticket_type
        if (variantId) {
          await supabaseAdmin
            .from('ticket_types')
            .update({ shopify_variant_id: String(variantId) })
            .eq('id', ticket.id)
        }

        // Agregar producto a la colección
        if (shopifyCollectionId) {
          await shopifyRequest('POST', 'collects.json', {
            collect: { collection_id: Number(shopifyCollectionId), product_id: productId },
          })
        }
      }

      shopifyUrl = `https://matraka-tickets.com/collections/${shopifyCollectionId}`
      console.log(`[approve] ✓ Shopify: colección ${shopifyCollectionId} creada para evento ${eventId}`)
    } catch (shopifyErr) {
      console.error('[approve] Error Shopify (continuando):', (shopifyErr as Error).message)
      // No bloqueamos la aprobación si Shopify falla
    }
  } else {
    console.warn('[approve] SHOPIFY_ACCESS_TOKEN no configurado — omitiendo integración Shopify')
  }

  // Actualizar evento a published
  const updatePayload: Record<string, unknown> = { status: 'published' }
  if (shopifyCollectionId) updatePayload.shopify_collection_id = shopifyCollectionId

  const { data: updatedEvent, error: updateErr } = await supabaseAdmin
    .from('events')
    .update(updatePayload)
    .eq('id', eventId)
    .select()
    .single()

  if (updateErr) {
    res.status(500).json({ error: updateErr.message })
    return
  }

  // Obtener datos del productor para notificarle
  const { data: producer } = await supabaseAdmin
    .from('producers')
    .select('name, email')
    .eq('id', event.producer_id)
    .single()

  if (producer) {
    sendProducerApprovedEmail({
      producerEmail: producer.email,
      producerName:  producer.name,
      eventName:     event.name,
      eventDate:     event.event_date,
      venue:         event.venue,
      shopifyUrl,
    }).catch(err => console.error('[approve] Error enviando email productor:', err))
  }

  // Respuesta: si fue link directo, mostramos HTML; si fue API, JSON
  if (queryToken) {
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;text-align:center;">
        <h1 style="color:#FFE500;">✅ Evento aprobado</h1>
        <p style="font-size:18px;">"${event.name}" ya está activo.</p>
        ${shopifyCollectionId ? `<p>Shopify colección: ${shopifyCollectionId}</p>` : ''}
        <p><a href="https://portal.matraka-tickets.com/dashboard/admin" style="color:#FFE500;">Ir al panel admin →</a></p>
      </body></html>
    `)
  } else {
    res.json({ message: 'Evento aprobado y publicado', event: updatedEvent, shopifyCollectionId })
  }
})

// ── POST /api/events/:id/courtesy — Emitir entrada de cortesía ───────
const courtesySchema = z.object({
  attendee_name:  z.string().min(2).max(100),
  attendee_email: z.string().email(),
})

router.post('/:id/courtesy', requireAuth, async (req: AuthRequest, res: Response) => {
  const isAdmin = req.user!.email === ADMIN_EMAIL

  // 1. Verificar ownership del evento
  let eventQuery = supabaseAdmin
    .from('events')
    .select('id, name, event_date, venue, address, city, producer_id')
    .eq('id', req.params.id)

  if (!isAdmin) {
    eventQuery = eventQuery.eq('producer_id', req.user!.id)
  }

  const { data: event } = await eventQuery.single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado o sin permiso' })
    return
  }

  // 2. Validar body
  const parsed = courtesySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { attendee_name, attendee_email } = parsed.data

  // 3. Buscar o crear el ticket_type "Cortesías" (shopify_variant_id IS NULL)
  let { data: courtesyType } = await supabaseAdmin
    .from('ticket_types')
    .select('id, quantity, sold')
    .eq('event_id', req.params.id)
    .eq('name', 'Cortesías')
    .is('shopify_variant_id', null)
    .maybeSingle()

  if (!courtesyType) {
    const { data: newType, error: createErr } = await supabaseAdmin
      .from('ticket_types')
      .insert({
        event_id:   req.params.id,
        name:       'Cortesías',
        price:      0,
        quantity:   1,
        sold:       0,
        is_active:  true,
        sort_order: 99,
      })
      .select('id, quantity, sold')
      .single()

    if (createErr || !newType) {
      res.status(500).json({ error: 'Error creando tipo de cortesía' })
      return
    }
    courtesyType = newType
  }

  // 4. Abrir cupo: quantity++ para que la constraint sold <= quantity no falle
  const { error: qtyErr } = await supabaseAdmin
    .from('ticket_types')
    .update({ quantity: courtesyType.quantity + 1 })
    .eq('id', courtesyType.id)

  if (qtyErr) {
    res.status(500).json({ error: 'Error actualizando cupo de cortesía' })
    return
  }

  // 5. Crear orden (subtotal=0, payment_method='courtesy')
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .insert({
      event_id:        req.params.id,
      ticket_type_id:  courtesyType.id,
      buyer_name:      attendee_name,
      buyer_email:     attendee_email,
      quantity:        1,
      unit_price:      0,
      subtotal:        0,
      platform_fee:    0,
      producer_amount: 0,
      payment_method:  'courtesy',
      payment_status:  'paid',
    })
    .select('id')
    .single()

  if (orderErr || !order) {
    res.status(500).json({ error: 'Error creando orden de cortesía' })
    return
  }

  // 6. Generar attendee + QR via RPC (también incrementa sold en ticket_type)
  const { error: rpcErr } = await supabaseAdmin
    .rpc('create_attendees_for_order', { order_id: order.id })

  if (rpcErr) {
    res.status(500).json({ error: 'Error generando QR de cortesía' })
    return
  }

  // 7. Leer el attendee igual que hace el endpoint /resend (con JOIN a ticket_types y evento)
  const { data: attendee } = await supabaseAdmin
    .from('attendees')
    .select('id, attendee_name, attendee_email, qr_code, ticket_types(name)')
    .eq('order_id', order.id)
    .single()

  if (!attendee) {
    res.status(201).json({
      ok:         true,
      message:    `Entrada creada para ${attendee_email}, pero el email falló. Usa "Reenviar" desde la tabla.`,
      qr_code:    null,
      email_sent: false,
    })
    return
  }

  // 8. Enviar email — misma lógica que /resend para garantizar consistencia
  const { data: eventForEmail } = await supabaseAdmin
    .from('events')
    .select('id, name, event_date, venue, address, city')
    .eq('id', req.params.id)
    .single()

  let emailSent = false
  if (eventForEmail) {
    try {
      await sendTicketEmail({
        buyerEmail: attendee.attendee_email,
        buyerName:  attendee.attendee_name,
        eventName:  eventForEmail.name,
        eventDate:  eventForEmail.event_date,
        venue:      eventForEmail.venue,
        address:    (eventForEmail as any).address,
        city:       eventForEmail.city,
        tickets: [{
          attendeeName:   attendee.attendee_name,
          ticketTypeName: ((attendee as any).ticket_types as { name: string } | null)?.name || 'Cortesía',
          qrCode:         attendee.qr_code,
        }],
      })
      emailSent = true
    } catch (emailErr: any) {
      console.error('[courtesy] Email falló:', emailErr?.message)
    }
  }

  res.status(201).json({
    ok:         true,
    message:    emailSent
      ? `Entrada de cortesía enviada a ${attendee_email}`
      : `Entrada creada para ${attendee_email}, pero el email falló. Usa "Reenviar" desde la tabla.`,
    qr_code:    attendee.qr_code,
    email_sent: emailSent,
  })
})

// ── DELETE /api/events/:id/courtesy/:attendeeId — Eliminar cortesía ─
router.delete('/:id/courtesy/:attendeeId', requireAuth, async (req: AuthRequest, res: Response) => {
  const isAdmin = req.user!.email === ADMIN_EMAIL

  // 1. Verificar ownership del evento
  let eventQuery = supabaseAdmin
    .from('events')
    .select('id')
    .eq('id', req.params.id)
  if (!isAdmin) eventQuery = eventQuery.eq('producer_id', req.user!.id)
  const { data: event } = await eventQuery.single()
  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado o sin permiso' })
    return
  }

  // 2. Verificar que el attendee existe y es cortesía de este evento
  const { data: attendee } = await supabaseAdmin
    .from('attendees')
    .select('id, ticket_type_id, ticket_types(name)')
    .eq('id', req.params.attendeeId)
    .eq('event_id', req.params.id)
    .maybeSingle()

  if (!attendee) {
    res.status(404).json({ error: 'Entrada no encontrada' })
    return
  }

  const ticketTypeName = (attendee.ticket_types as { name: string } | null)?.name
  if (ticketTypeName !== 'Cortesías') {
    res.status(400).json({ error: 'Solo se pueden eliminar entradas de cortesía' })
    return
  }

  // 3. Eliminar el attendee
  const { error: delErr } = await supabaseAdmin
    .from('attendees')
    .delete()
    .eq('id', req.params.attendeeId)

  if (delErr) {
    res.status(500).json({ error: 'Error eliminando la entrada' })
    return
  }

  // 4. Decrementar sold y quantity en ticket_type (mantener conteo limpio)
  await supabaseAdmin.rpc('decrement_courtesy_slot', {
    p_ticket_type_id: attendee.ticket_type_id,
  }).catch((e: any) => {
    // Fallback manual si la función no existe
    console.warn('[courtesy-delete] RPC no disponible, usando update manual:', e?.message)
    return supabaseAdmin
      .from('ticket_types')
      .select('quantity, sold')
      .eq('id', attendee.ticket_type_id)
      .single()
      .then(({ data: tt }) => {
        if (!tt) return
        return supabaseAdmin
          .from('ticket_types')
          .update({
            sold:     Math.max(0, tt.sold - 1),
            quantity: Math.max(1, tt.quantity - 1),
          })
          .eq('id', attendee.ticket_type_id)
      })
  })

  res.json({ ok: true, message: 'Entrada de cortesía eliminada' })
})

// ── POST /api/events/:id/cancel — Cancelar evento ─────────────────
router.post('/:id/cancel', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  if (['cancelled', 'finished'].includes(event.status)) {
    res.status(400).json({ error: 'El evento ya está cancelado o terminado' })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ message: 'Evento cancelado', event: data })
})

// ── DELETE /api/events/:id — Solo borradores ──────────────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  if (event.status !== 'draft') {
    res.status(400).json({ error: 'Solo se pueden eliminar borradores' })
    return
  }

  const { error } = await supabaseAdmin
    .from('events')
    .delete()
    .eq('id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

export default router
