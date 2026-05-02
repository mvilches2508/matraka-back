import { Router, Response } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /api/orders — Órdenes del productor (todos sus eventos)
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { event_id, status = 'paid', limit = '50', offset = '0' } = req.query

  let query = supabaseAdmin
    .from('orders')
    .select(`
      id, buyer_name, buyer_email, buyer_phone, quantity,
      subtotal, producer_amount, platform_fee,
      payment_status, payment_method, created_at,
      events!inner(id, name, producer_id),
      ticket_types(id, name, price)
    `, { count: 'exact' })
    .eq('events.producer_id', req.user!.id)
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (event_id) query = query.eq('event_id', event_id)
  if (status) query = query.eq('payment_status', status)

  const { data, error, count } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data: data || [], count, total_pages: Math.ceil((count || 0) / Number(limit)) })
})

// GET /api/orders/:id — Detalle de una orden
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select(`
      *,
      events!inner(id, name, producer_id, event_date, venue),
      ticket_types(id, name, price),
      attendees(id, attendee_name, attendee_email, qr_code, checked_in, checked_in_at)
    `)
    .eq('id', req.params.id)
    .eq('events.producer_id', req.user!.id)
    .single()

  if (error || !order) {
    res.status(404).json({ error: 'Orden no encontrada' })
    return
  }

  res.json(order)
})

// GET /api/orders/event/:eventId/export — Exportar CSV de órdenes
router.get('/event/:eventId/export', requireAuth, async (req: AuthRequest, res: Response) => {
  // Verificar propiedad del evento
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, name')
    .eq('id', req.params.eventId)
    .eq('producer_id', req.user!.id)
    .single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select(`
      id, buyer_name, buyer_email, buyer_phone, buyer_rut,
      quantity, subtotal, producer_amount, payment_status,
      payment_method, created_at,
      ticket_types(name, price)
    `)
    .eq('event_id', req.params.eventId)
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false })

  // Generar CSV
  const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'RUT', 'Tipo Entrada', 'Cantidad', 'Total', 'Monto Productor', 'Fecha']
  const rows = (orders || []).map(o => [
    o.id,
    o.buyer_name,
    o.buyer_email,
    o.buyer_phone || '',
    o.buyer_rut || '',
    (o.ticket_types as { name: string } | null)?.name || '',
    o.quantity,
    o.subtotal,
    o.producer_amount,
    new Date(o.created_at).toLocaleString('es-CL'),
  ])

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="ventas-${event.name}-${Date.now()}.csv"`)
  res.send('﻿' + csv) // BOM para Excel
})

export default router
