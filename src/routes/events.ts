import { Router, Response } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'

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

// ── GET /api/events — Listar eventos del productor ─────────────────
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, limit = '20', offset = '0' } = req.query

  let query = supabaseAdmin
    .from('events')
    .select(`
      *,
      ticket_types(id, name, price, quantity, sold, is_active)
    `)
    .eq('producer_id', req.user!.id)
    .order('event_date', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

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

// ── GET /api/events/:id — Detalle de un evento ────────────────────
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: event, error } = await supabaseAdmin
    .from('events')
    .select(`
      *,
      ticket_types(*)
    `)
    .eq('id', req.params.id)
    .eq('producer_id', req.user!.id)
    .single()

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
  const stats = {
    total_ventas: orders.length,
    total_entradas: orders.reduce((s, o) => s + o.quantity, 0),
    total_revenue: orders.reduce((s, o) => s + Number(o.subtotal), 0),
    producer_revenue: orders.reduce((s, o) => s + Number(o.producer_amount), 0),
    recientes: orders.slice(0, 10),
  }

  res.json({ ...event, order_stats: stats })
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

  res.json({ message: 'Evento enviado a revisión. Te contactamos en menos de 24 horas.', event: data })
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
