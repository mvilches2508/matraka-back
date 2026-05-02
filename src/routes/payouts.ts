import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /api/payouts — Historial de pagos del productor
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('payouts')
    .select(`
      *,
      events(id, name, event_date)
    `)
    .eq('producer_id', req.user!.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json(data || [])
})

// GET /api/payouts/summary — Resumen financiero del productor
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  const producerId = req.user!.id

  // Revenue total de órdenes pagadas
  const { data: revenueData } = await supabaseAdmin
    .from('orders')
    .select(`
      subtotal, producer_amount, platform_fee, created_at,
      events!inner(producer_id)
    `)
    .eq('events.producer_id', producerId)
    .eq('payment_status', 'paid')

  // Pagos ya realizados
  const { data: payoutsData } = await supabaseAdmin
    .from('payouts')
    .select('amount, status')
    .eq('producer_id', producerId)

  const orders = revenueData || []
  const payouts = payoutsData || []

  const totalRecaudado = orders.reduce((s, o) => s + Number(o.subtotal), 0)
  const totalProductor = orders.reduce((s, o) => s + Number(o.producer_amount), 0)
  const totalComision = orders.reduce((s, o) => s + Number(o.platform_fee), 0)
  const totalPagado = payouts
    .filter(p => p.status === 'paid')
    .reduce((s, p) => s + Number(p.amount), 0)
  const totalPendiente = payouts
    .filter(p => ['pending', 'processing'].includes(p.status))
    .reduce((s, p) => s + Number(p.amount), 0)
  const saldoDisponible = totalProductor - totalPagado

  // Revenue por mes (últimos 6 meses)
  const monthlyRevenue = orders.reduce((acc: Record<string, number>, o) => {
    const month = new Date(o.created_at).toISOString().slice(0, 7)
    acc[month] = (acc[month] || 0) + Number(o.producer_amount)
    return acc
  }, {})

  res.json({
    resumen: {
      total_recaudado: totalRecaudado,
      total_productor: totalProductor,
      total_comision: totalComision,
      total_pagado: totalPagado,
      total_pendiente: totalPendiente,
      saldo_disponible: Math.max(0, saldoDisponible),
    },
    monthly_revenue: Object.entries(monthlyRevenue)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amount]) => ({ month, amount })),
  })
})

export default router
