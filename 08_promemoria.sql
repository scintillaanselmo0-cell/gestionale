-- =====================================================================
--  SCINTILLA — Modulo PROMEMORIA
--  Impegni con storico, scadenze, canone annuale ricorrente, report.
--  Esegui tutto nel SQL Editor di Supabase (progetto qorswaabqqcxpsmngbpo).
--  È additivo: non tocca nulla di esistente.
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  TABELLE
-- ---------------------------------------------------------------------
create table if not exists public.reminders (
  id               uuid primary key default gen_random_uuid(),
  owner_user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id        uuid references public.clients(id) on delete cascade,        -- tenant del titolare (null per il super admin)
  target_client_id uuid references public.clients(id) on delete set null,       -- cliente a cui si riferisce (canoni, attivazioni)
  title            text not null,
  notes            text,
  amount_cents     integer,                                                     -- la cifra (facoltativa)
  kind             text not null default 'generico' check (kind in ('generico','attivazione','annuale')),
  due_date         date,                                                        -- scadenza / data rinnovo (facoltativa)
  recurrence       text not null default 'none'     check (recurrence in ('none','annual')),
  status           text not null default 'aperto'   check (status in ('aperto','fatto','annullato')),
  sort_order       integer not null default 0,
  notified_on      date,                                                        -- ultima data in cui è partita la notifica (anti-doppione)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- storico dei completamenti (serve al report: ogni "fatto" lascia una riga con la cifra)
create table if not exists public.reminder_events (
  id               uuid primary key default gen_random_uuid(),
  reminder_id      uuid references public.reminders(id) on delete set null,
  owner_user_id    uuid not null default auth.uid(),
  target_client_id uuid references public.clients(id) on delete set null,
  title            text,
  kind             text,
  amount_cents     integer,
  event_type       text not null default 'fatto',
  event_date       date not null default current_date,
  created_at       timestamptz not null default now()
);

create index if not exists reminders_owner_idx  on public.reminders(owner_user_id);
create index if not exists reminders_client_idx on public.reminders(client_id);
create index if not exists reminders_due_idx    on public.reminders(due_date) where status='aperto';
create index if not exists rem_events_owner_idx on public.reminder_events(owner_user_id, event_date);

-- ---------------------------------------------------------------------
--  HELPER: client_id del titolare loggato
-- ---------------------------------------------------------------------
create or replace function public.my_client_id() returns uuid
language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where user_id = auth.uid()
$$;
grant execute on function public.my_client_id() to authenticated;

-- ---------------------------------------------------------------------
--  RLS: ognuno vede SOLO i propri promemoria
--   - super admin: i suoi (owner_user_id = auth.uid(), client_id null)
--   - titolare: quelli del suo tenant (client_id = suo) o creati da lui
-- ---------------------------------------------------------------------
alter table public.reminders       enable row level security;
alter table public.reminder_events enable row level security;

drop policy if exists reminders_all on public.reminders;
create policy reminders_all on public.reminders for all to authenticated
  using      ( owner_user_id = auth.uid()
               or (client_id is not null and client_id = public.my_client_id()) )
  with check ( owner_user_id = auth.uid()
               or (client_id is not null and client_id = public.my_client_id()) );

drop policy if exists rem_events_all on public.reminder_events;
create policy rem_events_all on public.reminder_events for all to authenticated
  using      ( owner_user_id = auth.uid() )
  with check ( owner_user_id = auth.uid() );

-- ---------------------------------------------------------------------
--  RPC: segna come fatto (registra lo storico e, se annuale, rinnova +1 anno)
-- ---------------------------------------------------------------------
create or replace function public.reminder_mark_done(p_id uuid)
returns public.reminders
language plpgsql security definer set search_path = public as $$
declare r public.reminders;
begin
  select * into r from public.reminders where id = p_id;
  if not found then raise exception 'Promemoria inesistente'; end if;
  if not ( r.owner_user_id = auth.uid()
           or (r.client_id is not null and r.client_id = public.my_client_id()) )
  then raise exception 'Non autorizzato'; end if;

  insert into public.reminder_events(reminder_id, owner_user_id, target_client_id, title, kind, amount_cents, event_type, event_date)
  values (r.id, r.owner_user_id, r.target_client_id, r.title, r.kind, r.amount_cents, 'fatto', current_date);

  if r.recurrence = 'annual' and r.due_date is not null then
    update public.reminders
       set due_date = (r.due_date + interval '1 year')::date,
           status = 'aperto', notified_on = null, updated_at = now()
     where id = r.id returning * into r;
  else
    update public.reminders
       set status = 'fatto', updated_at = now()
     where id = r.id returning * into r;
  end if;
  return r;
end $$;
grant execute on function public.reminder_mark_done(uuid) to authenticated;

-- ---------------------------------------------------------------------
--  Attiva il modulo "promemoria" per tutti i clienti esistenti
--  (i nuovi clienti: aggiungi 'promemoria' tra i moduli in fase di onboarding)
-- ---------------------------------------------------------------------
insert into public.client_modules(client_id, module_key, enabled)
select c.id, 'promemoria', true
from public.clients c
where not exists (
  select 1 from public.client_modules m
  where m.client_id = c.id and m.module_key = 'promemoria'
);
