-- ============================================================
-- TOCATA — Portal Productor
-- Supabase Migration 001: Schema inicial completo
-- ============================================================

-- Habilitar extensiones necesarias
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLA: producers (productores/vendedores)
-- Extiende auth.users con datos del productor
-- ============================================================
create table public.producers (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text not null,
  email         text not null,
  rut           text,
  phone         text,
  bio           text,
  avatar_url    text,
  bank_name     text,
  bank_account  text,
  bank_rut      text,
  verified      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.producers is 'Perfil del productor/proveedor de eventos';

-- ============================================================
-- TABLA: events
-- ============================================================
create table public.events (
  id              uuid primary key default gen_random_uuid(),
  producer_id     uuid not null references public.producers(id) on delete cascade,
  name            text not null,
  description     text,
  category        text not null default 'Música en vivo',
  venue           text not null,
  address         text,
  city            text not null default 'Santiago',
  event_date      timestamptz not null,
  doors_open      timestamptz,
  cover_image_url text,
  status          text not null default 'draft'
    check (status in ('draft', 'review', 'published', 'sold_out', 'cancelled', 'finished')),
  capacity        integer,
  age_restriction integer not null default 0,
  commission_pct  numeric(5,2) not null default 5.00,
  tags            text[] default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.events is 'Eventos creados por productores';
comment on column public.events.status is 'draft→review→published→sold_out/cancelled/finished';
comment on column public.events.commission_pct is 'Porcentaje que cobra tocata (5 o 8)';

-- ============================================================
-- TABLA: ticket_types (tipos de entrada por evento)
-- ============================================================
create table public.ticket_types (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  name        text not null,
  description text,
  price       numeric(12,2) not null check (price >= 0),
  quantity    integer not null check (quantity > 0),
  sold        integer not null default 0 check (sold >= 0),
  sale_start  timestamptz,
  sale_end    timestamptz,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint sold_lte_quantity check (sold <= quantity)
);

comment on table public.ticket_types is 'Tipos de entrada por evento (General, VIP, etc)';

-- ============================================================
-- TABLA: orders (órdenes de compra)
-- ============================================================
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events(id),
  ticket_type_id    uuid not null references public.ticket_types(id),
  buyer_name        text not null,
  buyer_email       text not null,
  buyer_phone       text,
  buyer_rut         text,
  quantity          integer not null default 1 check (quantity > 0),
  unit_price        numeric(12,2) not null,
  subtotal          numeric(12,2) not null,
  platform_fee      numeric(12,2) not null default 0,
  producer_amount   numeric(12,2) not null,
  payment_method    text,
  payment_status    text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'refunded', 'failed')),
  payment_provider  text,
  payment_id        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.orders is 'Órdenes de compra de entradas';
comment on column public.orders.producer_amount is 'Lo que recibe el productor (subtotal - platform_fee)';

-- ============================================================
-- TABLA: attendees (asistentes / entradas emitidas)
-- Una fila por entrada emitida dentro de una orden
-- ============================================================
create table public.attendees (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  event_id        uuid not null references public.events(id),
  ticket_type_id  uuid not null references public.ticket_types(id),
  attendee_name   text not null,
  attendee_email  text not null,
  qr_code         text not null unique,
  checked_in      boolean not null default false,
  checked_in_at   timestamptz,
  checked_in_by   text,
  created_at      timestamptz not null default now()
);

comment on table public.attendees is 'Entradas emitidas con QR individual por asistente';

-- ============================================================
-- TABLA: payouts (pagos al productor)
-- ============================================================
create table public.payouts (
  id              uuid primary key default gen_random_uuid(),
  producer_id     uuid not null references public.producers(id),
  event_id        uuid references public.events(id),
  amount          numeric(12,2) not null check (amount > 0),
  status          text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'failed')),
  bank_transfer_id text,
  notes           text,
  paid_at         timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.payouts is 'Pagos realizados al productor por tocata';

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
create index idx_events_producer_id   on public.events(producer_id);
create index idx_events_status        on public.events(status);
create index idx_events_event_date    on public.events(event_date);
create index idx_ticket_types_event   on public.ticket_types(event_id);
create index idx_orders_event_id      on public.orders(event_id);
create index idx_orders_ticket_type   on public.orders(ticket_type_id);
create index idx_orders_payment_status on public.orders(payment_status);
create index idx_orders_buyer_email   on public.orders(buyer_email);
create index idx_attendees_order_id   on public.attendees(order_id);
create index idx_attendees_event_id   on public.attendees(event_id);
create index idx_attendees_qr_code    on public.attendees(qr_code);
create index idx_payouts_producer_id  on public.payouts(producer_id);

-- ============================================================
-- TRIGGERS: updated_at automático
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_producers_updated_at
  before update on public.producers
  for each row execute function public.set_updated_at();

create trigger trg_events_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

create trigger trg_orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ============================================================
-- FUNCIÓN: generar QR code único para attendee
-- ============================================================
create or replace function public.generate_qr_code()
returns text language plpgsql as $$
begin
  return 'TKT-' || upper(encode(gen_random_bytes(6), 'hex'));
end;
$$;

-- ============================================================
-- FUNCIÓN: crear attendees al confirmar pago
-- Se llama desde el backend cuando payment_status → 'paid'
-- ============================================================
create or replace function public.create_attendees_for_order(order_id uuid)
returns void language plpgsql security definer as $$
declare
  ord public.orders%rowtype;
  i   integer;
  att_name text;
  att_email text;
