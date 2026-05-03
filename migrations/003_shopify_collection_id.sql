-- Migration 003: agregar shopify_collection_id a events
-- Ejecutar en Supabase SQL Editor

-- Verifica si la columna cover_image_url ya existe (debería existir por el schema del backend)
-- Si no existe, la agrega:
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- Agrega shopify_collection_id para trackear la colección creada al aprobar
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS shopify_collection_id TEXT;

-- Agrega shopify_product_id a ticket_types (por si queremos trackearlo a nivel de producto)
ALTER TABLE ticket_types
  ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;

-- Índice para buscar por shopify_collection_id
CREATE INDEX IF NOT EXISTS idx_events_shopify_collection
  ON events(shopify_collection_id)
  WHERE shopify_collection_id IS NOT NULL;
