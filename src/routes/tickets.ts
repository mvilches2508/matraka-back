import { Router, Response } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'

const router = Router()

const ticketTypeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
  price: z.number().min(0),
  quantity: z.number().int().positive(),
  sale_start: z.string().datetime().optional(),
  sale_end: z.string().datetime().optional(),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).default(0),
})

// Helper: verificar que el evento pertenece al productor
async function verifyEventOwnership(eventId: string, producerId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('events')
    .select('id')
    .eq('id', eventId)
    .eq('producer_id', producerId)
    .single()
  return !!data
}

// GET /api/events/:eventId/tickets — Listar tipos de entrada
router.get('/:eventId/tickets', requireAuth, async (req: AuthRequest, res: Response) => {
  const owned = await verifyEventOwnership(req.params.eventId, req.user!.id)
  if (!owned) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('ticket_types')
    .select('*')
    .eq('event_id', req.params.eventId)
    .order('sort_order', { ascending: true })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Agregar disponibilidad calculada
  const withAvailability = (data || []).map(t => ({
    ...t,
    available: t.quantity - t.sold,
    sold_pct: t.quantity > 0 ? Math.round((t.sold / t.quantity) * 100) : 0,
  }))

  res.json(withAvailability)
})

// POST /api/events/:eventId/tickets — Crear tipo de entrada
router.post('/:eventId/tickets', requireAuth, async (req: AuthRequest, res: Response) => {
  const owned = await verifyEventOwnership(req.params.eventId, req.user!.id)
  if (!owned) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  const parsed = ticketTypeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('ticket_types')
    .insert({ ...parsed.data, event_id: req.params.eventId })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json(data)
})

// PATCH /api/events/:eventId/tickets/:ticketId — Actualizar
router.patch('/:eventId/tickets/:ticketId', requireAuth, async (req: AuthRequest, res: Response) => {
  const owned = await verifyEventOwnership(req.params.eventId, req.user!.id)
  if (!owned) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  // Verificar que el tipo de entrada no tenga ventas si se cambia el precio
  if (req.body.price !== undefined) {
    const { data: tt } = await supabaseAdmin
      .from('ticket_types')
      .select('sold')
      .eq('id', req.params.ticketId)
      .eq('event_id', req.params.eventId)
      .single()

    if (tt && tt.sold > 0) {
      res.status(400).json({ error: 'No se puede cambiar el precio si ya hay entradas vendidas' })
      return
    }
  }

  const parsed = ticketTypeSchema.partial().safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('ticket_types')
    .update(parsed.data)
    .eq('id', req.params.ticketId)
    .eq('event_id', req.params.eventId)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json(data)
})

// DELETE /api/events/:eventId/tickets/:ticketId
router.delete('/:eventId/tickets/:ticketId', requireAuth, async (req: AuthRequest, res: Response) => {
  const owned = await verifyEventOwnership(req.params.eventId, req.user!.id)
  if (!owned) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  // No eliminar si tiene ventas
  const { data: tt } = await supabaseAdmin
    .from('ticket_types')
    .select('sold')
    .eq('id', req.params.ticketId)
    .single()

  if (tt && tt.sold > 0) {
    res.status(400).json({ error: 'No se puede eliminar un tipo de entrada con ventas. Desactívalo en su lugar.' })
    return
  }

  const { error } = await supabaseAdmin
    .from('ticket_types')
    .delete()
    .eq('id', req.params.ticketId)
    .eq('event_id', req.params.eventId)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

export default router