begin
  select * into ord from public.orders where id = order_id;
  if not found then
    raise exception 'Order % not found', order_id;
  end if;

  -- Incrementar sold en ticket_type
  update public.ticket_types
  set sold = sold + ord.quantity
  where id = ord.ticket_type_id;

  -- Crear una entrada por cada unidad
  for i in 1..ord.quantity loop
    att_name  := case when ord.quantity = 1 then ord.buyer_name
                      else ord.buyer_name || ' (' || i || ')' end;
    att_email := ord.buyer_email;

    insert into public.attendees (
      order_id, event_id, ticket_type_id,
      attendee_name, attendee_email, qr_code
    ) values (
      ord.id, ord.event_id, ord.ticket_type_id,
      att_name, att_email, public.generate_qr_code()
    );
  end loop;

  -- Marcar evento sold_out si corresponde
  update public.events e
  set status = 'sold_out'
  where e.id = ord.event_id
    and e.status = 'published'
    and (
      select coalesce(sum(quantity - sold), 0)
      from public.ticket_types
      where event_id = ord.event_id and is_active = true
    ) = 0;
end;
$$;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
alter table public.producers    enable row level security;
alter table public.events       enable row level security;
alter table public.ticket_types enable row level security;
alter table public.orders       enable row level security;
alter table public.attendees    enable row level security;
alter table public.payouts      enable row level security;

-- PRODUCERS: el productor solo ve y edita su propio perfil
create policy "producers_select_own"
  on public.producers for select
  using (auth.uid() = id);

create policy "producers_insert_own"
  on public.producers for insert
  with check (auth.uid() = id);

create policy "producers_update_own"
  on public.producers for update
  using (auth.uid() = id);

-- EVENTS: el productor solo ve y gestiona sus eventos
create policy "events_select_own"
  on public.events for select
  using (producer_id = auth.uid());

create policy "events_insert_own"
  on public.events for insert
  with check (producer_id = auth.uid());

create policy "events_update_own"
  on public.events for update
  using (producer_id = auth.uid());

create policy "events_delete_own"
  on public.events for delete
  using (producer_id = auth.uid() and status = 'draft');

-- TICKET TYPES: acceso a través del evento
create policy "ticket_types_producer_access"
  on public.ticket_types for all
  using (
    exists (
      select 1 from public.events e
      where e.id = ticket_types.event_id
        and e.producer_id = auth.uid()
    )
  );

-- ORDERS: el productor ve las órdenes de sus eventos
create policy "orders_producer_select"
  on public.orders for select
  using (
    exists (
      select 1 from public.events e
      where e.id = orders.event_id
        and e.producer_id = auth.uid()
    )
  );

-- ATTENDEES: el productor ve y puede validar sus asistentes
create policy "attendees_producer_select"
  on public.attendees for select
  using (
    exists (
      select 1 from public.events e
      where e.id = attendees.event_id
        and e.producer_id = auth.uid()
    )
  );

create policy "attendees_producer_update"
  on public.attendees for update
  using (
    exists (
      select 1 from public.events e
      where e.id = attendees.event_id
        and e.producer_id = auth.uid()
    )
  );

-- PAYOUTS: el productor ve sus propios pagos
create policy "payouts_producer_select"
  on public.payouts for select
  using (producer_id = auth.uid());

-- ============================================================
-- FUNCIÓN: auto-crear perfil de productor al registrarse
-- Se ejecuta en auth.users via trigger de Supabase Auth
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.producers (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- VISTAS útiles para el dashboard
-- ============================================================

-- Vista: resumen de eventos con conteos
create or replace view public.v_events_summary as
select
  e.*,
  p.name as producer_name,
  coalesce(tt_stats.total_capacity, 0) as total_capacity,
  coalesce(tt_stats.total_sold, 0) as total_sold,
  coalesce(tt_stats.total_revenue, 0) as total_revenue,
  coalesce(tt_stats.producer_revenue, 0) as producer_revenue
from public.events e
join public.producers p on p.id = e.producer_id
left join lateral (
  select
    sum(tt.quantity) as total_capacity,
    sum(tt.sold) as total_sold,
    sum(tt.sold * tt.price) as total_revenue,
    sum(tt.sold * tt.price * (1 - e.commission_pct / 100)) as producer_revenue
  from public.ticket_types tt
  where tt.event_id = e.id
) tt_stats on true;

-- Vista: analíticas del dashboard del productor
create or replace view public.v_producer_analytics as
select
  e.producer_id,
  count(distinct e.id) filter (where e.status = 'published') as eventos_activos,
  count(distinct e.id) filter (where e.status = 'finished') as eventos_terminados,
  coalesce(sum(o.subtotal) filter (where o.payment_status = 'paid'), 0) as total_recaudado,
  coalesce(sum(o.producer_amount) filter (where o.payment_status = 'paid'), 0) as total_productor,
  coalesce(sum(o.quantity) filter (where o.payment_status = 'paid'), 0) as total_entradas_vendidas,
  count(distinct o.buyer_email) filter (where o.payment_status = 'paid') as compradores_unicos
from public.events e
left join public.orders o on o.event_id = e.id
group by e.producer_id;

-- ============================================================
-- DATOS SEMILLA para desarrollo/demo
-- (Comentar en producción)
-- ============================================================
-- Los datos de prueba se insertan via backend/seed.ts
