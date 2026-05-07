import { Router, Response } from 'express'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { sendTicketEmail } from '../lib/email'

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hola@matraka-tickets.com'

const router = Router()

// GET /api/attendees/:eventId — Lista de asistentes de un evento
router.get('/:eventId', requireAuth, async (req: AuthRequest, res: Response) => {
  const isAdmin = req.user!.email === ADMIN_EMAIL

  // Verificar propiedad (admin puede ver cualquier evento)
  let eventQuery = supabaseAdmin
    .from('events')
    .select('id, name')
    .eq('id', req.params.eventId)

  if (!isAdmin) {
    eventQuery = eventQuery.eq('producer_id', req.user!.id)
  }

  const { data: event } = await eventQuery.single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  const { page = '1', search = '' } = req.query
  const limit = 50
  const offset = (Number(page) - 1) * limit

  let query = supabaseAdmin
    .from('attendees')
    .select(`
      id, attendee_name, attendee_email, qr_code,
      checked_in, checked_in_at, checked_in_by, created_at,
      ticket_types(name, price),
      orders(buyer_phone)
    `, { count: 'exact' })
    .eq('event_id', req.params.eventId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (search) {
    query = query.or(`attendee_name.ilike.%${search}%,attendee_email.ilike.%${search}%`)
  }

  const { data, error, count } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({
    data: data || [],
    count,
    total_pages: Math.ceil((count || 0) / limit),
    page: Number(page),
  })
})

// POST /api/attendees/validate — Validar QR de entrada
router.post('/validate', requireAuth, async (req: AuthRequest, res: Response) => {
  const { qr_code } = req.body

  if (!qr_code || typeof qr_code !== 'string') {
    res.status(400).json({ error: 'QR code requerido' })
    return
  }

  // Normalizar QR: lectores USB HID en teclado ES envían "'" en lugar de "-"
  // por mismatch de scan codes entre US y ES layout. Reemplazar antes de buscar.
  const normalizedQr = qr_code.toUpperCase().trim().replace(/'/g, '-')

  // Buscar el attendee por QR, incluyendo estado de la orden
  const { data: attendee, error } = await supabaseAdmin
    .from('attendees')
    .select(`
      *,
      events!inner(id, name, event_date, venue, producer_id),
      ticket_types(name, price),
      orders(id, payment_status)
    `)
    .eq('qr_code', normalizedQr)
    .single()

  if (error || !attendee) {
    res.status(404).json({
      valid: false,
      error: 'Entrada no encontrada. QR inválido.',
    })
    return
  }

  // Verificar que el evento pertenece al productor
  const eventData = (attendee as any).events as { producer_id: string; name: string; event_date: string; venue: string }
  if (eventData.producer_id !== req.user!.id) {
    res.status(403).json({
      valid: false,
      error: 'No tienes permiso para validar entradas de este evento',
    })
    return
  }

  // Verificar si la orden fue cancelada
  const orderData = (attendee as any).orders as { id: string; payment_status: string } | null
  if (orderData?.payment_status === 'refunded') {
    res.json({
      valid: false,
      cancelled: true,
      error: 'Esta entrada fue anulada y no es válida.',
      attendee: {
        name: attendee.attendee_name,
        email: attendee.attendee_email,
        ticket_type: (attendee.ticket_types as { name: string } | null)?.name,
      },
    })
    return
  }

  // Si ya fue usado
  if (attendee.checked_in) {
    res.json({
      valid: false,
      already_used: true,
      error: 'Esta entrada ya fue usada',
      attendee: {
        name: attendee.attendee_name,
        email: attendee.attendee_email,
        ticket_type: (attendee.ticket_types as { name: string } | null)?.name,
        checked_in_at: attendee.checked_in_at,
      },
    })
    return
  }

  // Marcar como checked in
  const { error: updateError } = await supabaseAdmin
    .from('attendees')
    .update({
      checked_in: true,
      checked_in_at: new Date().toISOString(),
      checked_in_by: req.user!.email,
    })
    .eq('id', attendee.id)

  if (updateError) {
    res.status(500).json({ valid: false, error: 'Error al registrar el ingreso' })
    return
  }

  res.json({
    valid: true,
    attendee: {
      name: attendee.attendee_name,
      email: attendee.attendee_email,
      ticket_type: (attendee.ticket_types as { name: string; price: number } | null)?.name,
      event_name: eventData.name,
      event_date: eventData.event_date,
      venue: eventData.venue,
    },
    message: '✓ Entrada válida. ¡Bienvenido!',
  })
})

// GET /api/attendees/:eventId/stats — Stats de check-in en tiempo real
router.get('/:eventId/stats', requireAuth, async (req: AuthRequest, res: Response) => {
  const isAdmin = req.user!.email === ADMIN_EMAIL

  let statsEventQuery = supabaseAdmin
    .from('events')
    .select('id, name, capacity')
    .eq('id', req.params.eventId)

  if (!isAdmin) {
    statsEventQuery = statsEventQuery.eq('producer_id', req.user!.id)
  }

  const { data: event } = await statsEventQuery.single()

  if (!event) {
    res.status(404).json({ error: 'Evento no encontrado' })
    return
  }

  const { data: stats } = await supabaseAdmin
    .from('attendees')
    .select('checked_in')
    .eq('event_id', req.params.eventId)

  const total = stats?.length || 0
  const checked_in = stats?.filter(a => a.checked_in).length || 0

  res.json({
    total_attendees: total,
    checked_in,
    pending: total - checked_in,
    occupancy_pct: total > 0 ? Math.round((checked_in / total) * 100) : 0,
  })
})

// POST /api/attendees/:attendeeId/resend — Reenviar email con QR al asistente
router.post('/:attendeeId/resend', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: attendee } = await supabaseAdmin
    .from('attendees')
    .select(`
      id, attendee_name, attendee_email, qr_code,
      ticket_types(name),
      events!inner(id, name, event_date, venue, address, city, producer_id)
    `)
    .eq('id', req.params.attendeeId)
    .single()

  if (!attendee) {
    res.status(404).json({ error: 'Asistente no encontrado' })
    return
  }

  const event = (attendee as any).events as {
    id: string; name: string; event_date: string
    venue: string; address?: string; city: string; producer_id: string
  }

  // Verificar que el evento pertenece al productor autenticado
  if (event.producer_id !== req.user!.id) {
    res.status(403).json({ error: 'Sin permiso para este asistente' })
    return
  }

  try {
    await sendTicketEmail({
      buyerEmail:  attendee.attendee_email,
      buyerName:   attendee.attendee_name,
      eventName:   event.name,
      eventDate:   event.event_date,
      venue:       event.venue,
      address:     event.address,
      city:        event.city,
      tickets: [{
        attendeeName:   attendee.attendee_name,
        ticketTypeName: ((attendee as any).ticket_types as { name: string } | null)?.name || 'General',
        qrCode:         attendee.qr_code,
      }],
    })
  } catch (err) {
    console.error('[resend] Error enviando email:', err)
    res.status(500).json({ error: 'Error al reenviar el email' })
    return
  }

  res.json({ ok: true, message: `Email reenviado a ${attendee.attendee_email}` })
})

export default router
