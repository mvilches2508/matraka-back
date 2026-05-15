import { Router, Response } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { Resend } from 'resend'

const router  = Router()
const resend  = new Resend(process.env.RESEND_API_KEY)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hola@matraka-tickets.com'
const FROM_EMAIL  = process.env.EMAIL_FROM  || 'tickets@matraka-tickets.com'
const APP_NAME    = 'Matraka Tickets'

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.email !== ADMIN_EMAIL) {
    res.status(403).json({ error: 'Acceso restringido al administrador' })
    return false
  }
  return true
}

// ── GET /api/admin/events — Todos los eventos (para el selector) ──
router.get('/events', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireAdmin(req, res)) return

  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, name, event_date, status')
    .order('event_date', { ascending: false })

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})

// ── GET /api/admin/events/:id/recipients — Asistentes del evento ──
router.get('/events/:id/recipients', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireAdmin(req, res)) return

  const { data, error } = await supabaseAdmin
    .from('attendees')
    .select('id, attendee_name, attendee_email, ticket_types(name)')
    .eq('event_id', req.params.id)
    .order('attendee_name')

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})

// ── POST /api/admin/email-blast — Envío masivo BCC ───────────────
const blastSchema = z.object({
  subject:    z.string().min(1).max(200),
  body:       z.string().min(1),
  recipients: z.array(z.string().email()).min(1).max(500),
})

router.post('/email-blast', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireAdmin(req, res)) return

  const parsed = blastSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() })
    return
  }

  const { subject, body, recipients } = parsed.data

  // Deduplicate
  const uniqueRecipients = [...new Set(recipients.map(e => e.toLowerCase().trim()))]

  // Template Matraka envolviendo el body del admin
  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Header marca -->
          <tr>
            <td style="padding:0 0 24px 0;text-align:center;">
              <span style="font-size:28px;font-weight:900;letter-spacing:3px;color:#FFE500;text-transform:uppercase;">
                MATRAKA TICKETS
              </span>
            </td>
          </tr>

          <!-- Contenido -->
          <tr>
            <td style="background:#1A1A1A;border-radius:16px;overflow:hidden;border:1px solid #2A2A2A;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#FFE500;padding:14px 28px;">
                    <span style="font-size:11px;font-weight:800;letter-spacing:3px;color:#0A0A0A;text-transform:uppercase;">
                      Mensaje de Matraka Tickets
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:28px;color:#F0EDE8;font-size:15px;line-height:1.7;">
                    ${body}
                  </td>
                </tr>
                <tr>
                  <td style="background:#0A0A0A;padding:12px 28px;border-top:1px solid #2A2A2A;">
                    <p style="margin:0;font-size:10px;color:#444;text-align:center;">
                      Matraka Tickets by Inovabiz · <a href="mailto:hola@matraka-tickets.com" style="color:#FFE500;text-decoration:none;">hola@matraka-tickets.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim()

  // Enviar en lotes de 50 BCCs para evitar límites de Resend
  const BATCH_SIZE = 50
  let totalSent = 0
  const errors: string[] = []

  for (let i = 0; i < uniqueRecipients.length; i += BATCH_SIZE) {
    const batch = uniqueRecipients.slice(i, i + BATCH_SIZE)
    const { error } = await resend.emails.send({
      from:    `${APP_NAME} <${FROM_EMAIL}>`,
      to:      ADMIN_EMAIL,          // destinatario visible: el admin
      bcc:     batch,                // todos los demás en BCC
      subject,
      html,
    })
    if (error) {
      errors.push(`Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`)
    } else {
      totalSent += batch.length
    }
  }

  if (errors.length > 0) {
    console.error('[email-blast] Errores parciales:', errors)
  }

  res.json({
    ok:         errors.length === 0,
    total_sent: totalSent,
    total:      uniqueRecipients.length,
    errors:     errors.length > 0 ? errors : undefined,
    message:    `Email enviado a ${totalSent} de ${uniqueRecipients.length} destinatarios`,
  })
})

export default router
