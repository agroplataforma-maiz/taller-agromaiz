/* Agroplataforma · app de campo (PWA, trabaja sin conexión)
   Proyecto SECIHTI PEE-2025-G-369 · TecNM – IT Ciudad Valles */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  const ahora = () => new Date().toISOString();
  const R = 6371008.8;

  // ---------------- IndexedDB ----------------
  let db;
  function abrirDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("agroplataforma-campo", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("kv");
        d.createObjectStore("cola", { keyPath: "uuid" });
        d.createObjectStore("fotos", { keyPath: "uuid" });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  }
  function tx(store, modo, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, modo); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const kvGet = (k) => tx("kv", "readonly", (s) => s.get(k));
  const kvSet = (k, v) => tx("kv", "readwrite", (s) => s.put(v, k));
  const todos = (store) => tx(store, "readonly", (s) => s.getAll());
  const poner = (store, v) => tx(store, "readwrite", (s) => s.put(v));
  const quitar = (store, k) => tx(store, "readwrite", (s) => s.delete(k));

  // ---------------- Estado ----------------
  let S = { sesion: null, config: null, mision: null, borradorArea: [], ficha: null, cron: {} };
  let enviando = false;

  function msg(id, tipo, texto) { $(id).innerHTML = texto ? `<div class="msg ${tipo}">${texto}</div>` : ""; }
  let tt; function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), 3000); }

  async function api(ruta, opciones = {}) {
    const h = opciones.headers || {};
    if (S.sesion) h.Authorization = "Bearer " + S.sesion.token;
    const r = await fetch(ruta, { ...opciones, headers: h });
    let cuerpo = null; try { cuerpo = await r.json(); } catch (e) { /* sin cuerpo */ }
    if (!r.ok) { const err = new Error((cuerpo && cuerpo.error) || "Error " + r.status); err.status = r.status; throw err; }
    return cuerpo;
  }

  // ---------------- Navegación ----------------
  function ir(id) {
    document.querySelectorAll(".pantalla").forEach((p) => (p.hidden = p.id !== id));
    window.scrollTo(0, 0);
    if (id === "pResponsable") iniciarTarea("consentimiento");
    if (id === "pArea") { iniciarGPS(); dibujarArea(); }
    if (id === "pFicha") nuevaFicha();
    if (id === "pEnviar") pintarCola();
    if (id === "pInicio") pintarInicio();
    if (id !== "pArea" && id !== "pFicha") detenerGPS();
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });

  // ---------------- Métricas de tiempo ----------------
  const tareas = {};
  function iniciarTarea(t) { if (!tareas[t]) tareas[t] = { inicio: ahora(), t0: performance.now(), errores: 0 }; }
  function errorTarea(t) { if (tareas[t]) tareas[t].errores++; }
  async function terminarTarea(t, extra = {}) {
    const x = tareas[t]; if (!x) return; delete tareas[t];
    await encolar("metrica", { tarea: t, inicio: x.inicio, fin: ahora(), duracion_s: Math.round((performance.now() - x.t0) / 100) / 10, errores: x.errores, extra: { fuente: "app", ...extra } }, `Tiempo: ${t}`);
  }

  // ---------------- Cola ----------------
  async function encolar(tipo, datos, resumen) {
    const item = { uuid: datos.uuid || uid(), tipo, datos: { ...datos, capturado: datos.capturado || ahora() }, resumen, estado: "pendiente", motivo: "", creado: ahora() };
    item.datos.uuid = item.uuid;
    await poner("cola", item);
    await contarPendientes();
    if (navigator.onLine) setTimeout(() => sincronizar(false), 400);
    return item;
  }
  async function contarPendientes() {
    const c = await todos("cola"), f = await todos("fotos");
    const n = c.filter((i) => i.estado !== "enviado").length + f.filter((i) => i.estado !== "enviado").length;
    $("hPend").textContent = n + " por enviar";
    return n;
  }
  function pintarRed() { const on = navigator.onLine; $("hRed").textContent = on ? "con señal" : "sin señal"; $("hRed").className = "pill " + (on ? "ok" : "off"); }
  window.addEventListener("online", () => { pintarRed(); sincronizar(false); });
  window.addEventListener("offline", pintarRed);

  async function sincronizar(manual) {
    if (enviando || !S.sesion) return;
    if (!navigator.onLine) { if (manual) msg("mEnviar", "aviso", "Sin señal: todo sigue guardado en el teléfono. Sincroniza al regresar a una zona con WiFi o datos."); return; }
    enviando = true; if (manual) { iniciarTarea("sincronizacion"); $("bSync").disabled = true; msg("mEnviar", "ok", "Enviando…"); }
    let enviados = 0, rechazados = 0, fallo = null;
    try {
      const cola = (await todos("cola")).filter((i) => i.estado === "pendiente");
      const orden = { productor: 0, parcela: 1, evaluacion: 2, metrica: 3, incidencia: 4 };
      cola.sort((a, b) => (orden[a.tipo] - orden[b.tipo]) || a.creado.localeCompare(b.creado));
      for (let i = 0; i < cola.length; i += 25) {
        const lote = cola.slice(i, i + 25);
        const r = await api("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dispositivo: navigator.userAgent, items: lote.map((x) => ({ tipo: x.tipo, uuid: x.uuid, datos: x.datos })) }) });
        for (const res of r.resultados) {
          const it = lote.find((x) => x.uuid === res.uuid); if (!it) continue;
          if (res.estado === "ok" || res.estado === "duplicado") { it.estado = "enviado"; it.motivo = ""; enviados++; }
          else if (/reintentar/i.test(res.motivo)) { it.motivo = res.motivo; }
          else { it.estado = "rechazado"; it.motivo = res.motivo; rechazados++; }
          await poner("cola", it);
        }
      }
      const fotos = (await todos("fotos")).filter((f) => f.estado === "pendiente");
      for (const f of fotos) {
        const fd = new FormData();
        fd.append("uuid", f.uuid); fd.append("evaluacion_uuid", f.evaluacion_uuid); fd.append("tipo", f.tipo);
        if (f.latitud != null) { fd.append("latitud", f.latitud); fd.append("longitud", f.longitud); fd.append("precision_m", f.precision_m ?? ""); }
        fd.append("capturado", f.capturado); fd.append("archivo", f.blob, f.uuid + ".jpg");
        try {
          await api("/api/evidencias", { method: "POST", body: fd });
          f.estado = "enviado"; f.blob = null; enviados++;
        } catch (e) {
          if (e.status === 409 || !e.status || e.status >= 500) { f.motivo = e.message; }
          else if (e.status === 401) throw e;
          else { f.estado = "rechazado"; f.motivo = e.message; f.blob = null; rechazados++; }
        }
        await poner("fotos", f);
      }
    } catch (e) {
      fallo = e;
    }
    enviando = false;
    const pend = await contarPendientes();
    if (manual) {
      $("bSync").disabled = false;
      if (enviados + rechazados > 0 || fallo) await terminarTarea("sincronizacion", { enviados, rechazados, pendientes: pend }); else delete tareas.sincronizacion;
      if (fallo && fallo.status === 401) msg("mEnviar", "error", "Tu sesión venció. Cierra sesión y vuelve a entrar con tu tarjeta: los datos no se pierden.");
      else if (fallo) msg("mEnviar", "aviso", "No se pudo llegar al servidor. Revisa la señal e intenta de nuevo. Nada se perdió.");
      else if (rechazados) msg("mEnviar", "error", `${enviados} enviados y ${rechazados} rechazados. Revisa el motivo en la lista.`);
      else if (!enviados && !pend) msg("mEnviar", "ok", "Todo está enviado. Ya aparece en la plataforma.");
      else msg("mEnviar", "ok", pend ? `${enviados} enviados. Quedan ${pend} por enviar.` : `Listo: ${enviados} registros enviados. Ya aparecen en la plataforma.`);
      // la métrica de sincronización también se envía
      if (!fallo && navigator.onLine) setTimeout(() => sincronizar(false), 300);
    }
    if (!$("pEnviar").hidden) pintarCola();
    if (!$("pInicio").hidden) pintarInicio();
  }
  setInterval(() => { if (navigator.onLine) sincronizar(false); }, 60000);

  async function pintarCola() {
    const c = await todos("cola"), f = await todos("fotos");
    const filas = [...c.filter((i) => i.tipo !== "metrica"), ...f.map((x) => ({ ...x, resumen: "Foto · " + x.tipo }))].sort((a, b) => (b.creado || b.capturado).localeCompare(a.creado || a.capturado));
    $("eLista").innerHTML = filas.length ? filas.map((i) => `<li><span>${esc(i.resumen)}${i.motivo ? `<br><small class="muted">${esc(i.motivo)}</small>` : ""}</span><span class="est ${i.estado}">${i.estado}</span></li>`).join("") : `<li><span class="muted">Aún no hay registros.</span></li>`;
  }

  // ---------------- GPS ----------------
  let watchId = null, ultima = null;
  function iniciarGPS() {
    if (!("geolocation" in navigator)) { $("gEstado").textContent = "Este teléfono no tiene GPS disponible"; return; }
    if (!window.isSecureContext) { $("gEstado").textContent = "Abre la app con https:// para usar el GPS"; return; }
    if (watchId != null) return;
    $("gEstado").textContent = "Buscando satélites…";
    watchId = navigator.geolocation.watchPosition((p) => {
      ultima = p; const a = p.coords.accuracy;
      $("gPrec").textContent = "±" + Math.round(a) + " m";
      $("gEstado").textContent = a <= 5 ? "Buena precisión" : a <= 12 ? "Aceptable: espera unos segundos" : "Precisión baja: sal a cielo abierto";
    }, (e) => {
      $("gEstado").textContent = e.code === 1 ? "Permiso de ubicación negado: actívalo en el navegador" : "Sin señal de GPS: sal a cielo abierto";
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function detenerGPS() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

  // Toma varias lecturas y las promedia (peso = 1/precisión²)
  function tomarPunto(onAvance) {
    return new Promise((res, rej) => {
      if (!("geolocation" in navigator) || !window.isSecureContext) { rej(new Error("El GPS solo funciona si la app se abre con https://")); return; }
      const lect = []; const t0 = Date.now(); let ultimoError = null, terminado = false;
      // si el GPS ya tenía una lectura reciente, sirve como primera
      if (ultima && Date.now() - ultima.timestamp < 8000) lect.push({ lat: ultima.coords.latitude, lon: ultima.coords.longitude, acc: ultima.coords.accuracy });
      const id = navigator.geolocation.watchPosition((p) => {
        lect.push({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); ultima = p;
        const buenas = lect.filter((l) => l.acc <= 5).length; const seg = (Date.now() - t0) / 1000;
        onAvance && onAvance(lect.length, p.coords.accuracy, seg);
        if ((buenas >= 4 && seg >= 5) || seg >= 20) fin();
      }, (e) => {
        ultimoError = e;
        if (e.code === 1) { terminado = true; navigator.geolocation.clearWatch(id); clearTimeout(tope); clearInterval(pulso); rej(new Error("Permiso de ubicación negado. Actívalo en la configuración del navegador.")); }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      const pulso = setInterval(() => { const seg = (Date.now() - t0) / 1000; onAvance && onAvance(lect.length, lect.length ? lect[lect.length - 1].acc : NaN, seg); }, 1000);
      const tope = setTimeout(fin, 20000);
      function fin() {
        if (terminado) return; terminado = true;
        navigator.geolocation.clearWatch(id); clearTimeout(tope); clearInterval(pulso);
        if (!lect.length) { rej(new Error(ultimoError && ultimoError.code === 1 ? "Permiso de ubicación negado." : "No llegó ninguna lectura del GPS. Sal a cielo abierto, espera unos segundos e intenta de nuevo.")); return; }
        let usar = lect.filter((l) => l.acc <= 15); const dudoso = !usar.length;
        if (dudoso) usar = [lect.reduce((a, b) => (a.acc < b.acc ? a : b))];
        let sw = 0, sla = 0, slo = 0; usar.forEach((l) => { const w = 1 / (l.acc * l.acc); sw += w; sla += w * l.lat; slo += w * l.lon; });
        const accs = usar.map((l) => l.acc).sort((a, b) => a - b);
        res({ lat: +(sla / sw).toFixed(7), lon: +(slo / sw).toFixed(7), precision: Math.round(accs[Math.floor(accs.length / 2)] * 10) / 10, n: usar.length, dudoso });
      }
    });
  }

  // ---------------- Geometría ----------------
  function aMetros(v, lat0, lon0) { return [((v.lon - lon0) * Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180), ((v.lat - lat0) * Math.PI / 180) * R]; }
  function geom(vs) {
    if (vs.length < 2) return { a: 0, p: 0, xy: vs.map(() => [0, 0]) };
    const lat0 = vs.reduce((s, v) => s + v.lat, 0) / vs.length, lon0 = vs.reduce((s, v) => s + v.lon, 0) / vs.length;
    const xy = vs.map((v) => aMetros(v, lat0, lon0)); let s = 0, p = 0;
    for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; s += x1 * y2 - x2 * y1; if (vs.length > 2 || i === 0) p += Math.hypot(x2 - x1, y2 - y1); }
    return { a: vs.length >= 3 ? Math.abs(s) / 2 : 0, p, xy };
  }
  function seCruza(xy) {
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])); const n = xy.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue; const a = xy[i], b = xy[(i + 1) % n], c = xy[j], d = xy[(j + 1) % n]; if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true; }
    return false;
  }

  // ---------------- Inicio ----------------
  async function pintarInicio() {
    const c = await todos("cola");
    const resp = c.filter((i) => i.tipo === "productor").pop();
    const area = c.filter((i) => i.tipo === "parcela").pop();
    const fichas = c.filter((i) => i.tipo === "evaluacion");
    const pend = await contarPendientes();
    $("sResp").textContent = resp ? `${resp.datos.nombre} · ${resp.estado}` : "Pendiente";
    $("sArea").textContent = area ? `${(area.datos.area_m2 || 0).toFixed(0)} m² · ${area.estado}` : "Pendiente";
    $("sFicha").textContent = `${fichas.length} ficha(s) · ${(await todos("fotos")).length} foto(s)`;
    $("sEnviar").textContent = pend ? `${pend} por enviar` : "Todo enviado";
    const pasos = document.querySelectorAll(".paso");
    pasos[0].classList.toggle("hecho", !!resp); pasos[1].classList.toggle("hecho", !!area); pasos[2].classList.toggle("hecho", fichas.length > 0); pasos[3].classList.toggle("hecho", !pend && c.length > 0);
    pintarMision();
  }
  function fmt(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), x = s % 60; return String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0"); }
  function pintarMision() {
    const m = S.mision;
    if (!m) { $("tMision").textContent = "00:00"; $("tMisionTxt").textContent = "Inicia al salir del salón"; $("bMision").textContent = "Iniciar salida"; return; }
    if (m.fin) { $("tMision").textContent = fmt((new Date(m.fin) - new Date(m.inicio)) / 1000); $("tMisionTxt").textContent = "Misión terminada"; $("bMision").textContent = "Nueva misión"; return; }
    $("tMision").textContent = fmt((Date.now() - new Date(m.inicio)) / 1000); $("tMisionTxt").textContent = "En campo · termina al regresar"; $("bMision").textContent = "Terminar al regresar";
  }
  setInterval(() => { if (S.mision && !S.mision.fin && !$("pInicio").hidden) pintarMision(); }, 1000);
  $("bMision").addEventListener("click", async () => {
    if (!S.mision || S.mision.fin) { S.mision = { inicio: ahora() }; await kvSet("mision", S.mision); toast("Misión iniciada"); }
    else { S.mision.fin = ahora(); await kvSet("mision", S.mision); const d = (new Date(S.mision.fin) - new Date(S.mision.inicio)) / 1000;
      await encolar("metrica", { tarea: "mision", inicio: S.mision.inicio, fin: S.mision.fin, duracion_s: Math.round(d), errores: 0, extra: { fuente: "app" } }, "Tiempo: misión"); toast("Misión terminada: " + fmt(d)); }
    pintarMision();
  });

  // ---------------- 1 Responsable ----------------
  $("bResp").addEventListener("click", async () => {
    const nombre = $("rNombre").value.trim(), com = $("rComunidad").value.trim();
    if (!$("rDatos").checked) { errorTarea("consentimiento"); msg("mResp", "error", "Sin autorización para registrar datos no se guarda nada. Pregunta de nuevo o termina la visita con respeto."); return; }
    if (!nombre || !com) { errorTarea("consentimiento"); msg("mResp", "error", "Escribe el nombre y la comunidad o lugar."); return; }
    const d = { nombre, comunidad: com, lengua: $("rLengua").value, autoriza_datos: true, autoriza_foto: $("rFotos").checked, autoriza_publicacion: $("rPub").checked };
    const it = await encolar("productor", d, "Responsable: " + nombre);
    await kvSet("productor_uuid", it.uuid);
    await terminarTarea("consentimiento");
    msg("mResp", "ok", "Guardado en el teléfono."); setTimeout(() => ir("pInicio"), 700);
  });

  // ---------------- 2 Área ----------------
  function dibujarArea() {
    const vs = S.borradorArea, g = geom(vs), svg = $("aCroquis"); let h = "";
    for (let x = 0; x <= 320; x += 32) h += `<line x1="${x}" y1="0" x2="${x}" y2="220" stroke="currentColor" stroke-opacity=".12"/>`;
    for (let y = 0; y <= 220; y += 32) h += `<line x1="0" y1="${y}" x2="320" y2="${y}" stroke="currentColor" stroke-opacity=".12"/>`;
    if (vs.length) {
      const xs = g.xy.map((p) => p[0]), ys = g.xy.map((p) => p[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      const span = Math.max(maxx - minx, maxy - miny, 10), k = 180 / span, cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
      const pt = g.xy.map(([x, y]) => [160 + (x - cx) * k, 110 - (y - cy) * k]);
      if (pt.length >= 3) h += `<polygon points="${pt.map((p) => p.join(",")).join(" ")}" fill="#F0B429" fill-opacity=".4" stroke="#C8820A" stroke-width="2.5"/>`;
      else if (pt.length === 2) h += `<line x1="${pt[0][0]}" y1="${pt[0][1]}" x2="${pt[1][0]}" y2="${pt[1][1]}" stroke="#C8820A" stroke-width="2.5"/>`;
      pt.forEach((p, i) => { h += `<circle cx="${p[0]}" cy="${p[1]}" r="${Math.min(30, vs[i].precision * k) + 0}" fill="#1D4ED8" fill-opacity=".12"/><circle cx="${p[0]}" cy="${p[1]}" r="10" fill="${vs[i].dudoso ? "#A83220" : "#3D2208"}"/><text x="${p[0]}" y="${p[1] + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${i + 1}</text>`; });
      h += `<text x="8" y="212" font-size="10" fill="currentColor" opacity=".7">ancho del dibujo ≈ ${Math.round(320 / k)} m</text>`;
    } else h += `<text x="160" y="114" text-anchor="middle" font-size="13" fill="currentColor" opacity=".6">Toma la primera esquina</text>`;
    svg.innerHTML = h;
    $("aHa").textContent = (g.a / 10000).toFixed(3); $("aM2").textContent = Math.round(g.a); $("aPer").textContent = Math.round(g.p); $("aN").textContent = vs.length;
    kvSet("borradorArea", vs);
  }
  $("bEsquina").addEventListener("click", async () => {
    iniciarTarea("area"); const b = $("bEsquina"); b.disabled = true;
    try {
      const p = await tomarPunto((n, acc, seg) => { b.textContent = `Midiendo… ${n} lecturas${isNaN(acc) ? "" : " · ±" + Math.round(acc) + " m"} · ${Math.round(seg)} s`; });
      S.borradorArea.push({ lat: p.lat, lon: p.lon, precision: p.precision, n: p.n, dudoso: p.dudoso });
      msg("mArea", p.dudoso ? "aviso" : "ok", p.dudoso ? `Esquina ${S.borradorArea.length} guardada con precisión baja (±${p.precision} m). Si puedes, muévete a un lugar despejado y repítela.` : `Esquina ${S.borradorArea.length}: ±${p.precision} m con ${p.n} lecturas.`);
      dibujarArea();
    } catch (e) { errorTarea("area"); msg("mArea", "error", e.message); }
    b.disabled = false; b.textContent = "Tomar esquina";
  });
  $("bManual").addEventListener("click", () => {
    const la = parseFloat($("aLat").value), lo = parseFloat($("aLon").value);
    if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180)) { errorTarea("area"); msg("mArea", "error", "Coordenadas no válidas. En México la longitud es negativa (oeste)."); return; }
    iniciarTarea("area"); S.borradorArea.push({ lat: la, lon: lo, precision: 10, n: 1, manual: true }); $("aLat").value = ""; $("aLon").value = ""; dibujarArea();
  });
  $("bDeshacer").addEventListener("click", () => { S.borradorArea.pop(); msg("mArea"); dibujarArea(); });
  $("bBorrarArea").addEventListener("click", () => { S.borradorArea = []; msg("mArea"); dibujarArea(); });
  $("bArea").addEventListener("click", async () => {
    const vs = S.borradorArea;
    if (vs.length < 3) { errorTarea("area"); msg("mArea", "error", "Un área necesita al menos 3 esquinas."); return; }
    const g = geom(vs);
    if (seCruza(g.xy)) { errorTarea("area"); msg("mArea", "error", "Las orillas se cruzan (forma de moño). Borra y toma las esquinas en orden, siguiendo la orilla."); return; }
    if (g.a < 5) { errorTarea("area"); msg("mArea", "error", "El área es menor a 5 m². ¿Tomaste todas las esquinas?"); return; }
    const prod = await kvGet("productor_uuid");
    const d = { productor_uuid: prod || null, vertices: vs.map((v) => [v.lat, v.lon]), precision_media_m: Math.round(vs.reduce((s, v) => s + v.precision, 0) / vs.length * 10) / 10, area_m2: g.a, fuente: vs.some((v) => v.manual) ? "app_manual" : "app_gps" };
    await encolar("parcela", d, `Área: ${Math.round(g.a)} m² · ${vs.length} esquinas`);
    await terminarTarea("area", { n_vertices: vs.length, area_m2: Math.round(g.a), precision_media_m: d.precision_media_m });
    S.borradorArea = []; await kvSet("borradorArea", []);
    msg("mArea", "ok", `Área guardada: ${Math.round(g.a)} m² (${(g.a / 10000).toFixed(3)} ha), perímetro ${Math.round(g.p)} m.`); dibujarArea();
    setTimeout(() => ir("pInicio"), 900);
  });

  // ---------------- 3 Ficha ----------------
  function campoHTML(c) {
    const req = c.requerido ? " *" : "";
    if (c.tipo === "lista") return `<label>${esc(c.etiqueta)}${req}<select id="c_${c.id}"><option value="">Elige…</option>${c.opciones.map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>`;
    if (c.tipo === "numero" || c.tipo === "entero") return `<label>${esc(c.etiqueta)}${req}<input id="c_${c.id}" inputmode="${c.tipo === "entero" ? "numeric" : "decimal"}"></label>`;
    return `<label>${esc(c.etiqueta)}${req}<input id="c_${c.id}" autocomplete="off"></label>`;
  }
  function nuevaFicha() {
    const f = S.config.ficha; $("fTitulo").textContent = f.titulo;
    $("fCampos").innerHTML = f.campos.map(campoHTML).join("");
    S.ficha = { uuid: uid(), ubic: null, fotos: [] }; $("fUbic").textContent = "Sin tomar"; $("fMinis").innerHTML = ""; msg("mFicha");
    iniciarTarea("ficha"); pintarFichas();
  }
  async function pintarFichas() {
    const c = (await todos("cola")).filter((i) => i.tipo === "evaluacion");
    const f = S.config.ficha.campos;
    $("fLista").innerHTML = c.length ? c.map((i) => `<li><span>${esc(i.resumen)}</span><span class="est ${i.estado}">${i.estado}</span></li>`).join("") : `<li><span class="muted">Aún no hay fichas.</span></li>`;
  }
  $("bUbic").addEventListener("click", async () => {
    const b = $("bUbic"); b.disabled = true;
    try {
      const p = await tomarPunto((n, acc, seg) => { b.textContent = `${n} lecturas · ${Math.round(seg)} s`; });
      S.ficha.ubic = p; $("fUbic").textContent = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} · ±${p.precision} m${p.dudoso ? " (baja)" : ""}`;
    } catch (e) { errorTarea("ficha"); msg("mFicha", "error", e.message); }
    b.disabled = false; b.textContent = "Tomar ubicación";
  });
  function reducir(file, max) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const im = new Image();
      im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob((b) => (b ? res(b) : rej(new Error("No se pudo procesar la foto"))), "image/jpeg", 0.82); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("No se pudo leer la foto")); }; im.src = url;
    });
  }
  $("fFoto").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    const prodU = await kvGet("productor_uuid"); const cola = await todos("cola");
    const prod = cola.find((i) => i.uuid === prodU);
    if (prod && !prod.datos.autoriza_foto) { errorTarea("ficha"); msg("mFicha", "error", "El responsable no autorizó fotos. No se pueden guardar."); return; }
    try {
      const blob = await reducir(file, 1280);
      const pos = ultima ? { lat: ultima.coords.latitude, lon: ultima.coords.longitude, acc: ultima.coords.accuracy } : null;
      S.ficha.fotos.push({ blob, tipo: $("fTipo").value, pos, capturado: ahora() });
      const u = URL.createObjectURL(blob); $("fMinis").insertAdjacentHTML("beforeend", `<img src="${u}" alt="Foto ${S.ficha.fotos.length}">`);
      msg("mFicha", "ok", `${S.ficha.fotos.length} foto(s) lista(s) (${Math.round(blob.size / 1024)} KB la última).`);
    } catch (err) { errorTarea("ficha"); msg("mFicha", "error", err.message); }
  });
  $("bFicha").addEventListener("click", async () => {
    const f = S.config.ficha; const campos = {}; const errores = [];
    for (const c of f.campos) {
      let v = $("c_" + c.id).value.trim();
      if (!v) { if (c.requerido) errores.push(`Falta ${c.etiqueta.toLowerCase()}.`); continue; }
      if (c.tipo === "numero" || c.tipo === "entero") {
        const n = Number(v.replace(",", "."));
        if (isNaN(n)) { errores.push(`${c.etiqueta}: escribe un número.`); continue; }
        if (c.tipo === "entero" && !Number.isInteger(n)) { errores.push(`${c.etiqueta}: debe ser entero.`); continue; }
        if (n < c.min || n > c.max) { errores.push(`${c.etiqueta}: entre ${c.min} y ${c.max}.`); continue; }
        v = n;
      }
      campos[c.id] = v;
    }
    if (errores.length) { errorTarea("ficha"); msg("mFicha", "error", errores.join(" ")); return; }
    if (!S.ficha.ubic) { errorTarea("ficha"); msg("mFicha", "error", "Toma la ubicación del elemento antes de guardar."); return; }
    const avisos = [];
    f.campos.forEach((c) => { const v = campos[c.id]; if (v == null) return; if (c.aviso_par && v % 2 === 1) avisos.push(`${c.etiqueta}: casi siempre es par.`); if (c.aviso_min != null && (v < c.aviso_min || v > c.aviso_max)) avisos.push(`${c.etiqueta}: poco común.`); });
    const prod = await kvGet("productor_uuid"); const cola = await todos("cola"); const parc = cola.filter((i) => i.tipo === "parcela").pop();
    const u = S.ficha.ubic;
    const etiqueta = campos.nombre_comun || campos.color_grano || "Ficha";
    await encolar("evaluacion", { uuid: S.ficha.uuid, productor_uuid: prod || null, parcela_uuid: parc ? parc.uuid : null, plantilla: S.config.plantilla, campos, latitud: u.lat, longitud: u.lon, precision_m: u.precision, n_lecturas: u.n }, `Ficha: ${etiqueta}`);
    for (const ft of S.ficha.fotos) {
      await poner("fotos", { uuid: uid(), evaluacion_uuid: S.ficha.uuid, tipo: ft.tipo, blob: ft.blob, latitud: ft.pos ? ft.pos.lat : u.lat, longitud: ft.pos ? ft.pos.lon : u.lon, precision_m: ft.pos ? ft.pos.acc : u.precision, capturado: ft.capturado, estado: "pendiente", motivo: "" });
    }
    await terminarTarea("ficha", { n_fotos: S.ficha.fotos.length, precision_m: u.precision, avisos: avisos.length });
    await contarPendientes();
    msg("mFicha", avisos.length ? "aviso" : "ok", (avisos.length ? avisos.join(" ") + " Se guardó y quedará marcada para revisión. " : "") + `Ficha guardada con ${S.ficha.fotos.length} foto(s). Puedes registrar otra.`);
    if (navigator.onLine) setTimeout(() => sincronizar(false), 500);
    const m = $("mFicha").innerHTML; nuevaFicha(); $("mFicha").innerHTML = m;
  });

  // ---------------- 4 Enviar ----------------
  $("bSync").addEventListener("click", () => sincronizar(true));

  // ---------------- Problemas ----------------
  let volverA = "pInicio";
  function abrirProblema() { volverA = document.querySelector(".pantalla:not([hidden])").id; ir("pProblema"); }
  $("bProblema").addEventListener("click", abrirProblema); $("bProblema2").addEventListener("click", abrirProblema);
  $("bVolverProb").addEventListener("click", () => ir(volverA === "pProblema" ? "pInicio" : volverA));
  $("bProb").addEventListener("click", async () => {
    const t = $("pTexto").value.trim(); if (!t) { msg("mProb", "error", "Escribe qué pasó."); return; }
    await encolar("incidencia", { pantalla: $("pPantalla").value, texto: t }, "Problema: " + t.slice(0, 40));
    $("pTexto").value = ""; msg("mProb", "ok", "Reporte guardado. Gracias."); setTimeout(() => ir(volverA === "pProblema" ? "pInicio" : volverA), 800);
  });

  // ---------------- Cronometrista ----------------
  const TAREAS_CRONO = [["consentimiento", "Responsable y permiso"], ["area", "Levantar el área"], ["ficha", "Una ficha con fotos"], ["sincronizacion", "Sincronizar"], ["mision", "Misión completa"]];
  function pintarCrono() {
    $("cTareas").innerHTML = TAREAS_CRONO.map(([k, n]) => { const c = S.cron[k]; const t = c && c.inicio ? fmt(((c.fin ? new Date(c.fin) : new Date()) - new Date(c.inicio)) / 1000) : "00:00";
      return `<div class="crono"><span>${n}</span><span class="t" id="ct_${k}">${t}</span><button data-crono="${k}" class="${c && c.inicio && !c.fin ? "acc" : ""}">${c && c.inicio && !c.fin ? "Terminar" : "Iniciar"}</button></div>`; }).join("");
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-crono]"); if (!b) return; const k = b.dataset.crono; const c = S.cron[k];
    if (!c || c.fin) S.cron[k] = { inicio: ahora() };
    else { c.fin = ahora(); await encolar("metrica", { tarea: k, inicio: c.inicio, fin: c.fin, duracion_s: Math.round((new Date(c.fin) - new Date(c.inicio)) / 1000), errores: 0, extra: { fuente: "cronometrista" } }, "Cronómetro: " + k); toast("Tiempo guardado"); }
    await kvSet("cron", S.cron); pintarCrono();
  });
  setInterval(() => { if (!$("cronometro").hidden) TAREAS_CRONO.forEach(([k]) => { const c = S.cron[k]; if (c && c.inicio && !c.fin) $("ct_" + k).textContent = fmt((Date.now() - new Date(c.inicio)) / 1000); }); }, 1000);

  // ---------------- Sesión ----------------
  $("bLogin").addEventListener("click", async () => {
    const usuario = $("lUsuario").value.trim().toLowerCase(), codigo = $("lCodigo").value.trim();
    if (!usuario || !codigo) { msg("mLogin", "error", "Escribe usuario y código."); return; }
    try {
      $("bLogin").disabled = true;
      const s = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario, codigo }) });
      S.sesion = s; await kvSet("sesion", s);
      S.config = await api("/api/config"); await kvSet("config", S.config);
      entrar();
    } catch (e) { msg("mLogin", "error", navigator.onLine ? e.message : "Necesitas internet para entrar la primera vez."); }
    $("bLogin").disabled = false;
  });
  async function salir() {
    const n = await contarPendientes();
    if (n && !confirmarSalir) { confirmarSalir = true; toast(`Tienes ${n} registro(s) sin enviar. Toca otra vez para salir de todos modos.`); setTimeout(() => (confirmarSalir = false), 5000); return; }
    S.sesion = null; await kvSet("sesion", null); location.reload();
  }
  let confirmarSalir = false;
  $("bSalir").addEventListener("click", salir); $("bSalir2").addEventListener("click", salir);

  function entrar() {
    const s = S.sesion, eq = (S.config.equipos || []).find((e) => e.id === s.equipo);
    $("hEquipo").textContent = (eq ? eq.nombre : s.equipo || "Organización") + " · " + s.rol_nombre;
    $("hOrg").textContent = S.config.organizacion;
    $("sAreaTit").textContent = S.config.ficha.area;
    $("aTitulo").textContent = "Levantar: " + S.config.ficha.area.toLowerCase();
    if (s.rol === "tecnico" || s.rol === "admin") { ir("pInicio"); }
    else {
      ir("pOtroRol"); $("oTitulo").textContent = s.rol_nombre;
      const textos = { productor: "Acompaña al técnico: autoriza qué se registra y recorre la orilla. Después revisa tu ficha en la plataforma web.", investigador: "Tu trabajo es en la plataforma web: revisa y valida las fichas de tu equipo cuando lleguen.", analista: "Tu trabajo es en la plataforma web: exporta el CSV y analiza los datos en Google Colab.", cronometrista: "Mide cuánto tarda tu equipo en cada tarea y anota los problemas que observes." };
      $("oTexto").textContent = textos[s.rol] || "";
      $("cronometro").hidden = s.rol !== "cronometrista"; if (s.rol === "cronometrista") pintarCrono();
    }
    pintarRed(); contarPendientes();
  }

  // ---------------- Arranque ----------------
  (async function () {
    await abrirDB();
    S.sesion = await kvGet("sesion"); S.config = await kvGet("config"); S.mision = (await kvGet("mision")) || null;
    S.borradorArea = (await kvGet("borradorArea")) || []; S.cron = (await kvGet("cron")) || {};
    pintarRed();
    if (S.sesion && S.config) {
      entrar();
      if (navigator.onLine) api("/api/config").then((c) => { S.config = c; kvSet("config", c); }).catch(() => {});
    } else ir("pLogin");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "/movil/" }).catch(() => {});
  })();
})();
