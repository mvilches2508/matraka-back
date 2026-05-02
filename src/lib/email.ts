import { Resend } from 'resend'
import QRCode from 'qrcode'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_EMAIL = process.env.EMAIL_FROM || 'tickets@matraka-tickets.com'
const APP_NAME   = 'Matraka Tickets'

// ── Generar QR como data URL (PNG base64 inline) ───────────────────
async function generateQRDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    width: 300,
    margin: 2,
    color: { dark: '#0A0A0A', light: '#FFFFFF' },
    errorCorrectionLevel: 'H',
  })
}

// ── Template HTML del ticket ───────────────────────────────────────
function buildTicketHTML(params: {
  attendeeName: string
  ticketTypeName: string
  eventName: string
  eventDate: string
  venue: string
  city: string
  qrCode: string
  qrDataUrl: string
  orderIndex: number
  totalInOrder: number
}): string {
  const {
    attendeeName, ticketTypeName, eventName,
    eventDate, venue, city,
    qrCode, qrDataUrl, orderIndex, totalInOrder,
  } = params

  const dateFormatted = new Date(eventDate).toLocaleDateString('es-CL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
  const timeFormatted = new Date(eventDate).toLocaleTimeString('es-CL', {
    hour: '2-digit', minute: '2-digit',
  })

  const ticketLabel = totalInOrder > 1
    ? `Entrada ${orderIndex} de ${totalInOrder}`
    : 'Tu entrada'

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Tu entrada — ${eventName}</title>
</head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Header marca -->
          <tr>
            <td style="padding:0 0 24px 0;text-align:center;">
              <span style="font-size:28px;font-weight:900;letter-spacing:3px;color:#FFE500;text-transform:uppercase;">
                TIKETERA
              </span>
            </td>
          </tr>

          <!-- Ticket card -->
          <tr>
            <td style="background:#1A1A1A;border-radius:16px;overflow:hidden;border:1px solid #2A2A2A;">

              <!-- Franja superior amarilla -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#FFE500;padding:14px 28px;">
                    <span style="font-size:11px;font-weight:800;letter-spacing:3px;color:#0A0A0A;text-transform:uppercase;">
                      ${ticketLabel}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Cuerpo del ticket -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <!-- Info izquierda -->
                  <td style="padding:28px;vertical-align:top;width:55%;">
                    <p style="margin:0 0 6px 0;font-size:11px;letter-spacing:2px;color:#666;text-transform:uppercase;font-weight:600;">Evento</p>
                    <p style="margin:0 0 20px 0;font-size:22px;font-weight:900;color:#F0EDE8;line-height:1.2;">${eventName}</p>

                    <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2px;color:#666;text-transform:uppercase;font-weight:600;">Tipo</p>
                    <p style="margin:0 0 16px 0;">
                      <span style="display:inline-block;background:rgba(255,229,0,0.12);color:#FFE500;font-size:12px;font-weight:800;padding:4px 10px;border-radius:4px;letter-spacing:1px;text-transform:uppercase;">
                        ${ticketTypeName}
                      </span>
                    </p>

                    <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2px;color:#666;text-transform:uppercase;font-weight:600;">Fecha</p>
                    <p style="margin:0 0 4px 0;font-size:14px;color:#F0EDE8;font-weight:600;text-transform:capitalize;">${dateFormatted}</p>
                    <p style="margin:0 0 16px 0;font-size:13px;color:#888;">${timeFormatted} hrs</p>

                    <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2px;color:#666;text-transform:uppercase;font-weight:600;">Lugar</p>
                    <p style="margin:0 0 2px 0;font-size:14px;color:#F0EDE8;font-weight:600;">${venue}</p>
                    <p style="margin:0;font-size:13px;color:#888;">${city}</p>

                    <p style="margin:20px 0 4px 0;font-size:11px;letter-spacing:2px;color:#666;text-transform:uppercase;font-weight:600;">Titular</p>
                    <p style="margin:0;font-size:14px;color:#F0EDE8;font-weight:600;">${attendeeName}</p>
                  </td>

                  <!-- Separador punteado -->
                  <td style="width:1px;background:repeating-linear-gradient(to bottom,transparent,transparent 6px,#333 6px,#333 12px);"></td>

                  <!-- QR derecha -->
                  <td style="padding:28px;vertical-align:middle;text-align:center;width:45%;">
                    <img src="${qrDataUrl}" alt="QR Entrada" width="160" height="160"
                      style="display:block;margin:0 auto 12px;border-radius:8px;border:4px solid #0A0A0A;"/>
                    <p style="margin:0;font-family:monospace;font-size:13px;font-weight:700;color:#FFE500;letter-spacing:2px;">
                      ${qrCode}
                    </p>
                    <p style="margin:6px 0 0;font-size:10px;color:#555;">Presenta este QR en la entrada</p>
                  </td>
                </tr>
              </table>

              <!-- Franja inferior -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0A0A0A;padding:12px 28px;border-top:1px solid #2A2A2A;">
                    <p style="margin:0;font-size:10px;color:#444;text-align:center;">
                      Esta entrada es intransferible · Un uso por QR · Matraka Tickets by Inovabiz
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer email -->
          <tr>
            <td style="padding:24px 0 0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#444;">
                ¿Problemas? Escríbenos a
                <a href="mailto:hola@matraka-tickets.com" style="color:#FFE500;text-decoration:none;">hola@matraka-tickets.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

// ── Parámetros para enviar tickets de una orden ────────────────────
export interface TicketEmailParams {
  buyerEmail: string
  buyerName: string
  eventName: string
  eventDate: string
  venue: string
  city: string
  tickets: Array<{
    attendeeName: string
    ticketTypeName: string
    qrCode: string
  }>
}

// ── Función principal: enviar email con todos los tickets de la orden ──
export async function sendTicketEmail(params: TicketEmailParams): Promise<void> {
  const { buyerEmail, buyerName, eventName, eventDate, venue, city, tickets } = params

  // Generar HTML de cada ticket
  const ticketHtmlBlocks = await Promise.all(
    tickets.map(async (t, i) => {
      const qrDataUrl = await generateQRDataUrl(t.qrCode)
      return buildTicketHTML({
        attendeeName:   t.attendeeName,
        ticketTypeName: t.ticketTypeName,
        eventName,
        eventDate,
        venue,
        city,
        qrCode:    t.qrCode,
        qrDataUrl,
        orderIndex:   i + 1,
        totalInOrder: tickets.length,
      })
    })
  )

  // Email contenedor (un HTML por ticket separado por espaciado)
  const fullHtml = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0A0A0A;">
  ${ticketHtmlBlocks.join('\n<div style="height:1px;background:#222;margin:0 32px;"></div>\n')}
</body>
</html>`

  const ticketWord = tickets.length === 1 ? 'entrada' : 'entradas'
  const subject = `🎟️ Tus ${tickets.length} ${ticketWord} para ${eventName}`

  const { error } = await resend.emails.send({
    from: `${APP_NAME} <${FROM_EMAIL}>`,
    to:   buyerEmail,
    subject,
    html: fullHtml,
  })

  if (error) {
    console.error('[email] Error al enviar ticket:', error)
    throw new Error(`Error enviando email: ${error.message}`)
  }

  console.log(`[email] ✓ ${tickets.length} ticket(s) enviados a ${buyerEmail} para "${eventName}"`)
}
