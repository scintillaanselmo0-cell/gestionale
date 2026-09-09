/* =====================================================================
   CONFIG — sostituisci con i valori del tuo progetto Supabase
   (Project Settings -> API). La anon key è pubblica: va bene qui.
   ===================================================================== */
const SUPABASE_URL      = "https://qorswaabqqcxpsmngbpo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_xoKJtS9w_kv_dddgGl8Ycg_BC2UM0w6";
// Chiave PUBBLICA VAPID (generata con vapid-gen.html) — è pubblica, va bene qui.
const VAPID_PUBLIC_KEY  = "INCOLLA_LA_TUA_VAPID_PUBLIC_KEY";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---- stato ---- */
let ME = null;            // { role, client_id }
let CLIENT = null;        // riga clients dell'utente (per owner)
let FILTER = { when:"all", date:"", status:"" };
let ADMIN_CLIENT = null;   // se valorizzato, il super admin sta gestendo le prenotazioni di questo cliente
let SELECT_MODE = false;   // modalità selezione multipla attiva
const SELECTED = new Set();
let AUDIO = null;          // AudioContext per il beep
let RT_CHANNEL = null;     // canale Supabase Realtime
let BTYPES = [];           // tipi di prenotazione del cliente (per l'aggiunta manuale)
let LAST_BOOKINGS = [];    // ultime prenotazioni caricate (per i link WhatsApp)
const DEFAULT_CONFIRM = "Ciao {nome}! La tua prenotazione da {attivita} è confermata per {data} alle {ora} ({persone} persone). Ti aspettiamo!";
let NEW_COUNT = 0;         // nuove prenotazioni non ancora viste

