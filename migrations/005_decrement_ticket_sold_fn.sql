CREATE OR REPLACE FUNCTION public.decrement_ticket_sold(
  p_ticket_type_id uuid,
  p_quantity       integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.ticket_types
  SET sold = GREATEST(sold - p_quantity, 0)  -- GREATEST evita que sold quede negativo
  WHERE id = p_ticket_type_id;
END;
$$;