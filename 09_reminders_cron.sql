-- =====================================================================
--  SCINTILLA — Pianificazione notifiche Promemoria (una volta al giorno)
--  Richiede le extension pg_cron e pg_net (disponibili su Supabase).
--  Esegui DOPO aver fatto il deploy della funzione reminders-notify.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Metti qui la tua SERVICE ROLE KEY (Project Settings -> API).
-- In alternativa usala dal Vault; qui la versione diretta, semplice.
-- Ref progetto: qorswaabqqcxpsmngbpo
--
-- Ogni giorno alle 08:00 (UTC). Cambia l'orario se vuoi: '0 8 * * *' = min ora ...
select cron.schedule(
  'scintilla-reminders-notify',
  '0 8 * * *',
  $$
  select net.http_post(
    url     := 'https://qorswaabqqcxpsmngbpo.supabase.co/functions/v1/reminders-notify',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer INCOLLA_LA_TUA_SERVICE_ROLE_KEY'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Per vedere i job:      select * from cron.job;
-- Per rimuovere il job:  select cron.unschedule('scintilla-reminders-notify');
