-- ============================================================
-- TOCATA — Migration 002: Integración Shopify
-- ============================================================

-- Columna para mapear producto Shopify → ticket_type tocata
alter table public.ticket_types
  add column if not exists shopify_variant_id text unique;

comment on column public.ticket_types.shopify_variant_id is
  'ID del variant de Shopify que corresponde a este tipo de entrada (ej: "gid://shopify/ProductVariant/123456")';

-- Índice para lookup rápido en el webhook
create index if not exists idx_ticket_types_shopify_variant
  on public.ticket_types(shopify_variant_id)
  where shopify_variant_id is not null;

-- ============================================================
-- LOG de webhooks Shopify (idempotencia — evitar procesar doble)
-- ============================================================
create table if not exists public.shopify_webhook_log (
  id              uuid primary key default gen_random_uuid(),
  shopify_order_id text not null unique,   -- order.id de Shopify (string)
  processed_at    timestamptz not null default now(),
  order_ids       uuid[] not null default '{}',  -- IDs de orders tocata creados
  attendee_count  integer not null default 0
);

comment on table public.shopify_webhook_log is
  'Log de órdenes Shopify ya procesadas. Evita crear entradas duplicadas si el webhook llega dos veces.';

create index if not exists idx_webhook_log_shopify_order
  on public.shopify_webhook_log(shopify_order_id);

-- RLS: solo el service role puede leer/escribir (backend usa service_role_key)
alter table public.shopify_webhook_log enable row level security;

-- No policies de usuario final — acceso solo via service_role (backend)
-- El backend usa supabaseAdmin que bypasea RLS

-- ============================================================
-- Vista pública de eventos (para la tienda Shopify)
-- Necesaria para que el webhook pueda encontrar eventos por variant
-- ============================================================
create or replace view public.v_ticket_type_by_variant as
select
  tt.id            as ticket_type_id,
  tt.event_id,
  tt.name          as ticket_type_name,
  tt.price,
  tt.quantity,
  tt.sold,
  tt.shopify_variant_id,
  e.name           as event_name,
  e.event_date,
  e.venue,
  e.city,
  e.cover_image_url,
  e.producer_id,
  p.name           as producer_name,
  p.email          as producer_email
from public.ticket_types tt
join public.events e on e.id = tt.event_id
join public.producers p on p.id = e.producer_id
where tt.shopify_variant_id is not null
  and tt.is_active = true
  and e.status in ('published', 'sold_out');
