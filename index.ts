// =====================================================================
//  SCINTILLA — Edge Function: reminders-notify
//  Invia una notifica push quando un promemoria con data scade
//  (o è scaduto e ancora aperto). Da lanciare una volta al giorno via cron.
//
//  Deploy:  supabase functions deploy reminders-notify --no-verify-jwt
//  Secret richiesti (gli STESSI del tuo send-push — verifica i nomi):
//     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (es. mailto:tu@dominio.it)
//  SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già iniettati da Supabase.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:notifiche@scintilla.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const eur = (c: number | null) =>
  c == null ? "" : (c / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: 0 });

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const today = new Date().toISOString().slice(0, 10);

  // promemoria aperti con scadenza <= oggi, non ancora notificati oggi
  const { data: due, error } = await sb
    .from("reminders")
    .select("id,title,amount_cents,owner_user_id,due_date")
    .eq("status", "aperto")
    .not("due_date", "is", null)
    .lte("due_date", today)
    .or(`notified_on.is.null,notified_on.lt.${today}`);

  if (error) return new Response("query error: " + error.message, { status: 500 });
  if (!due || !due.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { "content-type": "application/json" } });

  // raggruppa per utente
  const byUser = new Map<string, typeof due>();
  for (const r of due) {
    const arr = byUser.get(r.owner_user_id) ?? [];
    arr.push(r);
    byUser.set(r.owner_user_id, arr);
  }

  let sent = 0;
  const notifiedIds: string[] = [];

  for (const [uid, items] of byUser) {
    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("endpoint,subscription")
      .eq("user_id", uid);
    if (!subs || !subs.length) continue;

    const first = items[0];
    const extra = items.length - 1;
    const body =
      items.length === 1
        ? `${first.title}${first.amount_cents != null ? " · " + eur(first.amount_cents) : ""}`
        : `${first.title}${extra > 0 ? ` e altri ${extra}` : ""}`;
    const payload = JSON.stringify({
      title: items.length === 1 ? "Promemoria in scadenza" : `${items.length} promemoria in scadenza`,
      body,
      tag: "scintilla-reminder",
    });

    for (const s of subs) {
      try {
        await webpush.sendNotification(s.subscription as any, payload);
        sent++;
      } catch (e) {
        const code = (e as any)?.statusCode;
        if (code === 404 || code === 410) {
          await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }
    for (const r of items) notifiedIds.push(r.id);
  }

  if (notifiedIds.length) {
    await sb.from("reminders").update({ notified_on: today }).in("id", notifiedIds);
  }
  return new Response(JSON.stringify({ sent, reminders: notifiedIds.length }), {
    headers: { "content-type": "application/json" },
  });
});
