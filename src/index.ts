import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import producersRouter from './routes/producers'
import eventsRouter from './routes/events'
import ticketsRouter from './routes/tickets'
import ordersRouter from './routes/orders'
import attendeesRouter from './routes/attendees'
import payoutsRouter from './routes/payouts'
import checkoutRouter from './routes/checkout'
import webhooksRouter from './routes/webhooks'

const app = express()
const PORT = process.env.PORT || 3001

// Confiar en el proxy de Vercel (necesario para express-rate-limit en producción)
app.set('trust proxy', 1)

// ── Seguridad y middleware base ────────────────────────────────────
app.use(helmet())
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// CORS — orígenes permitidos
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error(`CORS: origen no permitido: ${origin}`))
    }
  },
  credentials: true,
}))

// Rate limiting global
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  message: { error: 'Demasiadas peticiones. Intenta en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(limiter)

// Rate limiting estricto para validación de QR (anti-bruteforce)
const qrLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  message: { error: 'Límite de validaciones alcanzado. Espera un momento.' },
})

// IMPORTANTE: Los webhooks de Shopify necesitan el body crudo (sin parsear)
// para verificar el HMAC. Se montan ANTES del express.json() global.
app.use('/api/webhooks', webhooksRouter)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    service: 'matraka-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  })
})

// ── Shopify OAuth callback (temporal — para obtener access token) ──
// Eliminar una vez que SHOPIFY_ACCESS_TOKEN esté en las env vars de Vercel
app.get('/auth/shopify/callback', async (req, res) => {
  const { code, shop } = req.query as { code?: string; shop?: string }

  if (!code || !shop) {
    res.status(400).send('Faltan parámetros: code o shop')
    return
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

  if (!clientId || !clientSecret || clientSecret === 'PEGAR_AQUI_EL_SECRET_DEL_DEV_DASHBOARD') {
    res.status(500).send('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET no configurados en .env')
    return
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    })

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Shopify OAuth] Error:', tokenData)
      res.status(500).send(`Error obteniendo token: ${JSON.stringify(tokenData)}`)
      return
    }

    const token = tokenData.access_token
    console.log('✅ SHOPIFY ACCESS TOKEN OBTENIDO:', token)

    // Devuelve el token en la respuesta para copiarlo
    res.send(`
      <html><body style="font-family:monospace;padding:40px;background:#111;color:#0f0">
        <h2 style="color:#ff0">✅ Access Token obtenido correctamente</h2>
        <p>Copia este valor y agrégalo como <strong>SHOPIFY_ACCESS_TOKEN</strong> en las variables de entorno de Vercel:</p>
        <pre style="background:#222;padding:20px;border-radius:8px;font-size:18px;color:#0ff;word-break:break-all">${token}</pre>
        <p style="color:#888">Luego elimina la ruta /auth/shopify/callback del código.</p>
      </body></html>
    `)
  } catch (err) {
    console.error('[Shopify OAuth] Excepción:', err)
    res.status(500).send(`Excepción: ${(err as Error).message}`)
  }
})

// ── Rutas API ──────────────────────────────────────────────────────
app.use('/api/producers', producersRouter)
app.use('/api/events', eventsRouter)
app.use('/api/events', ticketsRouter)        // /api/events/:eventId/tickets
app.use('/api/orders', ordersRouter)
app.use('/api/attendees', qrLimiter, attendeesRouter)
app.use('/api/payouts', payoutsRouter)
app.use('/api/checkout', checkoutRouter)
// /api/webhooks ya está montado arriba (antes del json middleware)

// ── 404 handler ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.originalUrl,
  })
})

// ── Error handler global ───────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err.message, err.stack)
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message,
  })
})

// ── Arrancar servidor (solo en desarrollo) ───────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Matraka API corriendo en http://localhost:${PORT}`)
  })
}

export default app