/* ---- utility ---- */
const $ = s => document.querySelector(s);
const esc = s => (s??"").toString().replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const STATUS_LABEL = { in_attesa:"In attesa", confermata:"Confermata", annullata:"Annullata" };
function toast(t){ const el=$("#toast"); el.textContent=t; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2200); }
function ymd(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function isoToday(off=0){ const d=new Date(); d.setDate(d.getDate()+off); return ymd(d); }
function fmtDay(iso){
  const d=new Date(iso+"T00:00:00");
  const s=d.toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long"});
  return s.charAt(0).toUpperCase()+s.slice(1);
}
function fmtDate(iso){ return new Date(iso+"T00:00:00").toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit",year:"numeric"}); }
function euro(c){ return (c==null)?"":(c/100).toLocaleString("it-IT",{style:"currency",currency:"EUR",minimumFractionDigits:0}); }
function waLink(phone){ return "https://wa.me/"+(phone||"").replace(/\D/g,""); }
function logoUrl(path){ return path ? sb.storage.from("logos").getPublicUrl(path).data.publicUrl : null; }

/* ---- conferma WhatsApp precompilata ---- */
function waDigits(phone){ return (phone||"").replace(/\D/g,""); }
function firstName(name){ return (name||"").trim().split(/\s+/)[0] || ""; }
function fmtLongDate(iso){
  try{ return new Date(iso+"T00:00:00").toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long"}); }
  catch(_){ return iso; }
}
function whenText(b){
  const t = b.booking_time ? " alle "+b.booking_time.slice(0,5) : "";
  return fmtLongDate(b.booking_date)+t;
}
function bookingById(id){ return LAST_BOOKINGS.find(b=>b.id===id) || null; }
function confirmMessage(b){
  const tpl = (CLIENT && CLIENT.confirm_message_template) ? CLIENT.confirm_message_template : DEFAULT_CONFIRM;
  return tpl
    .split("{nome}").join(firstName(b.customer_name))
    .split("{data}").join(fmtLongDate(b.booking_date))
    .split("{ora}").join(b.booking_time ? b.booking_time.slice(0,5) : "")
    .split("{persone}").join(b.party_size)
    .split("{attivita}").join(CLIENT ? CLIENT.name : "");
}
function waConfirmLink(b){
  const d = waDigits(b.customer_phone);
  if(!d) return null;
  return "https://wa.me/"+d+"?text="+encodeURIComponent(confirmMessage(b));
}

/* ---- coda guidata invio conferme (Conferma tutte) ---- */
function openWaQueue(items){
  if(!items.length) return;
  const total=items.length; let sent=0;
  const back=document.createElement("div");
  back.className="modal-back"; back.id="waQueueBack";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Invia conferme WhatsApp</h3>
        <button class="modal-x" id="waqClose">Chiudi</button>
      </div>
      <div class="modal-body">
        <div id="waqCount" style="font-weight:700; color:var(--muted); margin-bottom:6px">0 di ${total} inviati</div>
        <p style="margin:0 0 14px; color:var(--muted); font-size:13px">Tocca ogni cliente in ordine: si apre WhatsApp col messaggio già pronto. Torna qui e passa al successivo.</p>
        <div id="waqList"></div>
      </div>
    </div>`;
  document.body.appendChild(back);
  back.querySelector("#waqList").innerHTML = items.map((it,i)=>`
    <div class="waq-row" data-i="${i}">
      <div class="who"><b>${esc(it.name)}</b><div>${esc(it.whenText)}</div></div>
      <a class="waq-send" href="${it.link}" target="_blank" rel="noopener" data-i="${i}">Invia</a>
    </div>`).join("");
  function close(){ back.remove(); loadBookings(); }
  back.querySelector("#waqClose").addEventListener("click", close);
  back.addEventListener("click", e=>{ if(e.target===back) close(); });
  back.querySelector("#waqList").addEventListener("click", e=>{
    const a=e.target.closest(".waq-send"); if(!a) return;
    const row=a.closest(".waq-row");
    if(row && !row.classList.contains("done")){
      row.classList.add("done"); a.textContent="Inviato ✓";
      sent++; back.querySelector("#waqCount").textContent = sent+" di "+total+" inviati";
    }
    // niente preventDefault: lascia aprire WhatsApp
  });
}

/* =====================================================================
   LOGIN
   ===================================================================== */
$("#loginBtn").addEventListener("click", doLogin);
$("#password").addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); });

async function doLogin(){
  unlockAudio();   // sblocca l'audio alla prima interazione, così il beep non viene bloccato
  const email=$("#email").value.trim(), password=$("#password").value;
  const msg=$("#loginMsg"); msg.className="msg";
  if(!email||!password){ msg.className="msg err"; msg.textContent="Inserisci email e password."; return; }
  $("#loginBtn").disabled=true; $("#loginBtn").textContent="Accesso…";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $("#loginBtn").disabled=false; $("#loginBtn").textContent="Accedi";
  if(error){ msg.className="msg err"; msg.textContent="Email o password non corretti."; return; }
  await boot();
}

$("#logoutBtn").addEventListener("click", async ()=>{ await sb.auth.signOut(); location.reload(); });

/* =====================================================================
   BOOT — carica profilo, controlla stato attività, mostra l'app
   ===================================================================== */
async function boot(){
  const { data:{ user } } = await sb.auth.getUser();
  if(!user){ showLogin(); return; }

  const { data:prof, error:pe } = await sb.from("profiles").select("role,client_id").eq("user_id",user.id).single();
  if(pe || !prof){ await sb.auth.signOut(); showLogin("Account non collegato a nessuna attività."); return; }
  ME = prof;

  if(ME.role === "owner"){
    const { data:cli } = await sb.from("clients").select("*").eq("id",ME.client_id).single();
    if(!cli){ await sb.auth.signOut(); showLogin("Attività non trovata."); return; }
    if(cli.status === "sospeso"){ await sb.auth.signOut(); showLogin("Il tuo account è sospeso. Contatta l'assistenza."); return; }
    CLIENT = cli;
  }

  renderClientTag();
  if(ME.role==="super_admin"){
    document.querySelectorAll('.tab[data-tab="bookings"], .tab[data-tab="history"], .tab[data-tab="customers"], .tab[data-tab="services"], .tab[data-tab="reports"], .tab[data-tab="vouchers"], .tab[data-tab="settings"]').forEach(t=>t.classList.add("hide"));
    $("#adminTabBtn").classList.remove("hide");
    $("#loginView").classList.add("hide");
    $("#appView").classList.remove("hide");
    switchTab("admin");
    return;
  }

  // --- TITOLARE: tab dinamiche dai moduli attivi ---
  const { data:mods } = await sb.from("client_modules").select("module_key,enabled").eq("client_id",CLIENT.id);
  let enabled = (mods||[]).filter(m=>m.enabled).map(m=>m.module_key);
  if(!enabled.length) enabled = ["prenotazioni","storico","clienti","report","impostazioni"];   // default sensato
  let firstTab = null;
  document.querySelectorAll('.tab[data-mod]').forEach(t=>{
    const on = enabled.includes(t.dataset.mod);
    t.classList.toggle("hide", !on);
    if(on && !firstTab) firstTab = t.dataset.tab;
  });

  // tipi di prenotazione (per l'aggiunta manuale)
  const { data:bts } = await sb.from("booking_types").select("key,label").eq("client_id",CLIENT.id).eq("active",true).order("sort_order");
  BTYPES = bts||[];
  $("#addBookingBtn").classList.toggle("hide", !enabled.includes("prenotazioni"));

  startRealtime();

  $("#loginView").classList.add("hide");
  $("#appView").classList.remove("hide");
  switchTab(firstTab || "bookings");
}

function showLogin(err){
  $("#appView").classList.add("hide");
  $("#loginView").classList.remove("hide");
  if(err){ const m=$("#loginMsg"); m.className="msg err"; m.textContent=err; }
}

function renderClientTag(){
  const tag=$("#clientTag");
  if(ME.role==="super_admin"){ tag.innerHTML='<span class="name" style="color:var(--muted)">Super admin</span>'; return; }
  const url=logoUrl(CLIENT.logo_path);
  tag.innerHTML = url ? `<img src="${url}" alt="${esc(CLIENT.name)}" />`
                      : `<span class="name">${esc(CLIENT.name)}</span>`;
}

/* =====================================================================
   TABS
   ===================================================================== */
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>switchTab(t.dataset.tab)));
function switchTab(name){
  if(SELECT_MODE) exitSelect();
  if(name==="bookings") clearNewBadge();
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("on",t.dataset.tab===name));
  ["bookings","history","customers","services","reports","vouchers","settings","admin"].forEach(n=>$("#tab-"+n).classList.toggle("hide",n!==name));
  if(name==="bookings"){ loadBookings(); agApplyView(); }
  if(name==="history")  loadHistory();
  if(name==="customers") loadCustomers();
  if(name==="services") loadServices();
  if(name==="reports")  loadReports();
  if(name==="vouchers") loadVouchers();
  if(name==="settings") loadSettings();
  if(name==="admin")    loadAdmin();
}

/* =====================================================================
   PRENOTAZIONI
   ===================================================================== */
document.querySelectorAll(".chip[data-when]").forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll(".chip[data-when]").forEach(x=>x.classList.remove("on"));
  c.classList.add("on"); FILTER.when=c.dataset.when; $("#dateFilter").value=""; loadBookings();
}));
$("#dateFilter").addEventListener("change",e=>{
  FILTER.date=e.target.value; FILTER.when="date";
  document.querySelectorAll(".chip[data-when]").forEach(x=>x.classList.remove("on"));
  loadBookings();
});
$("#statusFilter").addEventListener("change",e=>{ FILTER.status=e.target.value; loadBookings(); });

async function loadBookings(){
  SELECTED.clear();
  const list=$("#bookingsList"); list.innerHTML='<div class="loading">Carico…</div>';
  let q = sb.from("bookings")
    .select("id,customer_name,customer_phone,booking_date,booking_time,party_size,status,notes,booking_types(label,key),services(name,duration_min,price_cents)")
    .order("booking_date",{ascending:true}).order("booking_time",{ascending:true,nullsFirst:true});

  if(ADMIN_CLIENT) q=q.eq("client_id", ADMIN_CLIENT.id);
  if(FILTER.when==="today")    q=q.eq("booking_date",isoToday(0));
  else if(FILTER.when==="tomorrow") q=q.eq("booking_date",isoToday(1));
  else if(FILTER.when==="date" && FILTER.date) q=q.eq("booking_date",FILTER.date);
  if(FILTER.status) q=q.eq("status",FILTER.status);

  const { data, error } = await q;
  if(error){ list.innerHTML=`<div class="empty">Errore nel caricamento.</div>`; return; }
  LAST_BOOKINGS = data;
  if(!data.length){ list.innerHTML=`<div class="empty"><div class="big">◆</div>Nessuna prenotazione con questi filtri.</div>`; return; }

  const groups={};
  data.forEach(b=>{ (groups[b.booking_date] ||= []).push(b); });
  list.innerHTML = Object.keys(groups).sort().map(day=>`
    <div class="daygroup">
      <div class="dayhead">${esc(fmtDay(day))}</div>
      ${groups[day].map(bookingCard).join("")}
    </div>`).join("");
}

function bookingCard(b){
  const time = b.booking_time ? b.booking_time.slice(0,5) : '<span class="notime">Orario libero</span>';
  const type = b.booking_types ? b.booking_types.label : "";
  const svc = b.services || null;   // presente per gli appuntamenti (saloni)
  const acts = [];
  if(b.status!=="confermata") acts.push(`<button class="act confirm" data-act="confermata" data-id="${b.id}">Conferma</button>`);
  if(b.status!=="annullata")  acts.push(`<button class="act cancel"  data-act="annullata"  data-id="${b.id}">Annulla</button>`);
  if(b.status==="annullata")  acts.push(`<button class="act reopen"  data-act="in_attesa"  data-id="${b.id}">Riapri</button>`);
  if(waDigits(b.customer_phone)) acts.push(`<a class="act wa" href="${waLink(b.customer_phone)}" target="_blank" rel="noopener" title="WhatsApp">WhatsApp</a>`);
  acts.push(`<button class="act del" data-del="${b.id}" title="Elimina definitivamente">Elimina</button>`);
  return `
  <div class="bk" data-id="${b.id}">
    <div class="bk-top">
      <div style="display:flex; align-items:flex-start; gap:12px">
        <span class="pick" aria-hidden="true"></span>
        <div>
          <div class="bk-time">${time}</div>
          ${ waDigits(b.customer_phone)
            ? `<div class="bk-name bk-name-link" data-custdetail="1" data-phone="${esc(b.customer_phone)}" data-name="${esc(b.customer_name)}" title="Vedi storico cliente">${esc(b.customer_name)}</div>`
            : `<div class="bk-name">${esc(b.customer_name)}</div>` }
        </div>
      </div>
      <span class="status ${b.status}">${STATUS_LABEL[b.status]}</span>
    </div>
    <div class="bk-meta">
      ${ svc
         ? `<span><b>${esc(svc.name)}</b>${svc.duration_min?` · ${svc.duration_min} min`:""}</span>`
         : `<span><b>${b.party_size}</b> ${b.party_size==1?"persona":"persone"}</span>${type?`<span>${esc(type)}</span>`:""}` }
      <a href="tel:${esc(b.customer_phone)}" style="color:inherit"><b>${esc(b.customer_phone)}</b></a>
      ${b.notes?`<span style="flex-basis:100%">✎ ${esc(b.notes)}</span>`:""}
    </div>
    <div class="actions">${acts.join("")}</div>
  </div>`;
}

$("#bookingsList").addEventListener("click", async e=>{
  if(SELECT_MODE){
    const card=e.target.closest(".bk"); if(!card) return;
    const id=card.dataset.id;
    if(SELECTED.has(id)){ SELECTED.delete(id); card.classList.remove("picked"); }
    else { SELECTED.add(id); card.classList.add("picked"); }
    updateBulkBar(); return;
  }
  // clic sul nome -> storico/dettaglio cliente (riusa la stessa vista della tab Storico)
  const nameEl = e.target.closest("[data-custdetail]");
  if(nameEl){ loadCustomerDetail(nameEl.dataset.phone, nameEl.dataset.name); return; }
  // tap sul link "Invia conferma WhatsApp" (conferma singola) -> lascia aprire WhatsApp, poi ricarica
  const waC = e.target.closest("[data-waconfirm]");
  if(waC){ setTimeout(loadBookings, 1200); return; }
  const doneBtn = e.target.closest("[data-done]");
  if(doneBtn){ loadBookings(); return; }

  const del=e.target.closest("[data-del]");
  if(del){
    if(!confirm("Eliminare definitivamente questa prenotazione?\nL'azione non è reversibile.")) return;
    del.disabled=true;
    const { error } = await sb.from("bookings").delete().eq("id", del.dataset.del);
    if(error){ toast("Errore, riprova"); del.disabled=false; return; }
    toast("Prenotazione eliminata"); loadBookings(); return;
  }
  const btn=e.target.closest("[data-act]"); if(!btn) return;
  btn.disabled=true;
  const { error } = await sb.from("bookings").update({status:btn.dataset.act}).eq("id",btn.dataset.id);
  if(error){ toast("Errore, riprova"); btn.disabled=false; return; }

  // CONFERMA singola: proponi l'invio WhatsApp precompilato (si apre sul tap dell'utente)
  if(btn.dataset.act==="confermata"){
    const b = bookingById(btn.dataset.id);
    const link = b ? waConfirmLink(b) : null;
    const card = btn.closest(".bk");
    const actions = card ? card.querySelector(".actions") : null;
    if(link && actions){
      toast("Confermata");
      actions.innerHTML =
        `<a class="act confirm" href="${link}" target="_blank" rel="noopener" data-waconfirm="1" style="text-decoration:none">Invia conferma WhatsApp</a>`+
        `<button class="act" data-done="1">Fatto</button>`;
      return;
    }
    toast("Prenotazione confermata"); loadBookings(); return;
  }

  // Annulla / Riapri: nessun WhatsApp
  toast(btn.dataset.act==="annullata"?"Prenotazione annullata":"Riaperta");
  loadBookings();
});

/* ---- selezione multipla ---- */
$("#selectToggle").addEventListener("click", ()=> SELECT_MODE ? exitSelect() : enterSelect());
$("#bulkAll").addEventListener("click", toggleSelectAll);
$("#bulkExit").addEventListener("click", exitSelect);
$("#bulkConfirm").addEventListener("click", ()=>bulkApply("confermata"));
$("#bulkCancel").addEventListener("click", ()=>bulkApply("annullata"));
$("#bulkDelete").addEventListener("click", ()=>bulkApply("delete"));

function enterSelect(){
  SELECT_MODE=true; SELECTED.clear();
  $("#bookingsList").classList.add("selecting");
  $("#bulkBar").classList.add("show");
  $("#selectToggle").textContent="Fine"; $("#selectToggle").classList.add("on");
  updateBulkBar();
}
function exitSelect(){
  SELECT_MODE=false; SELECTED.clear();
  $("#bookingsList").classList.remove("selecting");
  $("#bulkBar").classList.remove("show");
  $("#selectToggle").textContent="Seleziona"; $("#selectToggle").classList.remove("on");
  $("#bookingsList").querySelectorAll(".bk.picked").forEach(c=>c.classList.remove("picked"));
}
function toggleSelectAll(){
  const cards=[...$("#bookingsList").querySelectorAll(".bk")];
  const allSel = cards.length>0 && SELECTED.size>=cards.length;
  if(allSel){ SELECTED.clear(); cards.forEach(c=>c.classList.remove("picked")); }
  else { cards.forEach(c=>{ SELECTED.add(c.dataset.id); c.classList.add("picked"); }); }
  updateBulkBar();
}
function updateBulkBar(){
  const n=SELECTED.size;
  $("#bulkCount").textContent = n+" "+(n===1?"selezionata":"selezionate");
  ["bulkConfirm","bulkCancel","bulkDelete"].forEach(id=>$("#"+id).disabled = n===0);
  const total=$("#bookingsList").querySelectorAll(".bk").length;
  $("#bulkAll").textContent = (n>0 && n>=total) ? "Deseleziona tutte" : "Seleziona tutte";
}
function setBulkDisabled(v){ ["bulkAll","bulkConfirm","bulkCancel","bulkDelete","bulkExit"].forEach(id=>$("#"+id).disabled=v); }

async function bulkApply(action){
  const ids=[...SELECTED]; if(!ids.length) return;
  if(action==="delete" && !confirm(`Eliminare definitivamente ${ids.length} ${ids.length===1?"prenotazione":"prenotazioni"}?\nL'azione non è reversibile.`)) return;
  // cattura i dati PRIMA di ricaricare (servono per i messaggi WhatsApp)
  const picked = ids.map(id=>bookingById(id)).filter(Boolean);
  setBulkDisabled(true);
  let error;
  if(action==="delete"){ ({ error } = await sb.from("bookings").delete().in("id", ids)); }
  else { ({ error } = await sb.from("bookings").update({status:action}).in("id", ids)); }
  setBulkDisabled(false);
  if(error){ toast("Errore, riprova"); return; }
  toast(action==="delete"?`${ids.length} eliminate`:action==="confermata"?`${ids.length} confermate`:`${ids.length} annullate`);
  SELECTED.clear();

  // SOLO "Conferma tutte": coda guidata WhatsApp (annulla/elimina non generano nulla)
  if(action==="confermata"){
    const items = picked
      .filter(b=>waDigits(b.customer_phone))
      .map(b=>({ name: firstName(b.customer_name), whenText: whenText(b), link: waConfirmLink(b) }));
    exitSelect();
    if(items.length){ openWaQueue(items); return; }   // la coda ricarica alla chiusura
  }
  await loadBookings();
  updateBulkBar();
}

/* =====================================================================
   STORICO CLIENTE FINALE
   ===================================================================== */
let HIST=[];
$("#histSearch").addEventListener("input",()=>renderHistory($("#histSearch").value.trim().toLowerCase()));

async function loadHistory(){
  const list=$("#historyList"); list.innerHTML='<div class="loading">Carico…</div>';
  const { data, error } = await sb.from("customer_history").select("*").order("last_visit",{ascending:false});
  if(error){ list.innerHTML=`<div class="empty">Errore nel caricamento.</div>`; return; }
  HIST=data||[]; renderHistory("");
}
function renderHistory(term){
  const list=$("#historyList");
  const rows = term ? HIST.filter(h => (h.name||"").toLowerCase().includes(term) || (h.customer_phone||"").includes(term)) : HIST;
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="big">◆</div>${HIST.length?"Nessun risultato.":"Ancora nessun cliente con visite confermate."}</div>`; return; }
  list.innerHTML = rows.map(h=>`
    <div class="hist" data-phone="${esc(h.customer_phone)}" data-name="${esc(h.name)}" style="cursor:pointer">
      <div class="who">
        <b>${esc(h.name)}</b>
        <div>${esc(h.customer_phone)} · prima ${fmtDate(h.first_visit)} · ultima ${fmtDate(h.last_visit)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:12px">
        <div class="visits"><div class="n">${h.visits}</div><div class="l">${h.visits==1?"visita":"visite"}</div></div>
        <a class="act wa" href="${waLink(h.customer_phone)}" target="_blank" rel="noopener" data-wa="1" title="WhatsApp" style="text-decoration:none">WhatsApp</a>
      </div>
    </div>`).join("");
}

// clic sulla riga -> dettaglio cliente (il tasto WhatsApp resta escluso)
$("#historyList").addEventListener("click", e=>{
  if(e.target.closest("[data-wa]")) return;
  const row=e.target.closest(".hist[data-phone]");
  if(row) loadCustomerDetail(row.dataset.phone, row.dataset.name);
});

async function loadCustomerDetail(phone, name){
  if(!phone || !waDigits(phone)){ toast("Nessuno storico disponibile"); return; }
  const back=document.createElement("div");
  back.className="modal-back"; back.id="custDetailBack";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3 style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(name)}</h3>
        <button class="modal-x" id="cdClose">Chiudi</button>
      </div>
      <div class="modal-body" id="cdBody"><div class="loading">Carico…</div></div>
    </div>`;
  document.body.appendChild(back);
  const close=()=>back.remove();
  back.querySelector("#cdClose").addEventListener("click", close);
  back.addEventListener("click", e=>{ if(e.target===back) close(); });

  // scoping: super admin filtra sul cliente in vista; il titolare è già limitato dalla RLS,
  // ma filtriamo comunque per client_id per sicurezza. Mai clienti finali di altre attività.
  const scopeId = ADMIN_CLIENT ? ADMIN_CLIENT.id : (CLIENT ? CLIENT.id : null);
  let q = sb.from("bookings")
    .select("booking_date,booking_time,party_size,notes,booking_types(label)")
    .eq("customer_phone", phone).eq("status","confermata")
    .order("booking_date",{ascending:false}).order("booking_time",{ascending:false,nullsFirst:false});
  if(scopeId) q=q.eq("client_id", scopeId);
  const { data, error } = await q;

  const body=back.querySelector("#cdBody");
  if(error){ body.innerHTML=`<div class="empty">Errore nel caricamento.</div>`; return; }
  const items=(data||[]).map(b=>`
    <div class="bk">
      <div class="bk-top">
        <div>
          <div class="bk-time">${b.booking_time?b.booking_time.slice(0,5):'<span class="notime">Orario libero</span>'}</div>
          <div class="bk-name">${esc(fmtDay(b.booking_date))}</div>
        </div>
        <span class="status confermata">Confermata</span>
      </div>
      <div class="bk-meta">
        <span><b>${b.party_size}</b> ${b.party_size==1?"persona":"persone"}</span>
        ${b.booking_types?`<span>${esc(b.booking_types.label)}</span>`:""}
        ${b.notes?`<span style="flex-basis:100%">✎ ${esc(b.notes)}</span>`:""}
      </div>
    </div>`).join("");
  body.innerHTML = `
    <p style="margin:0 0 14px; color:var(--muted); font-size:14px">
      <a href="${waLink(phone)}" target="_blank" rel="noopener" style="color:var(--muted)">${esc(phone)}</a>
      · ${data.length} ${data.length==1?"visita confermata":"visite confermate"}
    </p>
    ${items || '<div class="empty">Nessuna visita confermata.</div>'}`;
}

/* =====================================================================
   IMPOSTAZIONI (logo + branding)
   ===================================================================== */
function loadSettings(){
  if(ME.role!=="owner"){ $("#tab-settings").innerHTML='<div class="empty">Sezione disponibile per i titolari.</div>'; return; }
  renderPushState();
  const url=logoUrl(CLIENT.logo_path);
  $("#logoPreview").innerHTML = url
    ? `<img src="${url}" alt="logo" /><span style="color:var(--muted);font-size:13px">Logo attuale</span>`
    : `<div class="logo-fallback">${esc(CLIENT.name)}</div><span style="color:var(--muted);font-size:13px">Nessun logo — si mostra il nome</span>`;
  const b=CLIENT.branding||{};
  $("#brandingView").innerHTML = ["primary","secondary","accent"].filter(k=>b[k]).map(k=>
    `<span class="swatch"><i style="background:${esc(b[k])}"></i>${k} ${esc(b[k])}</span>`).join("")
    + (b.font?`<div style="margin-top:10px;color:var(--muted);font-size:13px">Font: <b style="color:var(--ink)">${esc(b.font)}</b></div>`:"");
  // messaggio di conferma
  $("#tplInput").value = CLIENT.confirm_message_template || "";
  renderTplPreview();
}

function renderTplPreview(){
  const tpl = $("#tplInput").value.trim() || DEFAULT_CONFIRM;
  const sample = { customer_name:"Mario Rossi", booking_date:"2026-09-06", booking_time:"20:00:00", party_size:4 };
  const msg = tpl
    .split("{nome}").join(firstName(sample.customer_name))
    .split("{data}").join(fmtLongDate(sample.booking_date))
    .split("{ora}").join("20:00")
    .split("{persone}").join(sample.party_size)
    .split("{attivita}").join(CLIENT ? CLIENT.name : "");
  $("#tplPreview").innerHTML = `<b>Anteprima:</b> ${esc(msg)}`;
}
$("#tplInput").addEventListener("input", renderTplPreview);
$("#tplReset").addEventListener("click", ()=>{ $("#tplInput").value=""; renderTplPreview(); });
$("#tplSave").addEventListener("click", async ()=>{
  const val = $("#tplInput").value.trim();
  $("#tplSave").disabled=true;
  const { error } = await sb.from("clients").update({ confirm_message_template: val || null }).eq("id", CLIENT.id);
  $("#tplSave").disabled=false;
  if(error){ toast("Errore nel salvataggio"); return; }
  CLIENT.confirm_message_template = val || null;
  toast("Messaggio salvato");
});

$("#logoInput").addEventListener("change", async e=>{
  const file=e.target.files[0]; if(!file) return;
  const ext=(file.name.split(".").pop()||"png").toLowerCase();
  const path=`${CLIENT.id}/logo.${ext}`;
  toast("Carico il logo…");
  const { error:upErr } = await sb.storage.from("logos").upload(path,file,{upsert:true,cacheControl:"3600"});
  if(upErr){ toast("Errore upload: "+upErr.message); return; }
  const { error:dbErr } = await sb.from("clients").update({logo_path:path}).eq("id",CLIENT.id);
  if(dbErr){ toast("Errore salvataggio"); return; }
  CLIENT.logo_path=path;
  renderClientTag(); loadSettings(); toast("Logo aggiornato");
});

/* =====================================================================
   SUPER ADMIN — stato attività (gancio manuale, poi Stripe)
   ===================================================================== */
let CATEGORIES = [];       // elenco categorie
let CLIENT_CATS = {};      // client_id -> [category_id]
let CAT_FILTER = "";       // categoria selezionata nel filtro (id) o ""

async function loadAdmin(){
  const list=$("#adminList"); list.innerHTML='<div class="loading">Carico…</div>';
  const [cats, links, clients] = await Promise.all([
    sb.from("categories").select("id,name").order("sort_order").order("name"),
    sb.from("client_categories").select("client_id,category_id"),
    sb.from("clients").select("id,name,slug,status").order("name")
  ]);
  if(clients.error){ list.innerHTML=`<div class="empty">Errore nel caricamento.</div>`; return; }
  CATEGORIES = cats.data || [];
  CLIENT_CATS = {};
  (links.data||[]).forEach(l=>{ (CLIENT_CATS[l.client_id] ||= []).push(l.category_id); });
  const catName = id => (CATEGORIES.find(c=>c.id===id)||{}).name || "";

  // barra filtro categorie
  $("#catFilter").innerHTML = CATEGORIES.length ? (
    `<button class="chip ${CAT_FILTER===""?"on":""}" data-catf="">Tutte</button>` +
    CATEGORIES.map(c=>`<button class="chip ${CAT_FILTER===c.id?"on":""}" data-catf="${c.id}">${esc(c.name)}</button>`).join("")
  ) : "";

  let rows = clients.data;
  if(CAT_FILTER) rows = rows.filter(c => (CLIENT_CATS[c.id]||[]).includes(CAT_FILTER));

  list.innerHTML = rows.map(c=>{
    const chips = (CLIENT_CATS[c.id]||[]).map(id=>`<span class="cat-chip">${esc(catName(id))}</span>`).join("");
    return `
    <div class="admin-row">
      <div style="min-width:0">
        <div class="a-name">${esc(c.name)}</div>
        <div class="a-slug">${esc(c.slug)}</div>
        ${chips?`<div class="cat-chips">${chips}</div>`:""}
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end">
        <button class="toggle ${c.status}" data-id="${c.id}" data-status="${c.status}">${c.status==="attivo"?"Attivo":"Sospeso"}</button>
        <button class="chip" data-cat="${c.id}" data-name="${esc(c.name)}">Categorie</button>
        <button class="chip" data-viewcust="${c.id}" data-name="${esc(c.name)}">Vedi clienti</button>
        <button class="chip" data-view="${c.id}" data-name="${esc(c.name)}">Vedi prenotazioni →</button>
      </div>
    </div>`;
  }).join("") || `<div class="empty">Nessun cliente in questa categoria.</div>`;
}
$("#adminList").addEventListener("click", async e=>{
  const view=e.target.closest("[data-view]");
  if(view){ openClientBookings(view.dataset.view, view.dataset.name); return; }
  const vcust=e.target.closest("[data-viewcust]");
  if(vcust){ openClientCustomers(vcust.dataset.viewcust, vcust.dataset.name); return; }
  const cat=e.target.closest("[data-cat]");
  if(cat){ openAssignCats(cat.dataset.cat, cat.dataset.name); return; }
  const btn=e.target.closest(".toggle"); if(!btn) return;
  const next = btn.dataset.status==="attivo" ? "sospeso" : "attivo";
  btn.disabled=true;
  const { error } = await sb.from("clients").update({status:next}).eq("id",btn.dataset.id);
  btn.disabled=false;
  if(error){ toast("Errore: "+error.message); return; }
  toast(next==="attivo"?"Attività riattivata":"Attività sospesa"); loadAdmin();
});

// filtro per categoria
$("#catFilter").addEventListener("click", e=>{
  const b=e.target.closest("[data-catf]"); if(!b) return;
  CAT_FILTER = b.dataset.catf; loadAdmin();
});

// gestione elenco categorie (crea / elimina)
document.getElementById("manageCatBtn").addEventListener("click", openManageCats);
function openManageCats(){
  const back=document.createElement("div"); back.className="modal-back";
  back.innerHTML=`
    <div class="modal">
      <div class="modal-head"><h3>Categorie di attività</h3><button class="modal-x" id="mcClose">✕</button></div>
      <div class="modal-body">
        <div class="mfield" style="display:flex; gap:8px">
          <input id="mcNew" class="input" placeholder="Nuova categoria (es. Parrucchieri)" />
          <button class="btn" id="mcAdd" style="width:auto; padding:0 18px; white-space:nowrap">Aggiungi</button>
        </div>
        <div id="mcList" style="margin-top:8px"></div>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close=()=>{ back.remove(); loadAdmin(); };
  back.querySelector("#mcClose").addEventListener("click", close);
  back.addEventListener("click", e=>{ if(e.target===back) close(); });
  async function refresh(){
    const { data } = await sb.from("categories").select("id,name").order("sort_order").order("name");
    CATEGORIES = data||[];
    back.querySelector("#mcList").innerHTML = CATEGORIES.length
      ? CATEGORIES.map(c=>`<div class="admin-row"><div class="a-name">${esc(c.name)}</div><button class="chip" data-del="${c.id}" style="border-color:var(--stop-line); color:var(--stop)">Elimina</button></div>`).join("")
      : `<div class="empty" style="padding:20px">Nessuna categoria. Creane una.</div>`;
  }
  back.querySelector("#mcAdd").addEventListener("click", async ()=>{
    const name=back.querySelector("#mcNew").value.trim(); if(!name) return;
    const { error } = await sb.from("categories").insert({ name, sort_order: CATEGORIES.length });
    if(error){ toast("Errore: "+error.message); return; }
    back.querySelector("#mcNew").value=""; refresh();
  });
  back.querySelector("#mcList").addEventListener("click", async e=>{
    const d=e.target.closest("[data-del]"); if(!d) return;
    if(!confirm("Eliminare questa categoria? Verrà tolta da tutti i clienti a cui è assegnata.")) return;
    const { error } = await sb.from("categories").delete().eq("id", d.dataset.del);
    if(error){ toast("Errore: "+error.message); return; }
    refresh();
  });
  refresh();
}

// assegna categorie a un cliente
function openAssignCats(clientId, clientName){
  const current = new Set(CLIENT_CATS[clientId]||[]);
  const back=document.createElement("div"); back.className="modal-back";
  back.innerHTML=`
    <div class="modal">
      <div class="modal-head"><h3>Categorie · ${esc(clientName)}</h3><button class="modal-x" id="acClose">✕</button></div>
      <div class="modal-body">
        ${CATEGORIES.length ? `<div style="display:flex; gap:8px; flex-wrap:wrap" id="acList">
          ${CATEGORIES.map(c=>`<button type="button" class="chip ${current.has(c.id)?"on":""} ac-opt" data-id="${c.id}">${esc(c.name)}</button>`).join("")}
        </div>` : `<div class="empty" style="padding:16px">Nessuna categoria. Creane prima con "Categorie".</div>`}
        <button class="btn" id="acSave" style="margin-top:16px">Salva</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close=()=>back.remove();
  back.querySelector("#acClose").addEventListener("click", close);
  back.addEventListener("click", e=>{ if(e.target===back) close(); });
  back.addEventListener("click", e=>{ const o=e.target.closest(".ac-opt"); if(o) o.classList.toggle("on"); });
  back.querySelector("#acSave").addEventListener("click", async ()=>{
    const chosen = [...back.querySelectorAll(".ac-opt.on")].map(b=>b.dataset.id);
    // riscrive le assegnazioni: cancella e reinserisce
    await sb.from("client_categories").delete().eq("client_id", clientId);
    if(chosen.length){
      const rows = chosen.map(cid=>({ client_id: clientId, category_id: cid }));
      const { error } = await sb.from("client_categories").insert(rows);
      if(error){ toast("Errore: "+error.message); return; }
    }
    close(); toast("Categorie aggiornate"); loadAdmin();
  });
}

/* =====================================================================
   NUOVO CLIENTE (onboarding) — super admin
   ===================================================================== */
function slugify(s){ return (s||"").toString().trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }
const DAYS = [["1","Lun"],["2","Mar"],["3","Mer"],["4","Gio"],["5","Ven"],["6","Sab"],["7","Dom"]];

document.getElementById("newClientBtn").addEventListener("click", openNewClient);

function btRowHtml(){
  return `<div class="bt-row card" style="padding:14px; margin-bottom:10px">
    <div class="mfield"><label>Nome tipo</label><input class="input bt-label" placeholder="Es. Tavolo pranzo" /></div>
    <div class="mfield"><label>Giorni</label><div class="bt-days" style="display:flex; gap:6px; flex-wrap:wrap">
      ${DAYS.map(d=>`<button type="button" class="chip on bt-day" data-day="${d[0]}">${d[1]}</button>`).join("")}
    </div></div>
    <div class="mrow">
      <div class="mfield"><label>Dalle</label><input type="time" class="input bt-from" value="12:00" /></div>
      <div class="mfield"><label>Alle</label><input type="time" class="input bt-to" value="15:00" /></div>
    </div>
    <div class="mrow">
      <div class="mfield"><label>Durata slot (min)</label><input type="number" class="input bt-slot" value="30" /></div>
      <div class="mfield"><label>Max persone</label><input type="number" class="input bt-max" value="20" /></div>
    </div>
    <div class="mfield"><label>Capienza coperti/giorno <span style="color:var(--muted);font-weight:400">(facoltativa)</span></label><input type="number" class="input bt-cap" placeholder="Es. 100" /></div>
    <button type="button" class="chip bt-remove" style="border-color:var(--stop-line); color:var(--stop)">Rimuovi tipo</button>
  </div>`;
}

function openNewClient(){
  const back=document.createElement("div");
  back.className="modal-back"; back.id="ncBack";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Nuovo cliente</h3><button class="modal-x" id="ncClose">✕</button></div>
      <div class="modal-body">
        <div id="ncMsg" class="msg"></div>
        <div class="mfield"><label>Nome attività</label><input id="ncName" class="input" placeholder="Es. Bar Centrale" /></div>
        <div class="mfield"><label>Slug (identificativo per il sito)</label><input id="ncSlug" class="input" placeholder="bar-centrale" /></div>
        <div class="mfield"><label>Telefono WhatsApp</label><input id="ncPhone" class="input" placeholder="+39..." /></div>

        <h3 style="font-size:14px; margin:18px 0 8px">Colori del form</h3>
        <div class="mrow">
          <div class="mfield"><label>Primario</label><input id="ncPrimary" type="color" class="input" value="#006875" style="height:46px; padding:4px" /></div>
          <div class="mfield"><label>Secondario</label><input id="ncSecondary" type="color" class="input" value="#D9D2CA" style="height:46px; padding:4px" /></div>
        </div>
        <div class="mrow">
          <div class="mfield"><label>Accento</label><input id="ncAccent" type="color" class="input" value="#FF6B5A" style="height:46px; padding:4px" /></div>
          <div class="mfield"><label>Font</label><input id="ncFont" class="input" value="Poppins" /></div>
        </div>

        <h3 style="font-size:14px; margin:18px 0 8px">Preset attivita</h3>
        <select id="ncPreset" class="input">
          <option value="parrucchiere">Parrucchiere / Salone - agenda + personale (consigliato)</option>
          <option value="">Personalizzato / Ristorante</option>
        </select>

        <h3 style="font-size:14px; margin:18px 0 8px">Tipi di prenotazione</h3>
        <div id="ncTypes">${btRowHtml()}</div>
        <button type="button" class="chip" id="ncAddType">+ Aggiungi tipo</button>

        <h3 style="font-size:14px; margin:18px 0 8px">Moduli attivi</h3>
        <div style="display:flex; gap:6px; flex-wrap:wrap" id="ncMods">
          ${[["prenotazioni","Prenotazioni",true],["storico","Storico",true],["clienti","Clienti",true],["servizi","Servizi",false],["report","Report",true],["impostazioni","Impostazioni",true],["voucher","Voucher",false]]
            .map(m=>`<button type="button" class="chip ${m[2]?"on ":""}nc-mod" data-mod="${m[0]}">${m[1]}</button>`).join("")}
        </div>

        <h3 style="font-size:14px; margin:18px 0 8px">Accesso del titolare</h3>
        <div class="mfield"><label>Email</label><input id="ncEmail" type="email" class="input" placeholder="titolare@esempio.it" /></div>
        <div class="mfield"><label>Password</label><input id="ncPass" class="input" placeholder="min 8 caratteri" /></div>

        <button class="btn" id="ncSave" style="margin-top:8px">Crea cliente</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close=()=>back.remove();
  back.querySelector("#ncClose").addEventListener("click", close);
  back.addEventListener("click", e=>{ if(e.target===back) close(); });
  // slug auto dal nome
  back.querySelector("#ncName").addEventListener("input", e=>{
    const s=back.querySelector("#ncSlug"); if(!s.dataset.touched) s.value=slugify(e.target.value);
  });
  back.querySelector("#ncSlug").addEventListener("input", e=>{ e.target.dataset.touched="1"; e.target.value=slugify(e.target.value); });
  // toggle giorni / moduli
  back.addEventListener("click", e=>{
    const t=e.target.closest(".bt-day, .nc-mod"); if(t){ t.classList.toggle("on"); }
    if(e.target.closest("#ncAddType")){ back.querySelector("#ncTypes").insertAdjacentHTML("beforeend", btRowHtml()); }
    const rm=e.target.closest(".bt-remove");
    if(rm){ const rows=back.querySelectorAll(".bt-row"); if(rows.length>1) rm.closest(".bt-row").remove(); else toast("Serve almeno un tipo"); }
  });
  back.querySelector("#ncSave").addEventListener("click", ()=>saveNewClient(back, close));
}

async function saveNewClient(back, close){
  const msg=back.querySelector("#ncMsg"); msg.className="msg";
  const fail=t=>{ msg.className="msg err"; msg.textContent=t; back.querySelector(".modal-body").scrollTop=0; };
  const name=back.querySelector("#ncName").value.trim();
  const slug=slugify(back.querySelector("#ncSlug").value);
  const phone=back.querySelector("#ncPhone").value.trim();
  const email=back.querySelector("#ncEmail").value.trim();
  const pass=back.querySelector("#ncPass").value;
  if(!name) return fail("Inserisci il nome attività.");
  if(!slug) return fail("Inserisci lo slug.");
  if(!email) return fail("Inserisci l'email del titolare.");
  if(!pass || pass.length<8) return fail("La password deve avere almeno 8 caratteri.");

  const branding={
    primary: back.querySelector("#ncPrimary").value,
    secondary: back.querySelector("#ncSecondary").value,
    accent: back.querySelector("#ncAccent").value,
    font: back.querySelector("#ncFont").value.trim() || "Inter"
  };
  const modules=[...back.querySelectorAll(".nc-mod.on")].map(b=>b.dataset.mod);

  const booking_types=[];
  for(const row of back.querySelectorAll(".bt-row")){
    const label=row.querySelector(".bt-label").value.trim();
    if(!label) continue;
    const days=[...row.querySelectorAll(".bt-day.on")].map(b=>parseInt(b.dataset.day,10));
    if(!days.length) return fail(`Scegli almeno un giorno per "${label}".`);
    const cap=parseInt(row.querySelector(".bt-cap").value,10);
    const rules={
      weekdays: days,
      time_from: row.querySelector(".bt-from").value || "12:00",
      time_to: row.querySelector(".bt-to").value || "15:00",
      slot_minutes: parseInt(row.querySelector(".bt-slot").value,10)||30,
      min_party: 1,
      max_party: parseInt(row.querySelector(".bt-max").value,10)||20,
      advance_days: 45,
      lead_hours: 1
    };
    if(!isNaN(cap) && cap>0) rules.capacity=cap;
    booking_types.push({ key: slugify(label), label, rules });
  }
  // preset parrucchiere: agenda appuntamenti automatica per ogni nuovo salone
  const ncPreset = back.querySelector("#ncPreset") ? back.querySelector("#ncPreset").value : "";
  if(ncPreset==="parrucchiere"){
    if(!booking_types.some(t=>t.key==="appuntamento")){
      booking_types.unshift({ key:"appuntamento", label:"Appuntamento", rules:{
        weekdays:[1,2,3,4,5,6], time_from:"09:30", time_to:"18:30",
        slot_minutes:15, min_party:1, max_party:1, advance_days:45, lead_hours:1 } });
    }
    if(!modules.includes("servizi")) modules.push("servizi");
  }
  if(!booking_types.length) return fail("Aggiungi almeno un tipo di prenotazione con nome.");

  const btn=back.querySelector("#ncSave"); btn.disabled=true; btn.textContent="Creo…";
  const { data, error } = await sb.functions.invoke("create_tenant", {
    body: { name, slug, phone, branding, booking_types, modules, owner_email: email, owner_password: pass }
  });
  btn.disabled=false; btn.textContent="Crea cliente";

  if(error){ return fail("Errore: "+error.message); }
  if(!data || !data.ok){ return fail(data && data.error ? data.error : "Creazione non riuscita."); }
  close();
  toast("Cliente creato");
  loadAdmin();
}

// Super admin: gestione prenotazioni di un singolo cliente
function openClientBookings(id, name){
  if(SELECT_MODE) exitSelect();
  ADMIN_CLIENT = { id, name };
  FILTER = { when:"all", date:"", status:"" };
  document.querySelectorAll('.chip[data-when]').forEach(x=>x.classList.toggle("on", x.dataset.when==="all"));
  const df=$("#dateFilter"); if(df) df.value="";
  const sf=$("#statusFilter"); if(sf) sf.value="";
  const wrap=$("#tab-bookings");
  let hdr=$("#adminBkHeader");
  if(!hdr){ hdr=document.createElement("div"); hdr.id="adminBkHeader"; wrap.insertBefore(hdr, wrap.firstChild); }
  hdr.innerHTML=`<button class="chip" id="adminBkBack" style="margin-bottom:12px">← Torna ai clienti</button>
                 <h3 style="margin:0 0 14px; font-size:16px">${esc(name)}</h3>`;
  $("#adminBkBack").addEventListener("click", closeClientBookings);
  $("#tab-admin").classList.add("hide");
  $("#tab-bookings").classList.remove("hide");
  loadBookings();
}
function closeClientBookings(){
  if(SELECT_MODE) exitSelect();
  ADMIN_CLIENT = null;
  const hdr=$("#adminBkHeader"); if(hdr) hdr.remove();
  $("#tab-bookings").classList.add("hide");
  $("#tab-admin").classList.remove("hide");
  loadAdmin();
}

// Super admin: anagrafica clienti di un singolo cliente (isolata)
function openClientCustomers(id, name){
  ADMIN_CLIENT = { id, name };
  const wrap=$("#tab-customers");
  let hdr=$("#adminCustHeader");
  if(!hdr){ hdr=document.createElement("div"); hdr.id="adminCustHeader"; wrap.insertBefore(hdr, wrap.firstChild); }
  hdr.innerHTML=`<button class="chip" id="adminCustBack" style="margin-bottom:12px">← Torna ai clienti</button>
                 <h3 style="margin:0 0 14px; font-size:16px">Clienti di ${esc(name)}</h3>`;
  $("#adminCustBack").addEventListener("click", closeClientCustomers);
  $("#custSearch").value="";
  $("#tab-admin").classList.add("hide");
  $("#tab-customers").classList.remove("hide");
  loadCustomers();
}
function closeClientCustomers(){
  ADMIN_CLIENT = null;
  const hdr=$("#adminCustHeader"); if(hdr) hdr.remove();
  $("#tab-customers").classList.add("hide");
  $("#tab-admin").classList.remove("hide");
  loadAdmin();
}

/* =====================================================================
   AUDIO (beep senza file esterni) + REALTIME (notifica dal vivo)
   ===================================================================== */
function unlockAudio(){
  try{
    if(!AUDIO) AUDIO = new (window.AudioContext||window.webkitAudioContext)();
    if(AUDIO.state==="suspended") AUDIO.resume();
  }catch(e){}
}
["click","touchstart","keydown"].forEach(ev=>document.addEventListener(ev, unlockAudio, { once:true }));
function beep(){
  if(!AUDIO) return;
  try{
    const o=AUDIO.createOscillator(), g=AUDIO.createGain();
    o.type="sine"; o.frequency.value=880;
    g.gain.setValueAtTime(0.0001, AUDIO.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, AUDIO.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, AUDIO.currentTime+0.35);
    o.connect(g); g.connect(AUDIO.destination);
    o.start(); o.stop(AUDIO.currentTime+0.36);
  }catch(e){}
}

function startRealtime(){
  if(!CLIENT) return;
  if(RT_CHANNEL){ sb.removeChannel(RT_CHANNEL); RT_CHANNEL=null; }
  RT_CHANNEL = sb.channel("bk-"+CLIENT.id)
    .on("postgres_changes",
      { event:"INSERT", schema:"public", table:"bookings", filter:"client_id=eq."+CLIENT.id },
      payload => onNewBooking(payload.new))
    .subscribe();
}
function onNewBooking(b){
  beep();
  NEW_COUNT++;
  const badge=$("#bkBadge");
  badge.textContent = NEW_COUNT; badge.classList.remove("hide");
  // banner sulla tab prenotazioni
  const banner=$("#newBanner");
  const who = b && b.customer_name ? esc(b.customer_name) : "una nuova prenotazione";
  banner.innerHTML = `🔔 Nuova prenotazione: <b>${who}</b> — tocca per aggiornare`;
  banner.classList.remove("hide");
  // se sei già sulla tab prenotazioni, ricarica al volo
  const onBookings = !$("#tab-bookings").classList.contains("hide");
  if(onBookings && !ADMIN_CLIENT){ loadBookings(); clearNewBadge(); }
}
$("#newBanner").addEventListener("click", ()=>{ loadBookings(); clearNewBadge(); });
function clearNewBadge(){
  NEW_COUNT=0;
  $("#bkBadge").classList.add("hide");
  $("#newBanner").classList.add("hide");
}

/* =====================================================================
   AGGIUNTA MANUALE PRENOTAZIONE (solo titolare)
   ===================================================================== */
$("#addBookingBtn").addEventListener("click", openAddModal);
$("#addClose").addEventListener("click", ()=>$("#addModal").classList.add("hide"));
$("#addModal").addEventListener("click", e=>{ if(e.target.id==="addModal") $("#addModal").classList.add("hide"); });
$("#addSave").addEventListener("click", saveManualBooking);

let ADD_SERVICES=[];   // servizi del cliente per l'aggiunta manuale
async function openAddModal(prefill){
  $("#mType").innerHTML = BTYPES.map(t=>`<option value="${esc(t.key)}">${esc(t.label)}</option>`).join("");
  $("#mDate").value = (prefill&&prefill.date) || isoToday(0);
  $("#mTime").value = (prefill&&prefill.time) || "";
  $("#mParty").value = 1;
  $("#mStatus").value = "confermata";
  $("#mName").value = ""; $("#mPhone").value = ""; $("#mNotes").value = "";
  $("#mSvcInput").value = ""; $("#mServiceKey").value = ""; $("#mSectionShow").value = "";
  $("#mSvcSuggest").classList.add("hide"); $("#mNameSuggest").classList.add("hide");
  $("#addMsg").className = "msg";

  const { data: svcs } = await sb.from("services")
    .select("key,name,price_cents,category").eq("client_id", CLIENT.id).eq("active", true).order("sort_order").order("name");
  ADD_SERVICES = svcs || [];
  const hasServices = ADD_SERVICES.length > 0;
  $("#mSvcBlock").classList.toggle("hide", !hasServices);
  $("#mTypeField").classList.toggle("hide", hasServices);   // col servizio il "Tipo" non serve
  $("#addModal").classList.remove("hide");
}
function shortSvcName(n){ const p=String(n||"").split("·"); return (p.length>1?p.slice(1).join("·"):p[0]).trim(); }

// --- ricerca servizio (suggerimenti) -> sezione automatica ---
$("#mSvcInput")?.addEventListener("input", ()=>{
  const term=$("#mSvcInput").value.trim().toLowerCase();
  $("#mServiceKey").value=""; $("#mSectionShow").value="";
  const box=$("#mSvcSuggest");
  if(!term){ box.classList.add("hide"); return; }
  const rows=ADD_SERVICES.filter(s=>{
    const sn=shortSvcName(s.name).toLowerCase();
    return sn.startsWith(term) || (s.name||"").toLowerCase().includes(term);
  }).slice(0,10);
  if(!rows.length){ box.innerHTML=`<div class="s-item" style="color:var(--muted)">Nessun servizio</div>`; box.classList.remove("hide"); return; }
  box.innerHTML=rows.map(s=>`<div class="s-item" data-key="${esc(s.key)}" data-name="${esc(shortSvcName(s.name))}" data-cat="${esc(s.category||"")}">
      ${esc(shortSvcName(s.name))} <span class="s-sub">· ${esc(s.category||"")}${s.price_cents!=null?" · "+euro(s.price_cents):""}</span></div>`).join("");
  box.classList.remove("hide");
});
$("#mSvcSuggest")?.addEventListener("click", e=>{
  const it=e.target.closest(".s-item[data-key]"); if(!it) return;
  $("#mSvcInput").value=it.dataset.name;
  $("#mServiceKey").value=it.dataset.key;
  $("#mSectionShow").value=it.dataset.cat;
  $("#mSvcSuggest").classList.add("hide");
});

// --- ricerca nome cliente (suggerimenti) -> telefono automatico ---
let nameSuggestT=null;
$("#mName")?.addEventListener("input", ()=>{
  const term=$("#mName").value.trim();
  const box=$("#mNameSuggest");
  clearTimeout(nameSuggestT);
  if(term.length<2){ box.classList.add("hide"); return; }
  nameSuggestT=setTimeout(async()=>{
    const { data } = await sb.from("customers").select("name,phone").ilike("name", term+"%").order("name").limit(8);
    const rows=data||[];
    if(!rows.length){ box.classList.add("hide"); return; }
    box.innerHTML=rows.map(c=>`<div class="s-item" data-name="${esc(c.name||"")}" data-phone="${esc(c.phone||"")}">
        ${esc(c.name||"—")} ${c.phone?`<span class="s-sub">· ${esc(c.phone)}</span>`:""}</div>`).join("");
    box.classList.remove("hide");
  }, 200);
});
$("#mNameSuggest")?.addEventListener("click", e=>{
  const it=e.target.closest(".s-item[data-name]"); if(!it) return;
  $("#mName").value=it.dataset.name;
  if(it.dataset.phone) $("#mPhone").value=it.dataset.phone;
  $("#mNameSuggest").classList.add("hide");
});
// chiudi i suggerimenti cliccando fuori
document.addEventListener("click", e=>{
  if(!e.target.closest("#mSvcInput,#mSvcSuggest")) $("#mSvcSuggest")?.classList.add("hide");
  if(!e.target.closest("#mName,#mNameSuggest")) $("#mNameSuggest")?.classList.add("hide");
});

async function saveManualBooking(){
  const m=$("#addMsg"); m.className="msg";
  const useSvc = !$("#mSvcBlock").classList.contains("hide");
  const date=$("#mDate").value, time=$("#mTime").value;
  const name=$("#mName").value.trim(), phone=$("#mPhone").value.trim();
  const party=parseInt($("#mParty").value,10)||1, status=$("#mStatus").value, notes=$("#mNotes").value.trim();
  let type = $("#mType").value;
  let service_key = null;
  if(useSvc){
    service_key = $("#mServiceKey").value;
    if(!service_key){ m.className="msg err"; m.textContent="Scegli un servizio dall'elenco."; return; }
    const appt = BTYPES.find(t=>t.key==="appuntamento") || BTYPES[0];
    type = appt ? appt.key : type;
  }
  if(!type){ m.className="msg err"; m.textContent="Configurazione tipi mancante."; return; }
  if(!date){ m.className="msg err"; m.textContent="Inserisci la data."; return; }
  if(!name){ m.className="msg err"; m.textContent="Inserisci il nome."; return; }
  // telefono FACOLTATIVO nell'inserimento manuale
  $("#addSave").disabled=true; $("#addSave").textContent="Salvo…";
  const { data, error } = await sb.rpc("create_manual_booking",{
    p_type_key:type, p_name:name, p_phone: phone||null, p_date:date,
    p_time: time||null, p_party:party, p_status:status, p_notes: notes||null,
    p_service_key: service_key
  });
  $("#addSave").disabled=false; $("#addSave").textContent="Salva prenotazione";
  if(error || !data || !data.ok){
    m.className="msg err"; m.textContent = (data&&data.error) ? data.error : "Errore nel salvataggio.";
    return;
  }
  $("#addModal").classList.add("hide");
  toast("Prenotazione aggiunta");
  loadBookings();
  if(typeof AG_VIEW!=="undefined" && AG_VIEW==="agenda") loadAgenda();
}

/* =====================================================================
   PWA + PUSH
   ===================================================================== */
if("serviceWorker" in navigator){
  navigator.serviceWorker.register("sw.js").catch(()=>{});
}
function urlB64ToUint8Array(b64){
  const pad="=".repeat((4-b64.length%4)%4);
  const base=(b64+pad).replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(base); const arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  return arr;
}
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

async function renderPushState(){
  const st=$("#pushStatus"), btn=$("#pushBtn"), hint=$("#pushHint");
  if(!st) return;
  if(!("serviceWorker" in navigator) || !("PushManager" in window)){
    st.textContent="Questo dispositivo/browser non supporta le notifiche push.";
    btn.classList.add("hide"); return;
  }
  if(isIOS && !isStandalone){
    st.textContent="Per attivare le notifiche su iPhone, apri l'app dall'icona in schermata Home (non dal browser).";
    btn.classList.add("hide"); return;
  }
  btn.classList.remove("hide");
  const reg=await navigator.serviceWorker.ready;
  const sub=await reg.pushManager.getSubscription();
  if(Notification.permission==="granted" && sub){
    st.textContent="✅ Notifiche attive su questo dispositivo.";
    btn.textContent="Disattiva su questo dispositivo";
    btn.dataset.on="1";
  }else{
    st.textContent="Notifiche non attive su questo dispositivo.";
    btn.textContent="Attiva notifiche su questo dispositivo";
    btn.dataset.on="";
  }
  hint.textContent = isIOS ? "Su iPhone gli avvisi arrivano solo con l'app aperta almeno una volta e le notifiche consentite." : "";
}

async function togglePush(){
  const btn=$("#pushBtn");
  const reg=await navigator.serviceWorker.ready;
  if(btn.dataset.on){
    // disattiva
    const sub=await reg.pushManager.getSubscription();
    if(sub){ try{ await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); }catch(e){} await sub.unsubscribe(); }
    toast("Notifiche disattivate"); renderPushState(); return;
  }
  if(VAPID_PUBLIC_KEY.startsWith("INCOLLA")){ toast("Chiave VAPID non configurata"); return; }
  const perm=await Notification.requestPermission();
  if(perm!=="granted"){ toast("Permesso negato"); renderPushState(); return; }
  let sub;
  try{
    sub=await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
  }catch(e){ toast("Errore attivazione: "+e.message); return; }
  const json=sub.toJSON();
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("push_subscriptions").upsert({
    user_id: user.id, client_id: CLIENT ? CLIENT.id : null,
    endpoint: json.endpoint, subscription: json
  }, { onConflict:"endpoint" });
  if(error){ toast("Errore salvataggio: "+error.message); return; }
  toast("Notifiche attivate"); renderPushState();
}
document.getElementById("pushBtn").addEventListener("click", togglePush);

/* =====================================================================
   VOUCHER (sezione titolare)
   ===================================================================== */
let VOUCHERS=[], VFILTER="tutti";
async function loadVouchers(){
  const list=$("#vouchersList"); list.innerHTML='<div class="loading">Carico…</div>';
  const { data, error } = await sb.from("vouchers")
    .select("id,code,service_name,amount_cents,from_name,to_name,message,buyer_email,status,created_at")
    .order("created_at",{ascending:false});
  if(error){ list.innerHTML='<div class="empty">Errore nel caricamento.</div>'; return; }
  VOUCHERS=data||[]; renderVouchers();
}
function renderVouchers(){
  const term=$("#vSearch").value.trim().toLowerCase();
  let rows=VOUCHERS;
  if(VFILTER!=="tutti") rows=rows.filter(v=>v.status===VFILTER);
  if(term) rows=rows.filter(v=>(v.code||"").toLowerCase().includes(term)||(v.to_name||"").toLowerCase().includes(term)||(v.from_name||"").toLowerCase().includes(term));
  const list=$("#vouchersList");
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="big">◆</div>${VOUCHERS.length?"Nessun voucher con questi filtri.":"Ancora nessun voucher."}</div>`; return; }
  list.innerHTML=rows.map(v=>`
    <div class="bk">
      <div class="bk-top">
        <div>
          <div class="bk-time" style="font-size:19px; letter-spacing:1px">${esc(v.code)}</div>
          <div class="bk-name">${esc(v.service_name||"")}</div>
        </div>
        <span class="status ${v.status==='usato'?'annullata':'confermata'}">${v.status==='usato'?'Usato':'Valido'}</span>
      </div>
      <div class="bk-meta">
        ${v.amount_cents!=null?`<span><b>${euro(v.amount_cents)}</b></span>`:""}
        <span>Da <b>${esc(v.from_name||"")}</b> · per <b>${esc(v.to_name||"")}</b></span>
        ${v.message?`<span style="flex-basis:100%">✎ ${esc(v.message)}</span>`:""}
        <span style="flex-basis:100%; color:var(--muted)">${fmtDate(String(v.created_at).slice(0,10))}${v.buyer_email?` · ${esc(v.buyer_email)}`:""}</span>
      </div>
      <div class="actions">
        ${v.status==='valido'
          ? `<button class="act confirm" data-vuse="${v.id}">Segna come usato</button>`
          : `<button class="act reopen" data-vrestore="${v.id}">Riporta a valido</button>`}
      </div>
    </div>`).join("");
}
document.querySelectorAll('#tab-vouchers .chip[data-vf]').forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll('#tab-vouchers .chip[data-vf]').forEach(x=>x.classList.remove("on"));
  c.classList.add("on"); VFILTER=c.dataset.vf; renderVouchers();
}));
$("#vSearch").addEventListener("input", renderVouchers);
$("#vouchersList").addEventListener("click", async e=>{
  const use=e.target.closest("[data-vuse]");
  const res=e.target.closest("[data-vrestore]");
  if(!use && !res) return;
  const id = use ? use.dataset.vuse : res.dataset.vrestore;
  const patch = use ? { status:"usato", redeemed_at:new Date().toISOString() } : { status:"valido", redeemed_at:null };
  (use||res).disabled=true;
  const { error } = await sb.from("vouchers").update(patch).eq("id", id);
  if(error){ toast("Errore, riprova"); (use||res).disabled=false; return; }
  toast(use?"Voucher segnato come usato":"Voucher riportato a valido"); loadVouchers();
});

/* =====================================================================
   CLIENTI (anagrafica)
   ===================================================================== */
let CUSTOMERS=[];
async function loadCustomers(){
  const list=$("#customersList"); list.innerHTML='<div class="loading">Carico…</div>';
  let q = sb.from("customers")
    .select("id,name,phone,email,city,notes")
    .order("name",{ascending:true, nullsFirst:false}).limit(5000);
  if(ADMIN_CLIENT) q = q.eq("client_id", ADMIN_CLIENT.id);
  const { data, error } = await q;
  if(error){ list.innerHTML='<div class="empty">Errore nel caricamento.</div>'; return; }
  CUSTOMERS=data||[]; renderCustomers();
}
function renderCustomers(){
  const term=$("#custSearch").value.trim().toLowerCase();
  let rows=CUSTOMERS;
  if(term) rows=rows.filter(c=>((c.name||"")+" "+(c.phone||"")+" "+(c.email||"")).toLowerCase().includes(term));
  $("#custCount").textContent = `${CUSTOMERS.length} clienti${term?` · ${rows.length} risultati`:""}`;
  const list=$("#customersList");
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="big">◆</div>${CUSTOMERS.length?"Nessun risultato.":"Ancora nessun cliente."}</div>`; return; }
  rows=rows.slice(0,400);   // mostra i primi 400 (la ricerca restringe)
  list.innerHTML = rows.map(c=>`
    <div class="hist" data-cust="${c.id}" style="cursor:pointer">
      <div class="who">
        <b>${esc(c.name||"(senza nome)")}</b>
        <div>${[c.phone,c.email,c.city].filter(Boolean).map(esc).join(" · ")||"—"}</div>
      </div>
      ${c.phone?`<a class="act wa" href="${waLink(c.phone)}" target="_blank" rel="noopener" data-wa="1" style="text-decoration:none">WhatsApp</a>`:""}
    </div>`).join("") + (CUSTOMERS.length>400 && !term ? `<div class="empty" style="padding:16px">Mostro i primi 400 — usa la ricerca per trovare gli altri.</div>` : "");
}
$("#custSearch").addEventListener("input", renderCustomers);
$("#customersList").addEventListener("click", e=>{
  if(e.target.closest("[data-wa]")) return;
  const row=e.target.closest("[data-cust]");
  if(row) openCustomer(CUSTOMERS.find(c=>c.id===row.dataset.cust));
});
$("#addCustBtn").addEventListener("click", ()=>openCustomer(null));

function openCustomer(c){
  $("#custMsg").className="msg";
  $("#custModalTitle").textContent = c ? "Modifica cliente" : "Nuovo cliente";
  $("#cName").value  = c?.name  || "";
  $("#cPhone").value = c?.phone || "";
  $("#cEmail").value = c?.email || "";
  $("#cCity").value  = c?.city  || "";
  $("#cNotes").value = c?.notes || "";
  $("#custDelete").style.display = c ? "inline-block" : "none";
  $("#custDelete").dataset.id = c?.id || "";
  $("#custSave").dataset.id = c?.id || "";
  const h=$("#custHistory");
  h.innerHTML = (c && c.phone) ? `<a id="custSeeHist" style="color:var(--spark); font-weight:600; cursor:pointer; font-size:14px">Vedi storico appuntamenti →</a>` : "";
  if(c && c.phone){ h.querySelector("#custSeeHist").addEventListener("click", ()=>loadCustomerDetail(c.phone, c.name||"")); }
  $("#custModal").classList.remove("hide");
}
$("#custClose").addEventListener("click", ()=>$("#custModal").classList.add("hide"));
$("#custModal").addEventListener("click", e=>{ if(e.target.id==="custModal") $("#custModal").classList.add("hide"); });
$("#custSave").addEventListener("click", async ()=>{
  const m=$("#custMsg"); m.className="msg";
  const name=$("#cName").value.trim();
  if(!name && !$("#cPhone").value.trim()){ m.className="msg err"; m.textContent="Inserisci almeno nome o telefono."; return; }
  const rec={ name: name||null, phone: $("#cPhone").value.trim()||null, email: $("#cEmail").value.trim()||null,
              city: $("#cCity").value.trim()||null, notes: $("#cNotes").value.trim()||null };
  const id=$("#custSave").dataset.id;
  $("#custSave").disabled=true;
  let error;
  if(id){ ({error}=await sb.from("customers").update(rec).eq("id",id)); }
  else  { rec.client_id = ADMIN_CLIENT ? ADMIN_CLIENT.id : CLIENT.id; ({error}=await sb.from("customers").insert(rec)); }
  $("#custSave").disabled=false;
  if(error){ m.className="msg err"; m.textContent = /duplicate|unique/i.test(error.message)?"Esiste già un cliente con questo telefono.":error.message; return; }
  $("#custModal").classList.add("hide"); toast(id?"Cliente aggiornato":"Cliente aggiunto"); loadCustomers();
});
$("#custDelete").addEventListener("click", async ()=>{
  const id=$("#custDelete").dataset.id; if(!id) return;
  if(!confirm("Eliminare questo cliente dall'anagrafica?")) return;
  const { error } = await sb.from("customers").delete().eq("id",id);
  if(error){ toast("Errore, riprova"); return; }
  $("#custModal").classList.add("hide"); toast("Cliente eliminato"); loadCustomers();
});

/* =====================================================================
   SERVIZI (editor prezzi/durate)
   ===================================================================== */
let SERVICES_ROWS=[], SVC_CAT="tutte";
function svcScopeId(){ return ADMIN_CLIENT ? ADMIN_CLIENT.id : (CLIENT ? CLIENT.id : null); }
async function loadServices(){
  const list=$("#servicesList"); list.innerHTML='<div class="loading">Carico…</div>';
  let q=sb.from("services").select("id,key,name,price_cents,duration_min,buffer_min,active,sort_order,category").order("sort_order").order("name");
  if(ADMIN_CLIENT) q=q.eq("client_id",ADMIN_CLIENT.id);
  const { data, error } = await q;
  if(error){ list.innerHTML='<div class="empty">Errore nel caricamento.</div>'; return; }
  SERVICES_ROWS=data||[];
  // barra sezioni (dalle categorie presenti)
  const cats=[...new Set(SERVICES_ROWS.map(s=>s.category).filter(Boolean))].sort();
  $("#svcCatFilter").innerHTML = cats.length ? (
    `<button class="chip ${SVC_CAT==="tutte"?"on":""}" data-svcat="tutte">Tutte</button>`+
    cats.map(c=>`<button class="chip ${SVC_CAT===c?"on":""}" data-svcat="${esc(c)}">${esc(c)}</button>`).join("")+
    (SERVICES_ROWS.some(s=>!s.category)?`<button class="chip ${SVC_CAT==="(nessuna)"?"on":""}" data-svcat="(nessuna)">Senza sezione</button>`:"")
  ) : "";
  renderServices();
}
function renderServices(){
  const term=$("#svcSearch").value.trim().toLowerCase();
  let rows=SERVICES_ROWS;
  if(SVC_CAT!=="tutte") rows=rows.filter(s=> SVC_CAT==="(nessuna)" ? !s.category : s.category===SVC_CAT);
  if(term) rows=rows.filter(s=>(s.name||"").toLowerCase().includes(term));
  const list=$("#servicesList");
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="big">◆</div>${SERVICES_ROWS.length?"Nessun risultato.":"Ancora nessun servizio. Aggiungine uno."}</div>`; return; }
  list.innerHTML=rows.map(s=>`
    <div class="hist" data-svc="${s.id}" style="cursor:pointer">
      <div class="who">
        <b>${esc(s.name)}</b>
        <div>${s.category?esc(s.category)+" · ":""}${s.duration_min?`${s.duration_min} min`:""}${!s.active?" · non attivo":""}</div>
      </div>
      <div class="visits"><div class="n" style="color:var(--ink)">${s.price_cents!=null?euro(s.price_cents):"—"}</div><div class="l">prezzo</div></div>
    </div>`).join("");
}
$("#svcCatFilter").addEventListener("click", e=>{ const b=e.target.closest("[data-svcat]"); if(!b) return; SVC_CAT=b.dataset.svcat; loadServices(); });
$("#svcSearch").addEventListener("input", renderServices);
$("#servicesList").addEventListener("click", e=>{ const r=e.target.closest("[data-svc]"); if(r) openService(SERVICES_ROWS.find(s=>s.id===r.dataset.svc)); });
$("#addSvcBtn").addEventListener("click", ()=>openService(null));

function slugifyKey(s){ return (s||"").toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }
function openService(s){
  $("#svcMsg").className="msg";
  $("#svcModalTitle").textContent = s ? "Modifica servizio" : "Nuovo servizio";
  $("#sName").value = s?.name || "";
  $("#sCat").value = s?.category || "";
  $("#sPrice").value = (s && s.price_cents!=null) ? (s.price_cents/100) : "";
  $("#sDur").value = s?.duration_min || 30;
  $("#sBuf").value = s?.buffer_min || 0;
  $("#sActive").checked = s ? !!s.active : true;
  $("#svcSave").dataset.id = s?.id || "";
  $("#svcSave").dataset.key = s?.key || "";
  $("#svcDelete").style.display = s ? "inline-block" : "none";
  $("#svcDelete").dataset.id = s?.id || "";
  $("#svcModal").classList.remove("hide");
}
$("#svcClose").addEventListener("click", ()=>$("#svcModal").classList.add("hide"));
$("#svcModal").addEventListener("click", e=>{ if(e.target.id==="svcModal") $("#svcModal").classList.add("hide"); });
$("#svcSave").addEventListener("click", async ()=>{
  const m=$("#svcMsg"); m.className="msg";
  const name=$("#sName").value.trim();
  if(!name){ m.className="msg err"; m.textContent="Inserisci il nome del servizio."; return; }
  const price = $("#sPrice").value===""?null:Math.round(parseFloat($("#sPrice").value)*100);
  const rec={ name, price_cents: (price!=null && !isNaN(price))?price:null,
              category: $("#sCat").value || null,
              duration_min: parseInt($("#sDur").value,10)||20, buffer_min: parseInt($("#sBuf").value,10)||0,
              active: $("#sActive").checked };
  const id=$("#svcSave").dataset.id;
  $("#svcSave").disabled=true;
  let error;
  if(id){ ({error}=await sb.from("services").update(rec).eq("id",id)); }
  else {
    rec.client_id = svcScopeId();
    rec.key = slugifyKey(name)+"-"+Math.random().toString(36).slice(2,6);
    rec.sort_order = SERVICES_ROWS.length+1;
    ({error}=await sb.from("services").insert(rec));
  }
  $("#svcSave").disabled=false;
  if(error){ m.className="msg err"; m.textContent=error.message; return; }
  $("#svcModal").classList.add("hide"); toast(id?"Servizio aggiornato":"Servizio aggiunto"); loadServices();
});
$("#svcDelete").addEventListener("click", async ()=>{
  const id=$("#svcDelete").dataset.id; if(!id) return;
  if(!confirm("Eliminare questo servizio? Le prenotazioni passate restano, ma non sarà più prenotabile.")) return;
  // soft: disattivo invece di cancellare (mantiene i report storici)
  const { error } = await sb.from("services").update({active:false}).eq("id",id);
  if(error){ toast("Errore, riprova"); return; }
  $("#svcModal").classList.add("hide"); toast("Servizio disattivato"); loadServices();
});

/* =====================================================================
   REPORT (incassi dove c'è prezzo, volumi sempre) — solo confermate
   ===================================================================== */
let RPERIOD="week", RSECTION="tutte";
function periodStart(p){
  const d=new Date(); d.setHours(0,0,0,0);
  if(p==="week"){ const g=(d.getDay()+6)%7; d.setDate(d.getDate()-g); }
  else if(p==="month"){ d.setDate(1); }
  else if(p==="year"){ d.setMonth(0,1); }
  else return null;
  return ymdLocal(d);
}
function ymdLocal(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
document.querySelectorAll('#tab-reports .chip[data-rp]').forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll('#tab-reports .chip[data-rp]').forEach(x=>x.classList.remove("on"));
  c.classList.add("on"); RPERIOD=c.dataset.rp; loadReports();
}));
// filtro per sezione (chip + righe "Per sezione" cliccabili)
$("#tab-reports").addEventListener("click", e=>{
  const b=e.target.closest("[data-rsec]"); if(!b) return;
  RSECTION=b.dataset.rsec; loadReports();
});
const NOSEC="(senza sezione)";
async function loadReports(){
  const box=$("#reportBox"); box.innerHTML='<div class="loading">Carico…</div>';
  const secBar=$("#reportSecFilter"); if(secBar) secBar.innerHTML="";
  let q=sb.from("bookings")
    .select("booking_date,party_size,amount_cents,paid,status,staff_id,staff(name),services(name,price_cents,category)")
    .eq("status","confermata");
  if(ADMIN_CLIENT) q=q.eq("client_id",ADMIN_CLIENT.id);
  const from=periodStart(RPERIOD);
  if(from) q=q.gte("booking_date",from);
  const { data, error } = await q.limit(10000);
  if(error){ box.innerHTML='<div class="empty">Errore nel caricamento.</div>'; return; }
  const rows=data||[];

  // aggregazione per sezione
  const perSection={};
  const bump=sec=>(perSection[sec]||(perSection[sec]={count:0,coperti:0,incasso:0,conPrezzo:0,perServ:{}}));
  rows.forEach(b=>{
    const sec=(b.services&&b.services.category)?b.services.category:NOSEC;
    const S=bump(sec);
    S.count++; S.coperti+=b.party_size||0;
    let val=null;
    if(b.paid && b.amount_cents!=null) val=b.amount_cents;                                   // pagato online: già totale
    else if(b.services && b.services.price_cents!=null) val=b.services.price_cents*(b.party_size||1);  // a prezzo: × persone
    if(val!=null){ S.incasso+=val; S.conPrezzo++;
      const k=b.services?b.services.name:"Altro"; S.perServ[k]=(S.perServ[k]||0)+val; }
  });

  const realSecs=Object.keys(perSection).filter(s=>s!==NOSEC).sort((a,b)=>a.localeCompare(b,"it"));
  const hasNoSec=!!perSection[NOSEC];
  // reset selezione se la sezione scelta non esiste in questo periodo
  if(RSECTION!=="tutte" && RSECTION!==NOSEC && !realSecs.includes(RSECTION)) RSECTION="tutte";
  if(RSECTION===NOSEC && !hasNoSec) RSECTION="tutte";

  // barra sezioni (solo se ci sono sezioni vere)
  if(secBar){
    if(realSecs.length){
      const chips=[`<button class="chip ${RSECTION==="tutte"?"on":""}" data-rsec="tutte">Tutte</button>`]
        .concat(realSecs.map(s=>`<button class="chip ${RSECTION===s?"on":""}" data-rsec="${esc(s)}">${esc(s)}</button>`));
      if(hasNoSec) chips.push(`<button class="chip ${RSECTION===NOSEC?"on":""}" data-rsec="${esc(NOSEC)}">Senza sezione</button>`);
      secBar.innerHTML=chips.join("");
    } else secBar.innerHTML="";
  }

  // aggregazione per operatore (rispetta la sezione selezionata) — si aggiorna da sola quando sposti un appuntamento
  const perOper={};
  rows.forEach(b=>{
    const sec=(b.services&&b.services.category)?b.services.category:NOSEC;
    if(RSECTION!=="tutte" && sec!==RSECTION) return;
    let val=null;
    if(b.paid && b.amount_cents!=null) val=b.amount_cents;
    else if(b.services && b.services.price_cents!=null) val=b.services.price_cents*(b.party_size||1);
    const op = agIsSpa(b) ? "Hair Spa" : ((b.staff && b.staff.name) ? b.staff.name : "Senza operatore");
    const O=perOper[op]||(perOper[op]={count:0,incasso:0});
    O.count++; if(val!=null) O.incasso+=val;
  });
  const perOperOrd=Object.entries(perOper).sort((a,b)=>b[1].incasso-a[1].incasso);

  // totali secondo la sezione selezionata
  const empty=()=>({count:0,coperti:0,incasso:0,conPrezzo:0,perServ:{}});
  let agg;
  if(RSECTION==="tutte"){
    agg=empty();
    Object.values(perSection).forEach(S=>{ agg.count+=S.count; agg.coperti+=S.coperti; agg.incasso+=S.incasso; agg.conPrezzo+=S.conPrezzo;
      for(const [k,v] of Object.entries(S.perServ)) agg.perServ[k]=(agg.perServ[k]||0)+v; });
  } else agg=perSection[RSECTION]||empty();

  const nomePeriodo={week:"questa settimana",month:"questo mese",year:"quest'anno",all:"da sempre"}[RPERIOD];
  const secLabel = RSECTION==="tutte" ? "" : (RSECTION===NOSEC ? " · senza sezione" : " · "+RSECTION);
  const serviziOrdinati=Object.entries(agg.perServ).sort((a,b)=>b[1]-a[1]);
  const perSezioneOrd=realSecs.map(s=>[s,perSection[s]]).sort((a,b)=>b[1].incasso-a[1].incasso);

  box.innerHTML=`
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px">
      <div class="card" style="margin:0"><p style="margin:0 0 4px">Prenotazioni confermate</p><div style="font-size:26px; font-weight:800">${agg.count}</div><div style="color:var(--muted); font-size:12px">${nomePeriodo}${secLabel}</div></div>
      <div class="card" style="margin:0"><p style="margin:0 0 4px">Coperti / persone</p><div style="font-size:26px; font-weight:800">${agg.coperti}</div><div style="color:var(--muted); font-size:12px">${nomePeriodo}${secLabel}</div></div>
    </div>
    ${agg.conPrezzo>0 ? `
      <div class="card" style="text-align:center; margin-bottom:14px">
        <p style="margin:0 0 4px">Incasso stimato</p>
        <div style="font-size:34px; font-weight:800; color:var(--ok)">${euro(agg.incasso)}</div>
        <div style="color:var(--muted); font-size:12px">su ${agg.conPrezzo} prenotazioni con prezzo · ${nomePeriodo}${secLabel}</div>
      </div>` : ""}
    ${perOperOrd.length ? `
      <div class="card">
        <h3 style="margin:0 0 10px">Per operatore${secLabel}</h3>
        ${perOperOrd.map(([n,O])=>`<div style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-top:1px solid var(--line-soft)"><span>${esc(n)} <span style="color:var(--muted); font-size:12px">\u00b7 ${O.count} pren.</span></span><b>${euro(O.incasso)}</b></div>`).join("")}
      </div>` : ""}
    ${(RSECTION==="tutte" && perSezioneOrd.length) ? `
      <div class="card">
        <h3 style="margin:0 0 10px">Per sezione</h3>
        ${perSezioneOrd.map(([n,S])=>`<div class="rp-row" data-rsec="${esc(n)}" style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-top:1px solid var(--line-soft); cursor:pointer">
            <span>${esc(n)} <span style="color:var(--muted); font-size:12px">· ${S.count} pren.</span></span><b>${euro(S.incasso)}</b></div>`).join("")}
        ${hasNoSec?`<div class="rp-row" data-rsec="${esc(NOSEC)}" style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-top:1px solid var(--line-soft); cursor:pointer">
            <span>Senza sezione <span style="color:var(--muted); font-size:12px">· ${perSection[NOSEC].count} pren.</span></span><b>${euro(perSection[NOSEC].incasso)}</b></div>`:""}
      </div>` : ""}
    ${serviziOrdinati.length ? `
      <div class="card">
        <h3 style="margin:0 0 10px">Per servizio${secLabel}</h3>
        ${serviziOrdinati.map(([n,v])=>`<div style="display:flex; justify-content:space-between; padding:7px 0; border-top:1px solid var(--line-soft)"><span>${esc(n)}</span><b>${euro(v)}</b></div>`).join("")}
      </div>`
    : (agg.conPrezzo===0 ? `<div class="empty">Nessun servizio con prezzo in questo periodo. Per le attività a posti (ristoranti) il report mostra solo i volumi qui sopra.</div>` : "")}
  `;
}

/* =====================================================================
   AGENDA — vista griglia con personale, drag & resize (additivo)
   ===================================================================== */
var AG_VIEW="list";
var AG_DATE=isoToday(0);
var AG_STAFF=[];
var AG_APPTS=[];
var AG_RULES={from:"09:30",to:"18:30",step:15};
var AG_PXMIN=1.35;          // pixel per minuto
var AG_DRAG=null;

function agToMin(hhmm){ const p=String(hhmm||"0:0").split(":"); return (parseInt(p[0],10)||0)*60+(parseInt(p[1],10)||0); }
function agMinToTime(min){ min=Math.max(0,Math.round(min)); const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); }
function agSnap(min){ const s=AG_RULES.step||15; return Math.round(min/s)*s; }
function agDur(b){ return b.duration_min || (b.services&&b.services.duration_min) || AG_RULES.step || 30; }
function agShiftDay(iso,delta){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+delta); return ymd(d); }

// mostra lista o agenda dentro il tab Prenotazioni
function agApplyView(){
  const isAg = AG_VIEW==="agenda";
  const tab=$("#tab-bookings"); if(tab) tab.classList.toggle("ag-open", isAg);   // larghezza piena senza dipendere da :has()
  const hasAppt = (typeof BTYPES!=="undefined") && BTYPES.some(t=>t.key==="appuntamento");
  const ab=$("#bkViewAgenda"); if(ab) ab.classList.toggle("hide", !hasAppt);
  const tg=$("#bkViewList")?.parentElement; if(tg) tg.classList.toggle("hide", !hasAppt);   // niente toggle se non è un'agenda
  const t=(sel,on)=>{ const el=$(sel); if(el) el.classList.toggle("hide",!on); };
  t("#bkListTools", !isAg);
  t("#bookingsList",!isAg);
  t("#agendaView",   isAg);
  const lb=$("#bkViewList"); if(lb) lb.classList.toggle("on",!isAg);
  if(ab) ab.classList.toggle("on", isAg && hasAppt);
  if(isAg){ const nb=$("#newBanner"); if(nb) nb.classList.add("hide"); const d=$("#agDate"); if(d) d.value=AG_DATE; loadAgenda(); }
}

$("#bkViewList")   && $("#bkViewList").addEventListener("click", ()=>{ AG_VIEW="list";   agApplyView(); loadBookings(); });
$("#bkViewAgenda") && $("#bkViewAgenda").addEventListener("click", ()=>{ AG_VIEW="agenda"; agApplyView(); });
$("#agPrev")  && $("#agPrev").addEventListener("click", ()=>{ AG_DATE=agShiftDay(AG_DATE,-1); $("#agDate").value=AG_DATE; loadAgenda(); });
$("#agNext")  && $("#agNext").addEventListener("click", ()=>{ AG_DATE=agShiftDay(AG_DATE, 1); $("#agDate").value=AG_DATE; loadAgenda(); });
$("#agToday") && $("#agToday").addEventListener("click", ()=>{ AG_DATE=isoToday(0); $("#agDate").value=AG_DATE; loadAgenda(); });
$("#agDate")  && $("#agDate").addEventListener("change", e=>{ AG_DATE=e.target.value||isoToday(0); loadAgenda(); });
$("#agAdd")   && $("#agAdd").addEventListener("click", ()=>openAddModal({date:AG_DATE}));
$("#agStaffBtn") && $("#agStaffBtn").addEventListener("click", openStaffModal);

async function loadAgenda(){
  const mount=$("#agendaGrid"); if(!mount) return;
  mount.innerHTML='<div class="loading">Carico…</div>';
  const scope=svcScopeId(); if(!scope){ mount.innerHTML='<div class="empty">Nessuna attività selezionata.</div>'; return; }
  const [{data:staff},{data:bt}]=await Promise.all([
    sb.from("staff").select("id,name,color,sort_order").eq("client_id",scope).eq("active",true).order("sort_order").order("name"),
    sb.from("booking_types").select("rules").eq("client_id",scope).eq("key","appuntamento").maybeSingle()
  ]);
  AG_STAFF=staff||[];
  const r=(bt&&bt.rules)||{};
  AG_RULES={ from:r.time_from||"09:30", to:r.time_to||"18:30", step:parseInt(r.slot_minutes,10)||15 };
  const { data:appts, error } = await sb.from("bookings")
    .select("id,customer_name,customer_phone,booking_time,status,notes,staff_id,duration_min,booking_types!inner(key),services(name,duration_min,category)")
    .eq("client_id",scope).eq("booking_date",AG_DATE).eq("booking_types.key","appuntamento")
    .in("status",["in_attesa","confermata"]).not("booking_time","is",null);
  if(error){ mount.innerHTML='<div class="empty">Errore nel caricamento.</div>'; return; }
  AG_APPTS=appts||[];
  renderAgenda();
}

function agIsSpa(a){ return !!(a.services && a.services.category && /hair *spa/i.test(a.services.category)); }
function agHue(id){ let h=0; const s=String(id||""); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return Math.floor((h*137.508)%360); }
function renderAgenda(){
  const mount=$("#agendaGrid");
  const spa=AG_APPTS.filter(agIsSpa);
  const nonSpa=AG_APPTS.filter(a=>!agIsSpa(a));
  const noStaff = AG_STAFF.length===0;
  let cols=AG_STAFF.map(s=>({id:s.id,name:s.name,color:s.color||"#3b7a57"}));
  if(noStaff && nonSpa.length) cols=[{id:"__all__",name:"Agenda",color:"#6b7370"}];
  if(spa.length) cols.push({id:"__spa__",name:"Hair Spa",color:"#B8986A"});
  const unassigned=nonSpa.filter(a=>!a.staff_id);
  if(!noStaff && unassigned.length) cols.push({id:"__none__",name:"Non assegnati",color:"#9aa3a0"});
  if(!cols.length) cols=[{id:"__all__",name:"Agenda",color:"#6b7370"}];

  const fromMin=Math.floor(agToMin(AG_RULES.from)/60)*60;
  let endMin=agToMin(AG_RULES.to);
  AG_APPTS.forEach(a=>{ endMin=Math.max(endMin, agToMin(a.booking_time.slice(0,5))+agDur(a)); });
  endMin=Math.ceil(endMin/60)*60;
  const totalMin=Math.max(endMin-fromMin,60);
  const H=totalMin*AG_PXMIN;
  const colOf=a=> agIsSpa(a) ? "__spa__" : (noStaff ? "__all__" : (a.staff_id || "__none__"));

  let rail='<div class="ag-rail" style="height:'+H+'px">';
  for(let m=fromMin;m<=endMin;m+=60){ rail+='<div class="ag-hour" style="top:'+((m-fromMin)*AG_PXMIN)+'px">'+agMinToTime(m)+'</div>'; }
  rail+='</div>';

  const step=AG_RULES.step||15;
  const colsHtml=cols.map(c=>{
    let lines='';
    for(let m=fromMin;m<=endMin;m+=step){ lines+='<div class="ag-line" style="top:'+((m-fromMin)*AG_PXMIN)+'px"></div>'; }
    const blocks=AG_APPTS.filter(a=>colOf(a)===c.id).map(a=>agBlockHtml(a,fromMin)).join("");
    return '<div class="ag-col"><div class="ag-colhead" style="--c:'+esc(c.color)+'"><span class="ag-dot"></span>'+esc(c.name)+'</div>'+
           '<div class="ag-colbody" data-staff="'+esc(String(c.id))+'" style="height:'+H+'px">'+lines+blocks+'</div></div>';
  }).join("");

  mount.innerHTML='<div class="ag-scroll"><div class="ag-inner">'+rail+'<div class="ag-cols">'+colsHtml+'</div></div></div>';
  agBindPointer(mount, fromMin);
}

function agBlockHtml(a,fromMin){
  const start=agToMin(a.booking_time.slice(0,5));
  const dur=agDur(a);
  const top=(start-fromMin)*AG_PXMIN;
  const h=Math.max(dur*AG_PXMIN,22);
  const svc=a.services?a.services.name:"";
  const range=agMinToTime(start)+"–"+agMinToTime(start+dur);
  const hue=agHue(a.id);
  const st="top:"+top+"px; height:"+h+"px; background:hsla("+hue+",68%,55%,.20); border-color:hsla("+hue+",60%,45%,.9)";
  const dot=a.status==="confermata"?"#1F7A5A":(a.status==="annullata"?"#b3261e":"#D6A94A");
  return '<div class="ag-block '+a.status+'" data-id="'+a.id+'" style="'+st+'">'+
    '<div class="ag-b-time"><span class="ag-b-dot" style="background:'+dot+'"></span>'+range+'</div>'+
    '<div class="ag-b-name">'+esc(a.customer_name||"")+'</div>'+
    (svc?'<div class="ag-b-svc">'+esc(svc)+'</div>':'')+
    '<div class="ag-resize" data-resize="1"></div></div>';
}

function agBindPointer(mount, fromMin){
  let tap=null;   // possibile tocco su spazio vuoto
  mount.onpointerdown=(e)=>{
    const resize=e.target.closest(".ag-resize");
    const block=e.target.closest(".ag-block");
    const body=e.target.closest(".ag-colbody");
    if(!body) return;
    if(block){
      e.preventDefault();
      AG_DRAG={ mode: resize?"resize":"move", id:block.dataset.id, el:block,
        startY:e.clientY, startX:e.clientX,
        origTop:parseFloat(block.style.top)||0, origH:parseFloat(block.style.height)||22,
        fromMin, moved:false };
      if(block.setPointerCapture) block.setPointerCapture(e.pointerId);
      block.classList.add(resize?"resizing":"moving");
      return;
    }
    tap={ x:e.clientX, y:e.clientY, t:Date.now(), body };   // memorizzo, NON apro
  };
  mount.onpointermove=(e)=>{
    if(tap && (Math.abs(e.clientX-tap.x)>8 || Math.abs(e.clientY-tap.y)>8)) tap=null;  // e uno scroll
    if(!AG_DRAG) return;
    const dy=e.clientY-AG_DRAG.startY, dx=e.clientX-AG_DRAG.startX;
    if(Math.abs(dy)>4||Math.abs(dx)>4) AG_DRAG.moved=true;
    if(AG_DRAG.mode==="resize"){
      AG_DRAG.el.style.height=Math.max(16, AG_DRAG.origH+dy)+"px";
    } else {
      AG_DRAG.el.style.top=(AG_DRAG.origTop+dy)+"px";
      const under=document.elementFromPoint(e.clientX,e.clientY);
      const tb=under&&under.closest?under.closest(".ag-colbody"):null;
      if(tb && tb!==AG_DRAG.el.parentElement) tb.appendChild(AG_DRAG.el);
    }
  };
  const finish=async(e)=>{
    if(tap && !AG_DRAG){
      const moved=Math.abs(e.clientX-tap.x)>8||Math.abs(e.clientY-tap.y)>8;
      const quick=(Date.now()-tap.t)<600;
      const body=tap.body, cy=e.clientY; tap=null;
      if(!moved && quick){
        const rect=body.getBoundingClientRect();
        const min=agSnap(fromMin + (cy-rect.top)/AG_PXMIN);
        openAddModal({ date:AG_DATE, time:agMinToTime(Math.max(fromMin,min)) });
      }
      return;
    }
    tap=null;
    if(!AG_DRAG) return;
    const D=AG_DRAG; AG_DRAG=null;
    D.el.classList.remove("moving","resizing");
    if(!D.moved){ const b=AG_APPTS.find(x=>x.id===D.id); if(b) agOpenMenu(b,D.el); return; }
    if(D.mode==="resize"){
      const newDur=Math.max(AG_RULES.step, agSnap(parseFloat(D.el.style.height)/AG_PXMIN));
      await agUpdate(D.id,{ duration_min:newDur });
    } else {
      const bodyEl=D.el.closest(".ag-colbody");
      const newStart=agSnap(D.fromMin + (parseFloat(D.el.style.top)/AG_PXMIN));
      const raw=bodyEl?bodyEl.dataset.staff:null;
      const patch={ booking_time:agMinToTime(Math.max(0,newStart)) };
      patch.staff_id=(raw==="__none__"||raw==="__all__"||!raw)?null:raw;
      await agUpdate(D.id, patch);
    }
    loadAgenda();
  };
  mount.onpointerup=finish;
  mount.onpointercancel=()=>{ tap=null; if(AG_DRAG){ AG_DRAG.el.classList.remove("moving","resizing"); AG_DRAG=null; loadAgenda(); } };
}

async function agUpdate(id, patch){
  const { error } = await sb.from("bookings").update(patch).eq("id",id);
  if(error){ toast("Errore: "+error.message); return false; }
  toast("Aggiornato"); return true;
}

function agOpenMenu(b, el){
  agCloseMenu();
  const wa = waDigits(b.customer_phone) ? '<a class="ag-mi" href="'+waLink(b.customer_phone)+'" target="_blank" rel="noopener">WhatsApp</a>' : '';
  const conf = b.status!=="confermata" ? '<button class="ag-mi" data-agact="confermata">Conferma</button>' : '';
  const ann  = b.status!=="annullata"  ? '<button class="ag-mi" data-agact="annullata">Annulla</button>' : '';
  const m=document.createElement("div"); m.className="ag-menu"; m.id="agMenu";
  m.innerHTML='<div class="ag-menu-h">'+esc(b.customer_name||"")+(b.services?' · '+esc(b.services.name):'')+'</div>'+conf+ann+wa+
    '<button class="ag-mi del" data-agact="__del__">Elimina</button>';
  document.body.appendChild(m);
  const r=el.getBoundingClientRect();
  m.style.top=(window.scrollY+r.bottom+6)+"px";
  m.style.left=(window.scrollX+Math.max(8,Math.min(r.left, window.innerWidth-210)))+"px";
  m.addEventListener("click", async ev=>{
    const btn=ev.target.closest("[data-agact]"); if(!btn) return;
    const act=btn.dataset.agact;
    if(act==="__del__"){ if(!confirm("Eliminare questo appuntamento?")) return; await sb.from("bookings").delete().eq("id",b.id); }
    else { await sb.from("bookings").update({status:act}).eq("id",b.id); }
    agCloseMenu(); loadAgenda();
  });
}
function agCloseMenu(){ const m=$("#agMenu"); if(m) m.remove(); }
document.addEventListener("click",(e)=>{ if(!e.target.closest(".ag-menu") && !e.target.closest(".ag-block")) agCloseMenu(); });

/* ---- gestione personale ---- */
async function openStaffModal(){
  const scope=svcScopeId(); if(!scope) return;
  $("#staffMsg").className="msg";
  $("#staffModal").classList.remove("hide");
  await renderStaffList();
}
async function renderStaffList(){
  const scope=svcScopeId();
  const { data } = await sb.from("staff").select("id,name,color,active,sort_order").eq("client_id",scope).order("sort_order").order("name");
  const rows=data||[];
  $("#staffList").innerHTML = rows.length ? rows.map(s=>
    '<div class="staff-item'+(s.active?'':' off')+'">'+
      '<span class="staff-dot" style="background:'+esc(s.color||"#3b7a57")+'"></span>'+
      '<span class="staff-name">'+esc(s.name)+(s.active?'':' · disattivato')+'</span>'+
      (s.active?'<button class="chip staff-del" data-del="'+s.id+'">Rimuovi</button>'
              :'<button class="chip staff-on" data-on="'+s.id+'">Riattiva</button>')+
    '</div>').join("") : '<div class="empty" style="padding:14px">Ancora nessun operatore. Aggiungine uno qui sotto.</div>';
}
$("#staffClose") && $("#staffClose").addEventListener("click", ()=>{ $("#staffModal").classList.add("hide"); loadAgenda(); });
$("#staffModal") && $("#staffModal").addEventListener("click", e=>{ if(e.target.id==="staffModal"){ $("#staffModal").classList.add("hide"); loadAgenda(); } });
$("#staffAdd") && $("#staffAdd").addEventListener("click", async ()=>{
  const scope=svcScopeId(); const name=$("#staffName").value.trim(); const color=$("#staffColor").value||"#3b7a57";
  const m=$("#staffMsg"); m.className="msg";
  if(!name){ m.className="msg err"; m.textContent="Inserisci un nome."; return; }
  const { error } = await sb.from("staff").insert({ client_id:scope, name, color,
    key:slugifyKey(name)+"-"+Math.random().toString(36).slice(2,6), sort_order:999 });
  if(error){ m.className="msg err"; m.textContent=error.message; return; }
  $("#staffName").value=""; renderStaffList();
});
$("#staffList") && $("#staffList").addEventListener("click", async e=>{
  const del=e.target.closest("[data-del]"); const on=e.target.closest("[data-on]");
  if(del){ await sb.from("staff").update({active:false}).eq("id",del.dataset.del); renderStaffList(); return; }
  if(on){  await sb.from("staff").update({active:true}).eq("id",on.dataset.on);   renderStaffList(); return; }
});


/* =====================================================================
   AVVIO
   ===================================================================== */
(async()=>{ const { data:{ session } } = await sb.auth.getSession(); if(session) boot(); else showLogin(); })();
