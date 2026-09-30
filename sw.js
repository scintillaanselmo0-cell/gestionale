/* Scintilla — Service Worker (PWA + Web Push) */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { title: "Scintilla", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Nuova prenotazione";
  const options = {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [90, 40, 90],
    tag: data.tag || "scintilla-booking",
    renotify: true,
    data: data
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// estrae l'id della prenotazione dal payload, comunque il server lo chiami
function pickBookingId(d) {
  if (!d) return null;
  return d.booking_id || d.bookingId || d.id ||
    (d.booking && d.booking.id) ||
    (d.data && (d.data.booking_id || d.data.bookingId || d.data.id)) || null;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const bid = pickBookingId(d);
  const url = bid ? ("./?b=" + encodeURIComponent(bid)) : "./";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) {
        await c.focus();
        // app già aperta: le passo l'id così apre subito il dettaglio
        if (bid) c.postMessage({ type: "open-booking", id: bid });
        return;
      }
    }
    // app chiusa: la apro puntando direttamente alla prenotazione
    return self.clients.openWindow(url);
  })());
});
