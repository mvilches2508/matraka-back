/**
 * POST /api/checkout/custom-price
 *
 * Crea un Draft Order en Shopify con precio libre (mínimo $2.000 CLP).
 * Flujo:
 *   1. Validar que amount >= MIN_PRICE
 *   2. Crear Draft Order vía Admin API con el precio ingresado
 *   3. Devolver { invoiceUrl } para redirigir al cliente
 *
 * El Draft Order cuando se paga dispara el webhook orders/paid
 * exactamente igual que una compra normal → QR + email sin cambios.
 */

import { Router, Request, Response } from 'express'

const router = Router()

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'tiketera-2.myshopify.com'
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || ''
const MIN_PRICE_CLP = 2000

async function shopifyApi(path: string, method: string, body?: object) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-07/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Shopify API ${res.status}: ${err}`)
  }
  return res.json()
}

/**
 * POST /api/checkout/custom-price
 * Body: { variantId: number, amount: number, note?: string }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { variantId, amount, note } = req.body

    // Validaciones
    if (!variantId || typeof variantId !== 'number') {
      return res.status(400).json({ error: 'variantId requerido' })
    }
    const parsedAmount = Number(amount)
    if (isNaN(parsedAmount) || parsedAmount < MIN_PRICE_CLP) {
      return res.status(400).json({
        error: `El monto mínimo es $${MIN_PRICE_CLP.toLocaleString('es-CL')} CLP`,
      })
    }

    if (!SHOPIFY_TOKEN) {
      return res.status(500).json({ error: 'Shopify no configurado' })
    }

    // Crear Draft Order con precio personalizado
    const data = await shopifyApi('draft_orders.json', 'POST', {
      draft_order: {
        line_items: [
          {
            variant_id: variantId,
            quantity: 1,
            price: parsedAmount.toFixed(2),  // Shopify requiere string con decimales
            applied_discount: null,           // Sin descuento sobre el precio custom
          },
        ],
        note: note || 'Aporte personal — precio libre',
        use_customer_default_address: false,
      },
    })

    const invoiceUrl: string = data?.draft_order?.invoice_url
    if (!invoiceUrl) {
      throw new Error('Shopify no devolvió invoice_url')
    }

    return res.json({ invoiceUrl })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('[checkout] Error creando Draft Order:', message)
    return res.status(500).json({ error: message })
  }
})

export default router
