import { Router, Response } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /api/producers/me — Perfil del productor autenticado
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('producers')
    .select('*')
    .eq('id', req.user!.id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      res.status(404).json({ error: 'Perfil no encontrado' })
      return
    }
    res.status(500).json({ error: error.message })
    return
  }

  res.json(data)
})

// PATCH /api/producers/me — Actualizar perfil
const updateProducerSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z.string().optional(),
  rut: z.string().optional(),
  bio: z.string().max(500).optional(),
  avatar_url: z.string().url().optional(),
  bank_name: z.string().optional(),
  bank_account: z.string().optional(),
  bank_rut: z.string().optional(),
})

router.patch('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = updateProducerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('producers')
    .update(parsed.data)
    .eq('id', req.user!.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json(data)
})

// GET /api/producers/me/analytics — KPIs del dashboard
router.get('/me/analytics', requireAuth, async (req: AuthRequest, res: Response) => {
  const producerId = req.user!.id

  // 1. Obtener eventos del productor (fuente de verdad para filtrar el resto)
  const { data: eventsData } = await supabaseAdmin
    .from('events')
    .select('id, status')
    .eq('producer_id', producerId)

  const events = eventsData || []
  const eventIds = events.map(e => e.id)

  // Si no tiene eventos, devolver zeros sin más queries
  if (eventIds.length === 0) {
    res.json({
      eventos: { total: 0, activos: 0, en_revision: 0, borradores: 0, terminados: 0 },
      revenue: { total_recaudado: 0, total_productor: 0, total_comision: 0, entradas_vendidas: 0 },
      asistentes: { total: 0, checked_in: 0 },
      recientes: [],
    })
    return
  }

  // 2. Consultas paralelas filtrando por event_id (evita el bug de dot-notation)
  const [revenueRes, attendeesRes, recentOrdersRes] = await Promise.all([
    supabaseAdmin
      .from('orders')
      .select('subtotal, producer_amount, platform_fee, quantity')
      .in('event_id', eventIds)
      .eq('payment_status', 'paid'),

    supabaseAdmin
      .from('attendees')
      .select('checked_in')
      .in('event_id', eventIds),

    supabaseAdmin
      .from('orders')
      .select(`
        id, buyer_name, buyer_email, quantity, subtotal, payment_status, created_at,
        events(name),
        ticket_types(name)
      `)
      .in('event_id', eventIds)
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  const orders = revenueRes.data || []
  const attendees = attendeesRes.data || []
  const recentOrders = recentOrdersRes.data || []

  const analytics = {
    eventos: {
      total: events.length,
      activos: events.filter(e => e.status === 'published').length,
      en_revision: events.filter(e => e.status === 'review').length,
      borradores: events.filter(e => e.status === 'draft').length,
      terminados: events.filter(e => e.status === 'finished').length,
    },
    revenue: {
      total_recaudado: orders.reduce((s, o) => s + Number(o.subtotal), 0),
      total_productor: orders.reduce((s, o) => s + Number(o.producer_amount), 0),
      total_comision: orders.reduce((s, o) => s + Number(o.platform_fee), 0),
      entradas_vendidas: orders.reduce((s, o) => s + Number(o.quantity), 0),
    },
    asistentes: {
      total: attendees.length,
      checked_in: attendees.filter(a => a.checked_in).length,
    },
    recientes: recentOrders,
  }

  res.json(analytics)
})

export default router
