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

// ── Rutas API ──────────────────────────────────────────────────────
app.use('/api/producers', producersRouter)
app.use('/api/events', eventsRouter)
app.use('/api/events', ticketsRouter)        // /api/events/:eventId/tickets
app.use('/api/orders', ordersRouter)
app.use('/api/attendees', qrLimiter, attendeesRouter)
app.use('/api/payouts', payoutsRouter)
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
