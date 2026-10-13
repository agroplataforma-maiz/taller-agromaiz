/* Agroplataforma · tablero web del taller */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let sesion = null, config = null, datos = null, tab = "inicio", mapa = null, capa = null, ajustado = false; try { sesion = JSON.parse(localStorage.getItem("agro-web-sesion") || "null"); } catch (e) { sesion = null; }

  let tt; function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), 2800); }

  async function api(ruta, op = {}) {
    const h = { ...(op.headers || {}) };

    if (sesion) {
      h.Authorization = "Bearer " + sesion.token;
    }

    const r = await fetch(ruta, { ...op, headers: h });

    let c = null;
    try {
      c = await r.json();
    } catch (e) {
      // La respuesta puede no contener JSON.
    }

    if (!r.ok) {
      const mensaje =
        (c && (c.error || c.detail || c.mensaje)) ||
        "Error " + r.status;

      const error = new Error(
        typeof mensaje === "string"
          ? mensaje
          : JSON.stringify(mensaje)
      );

      error.status = r.status;
      throw error;
    }

    return c;
  }

  const fmt = (s) => { if (s == null) return "—"; s = Math.round(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const eqNombre = (id) => { const e = config.equipos.find((x) => x.id === id); return e ? e.nombre : id; };
  const eqColor = (id) => { const e = config.equipos.find((x) => x.id === id); return e ? e.color : "#888"; };
  const rol = () => (sesion ? sesion.rol : "invitado");


  // ---------- navegación ----------
  const titulosTab = {
    inicio: "Inicio",
    mapa: "Mapa",
    fichas: "Fichas",
    evidencias: "Evidencias",
    metricas: "Métricas de uso",
    exportar: "Exportar información",
    admin: "Administración"
  };

  function cerrarMenuMovil() {
    $("sidebar").classList.remove("abierto");
    const overlay = document.querySelector(".menu-overlay");
    if (overlay) overlay.hidden = true;
    $("bMenu").setAttribute("aria-expanded", "false");
  }

  function setTab(t) {
    const boton = document.querySelector(`.sidebar-nav [data-tab="${t}"]`);

    // No permitir navegar a secciones que el rol no tiene habilitadas.
    if (!boton || boton.hidden) t = "inicio";

    tab = t;

    document.querySelectorAll(".sidebar-nav [data-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === t));
    });

    document.querySelectorAll("[data-panel]").forEach((p) => {
      p.hidden = p.dataset.panel !== t;
    });

    $("tituloSeccion").textContent = titulosTab[t] || "Agroplataforma";

    cerrarMenuMovil();

    if (t === "mapa" && mapa) {
      setTimeout(() => mapa.invalidateSize(), 100);
    }

    if (t === "metricas") cargarMetricas();
    if (t === "admin") cargarAdmin();
  }

  // La barra lateral y las tarjetas de Inicio comparten navegación.
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  });

  // Menú adaptable para móvil.
  const overlayMenu = document.createElement("div");
  overlayMenu.className = "menu-overlay";
  overlayMenu.hidden = true;
  document.getElementById("appTaller").appendChild(overlayMenu);

  $("bMenu").addEventListener("click", () => {
    const abierto = $("sidebar").classList.toggle("abierto");
    overlayMenu.hidden = !abierto;
    $("bMenu").setAttribute("aria-expanded", String(abierto));
  });

  overlayMenu.addEventListener("click", cerrarMenuMovil);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cerrarMenuMovil();
  });

  // ---------- sesión ----------

  // Mostrar u ocultar el código de acceso.
  $("bVerCodigo").addEventListener("click", () => {
    const campo = $("wCodigo");
    const boton = $("bVerCodigo");
    const mostrar = campo.type === "password";

    campo.type = mostrar ? "text" : "password";
    boton.textContent = mostrar ? "Ocultar" : "Mostrar";
    boton.setAttribute(
      "aria-label",
      mostrar ? "Ocultar código de acceso" : "Mostrar código de acceso"
    );
    boton.setAttribute("aria-pressed", String(mostrar));
  });

  $("fLogin").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const s = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: $("wUsuario").value.trim().toLowerCase(), codigo: $("wCodigo").value.trim() }) });
      sesion = s; try { localStorage.setItem("agro-web-sesion", JSON.stringify(s)); } catch (er) { /* */ }
      $("wCodigo").value = "";
      $("wCodigo").type = "password";
      $("bVerCodigo").textContent = "Mostrar";
      $("bVerCodigo").setAttribute("aria-label", "Mostrar código de acceso");
      $("bVerCodigo").setAttribute("aria-pressed", "false");
      setTab("inicio");
      pintarSesion();
      ajustado = false;
      await cargar();
      toast("Hola, " + s.rol_nombre.toLowerCase());
    } catch (er) { toast(er.message); }
  });
  $("bSalir").addEventListener("click", () => { sesion = null; try { localStorage.removeItem("agro-web-sesion"); } catch (e) { /* */ } pintarSesion(); ajustado = false; cargar(); });

  function pintarSesion() {
    $("pantallaLogin").hidden = !!sesion;
    $("appTaller").hidden = !sesion;

    $("fLogin").hidden = false;
    $("quien").hidden = !sesion;

    if (sesion) {
      $("quienTxt").textContent =
        `${sesion.usuario} · ${sesion.rol_nombre}` +
        (sesion.equipo ? " · " + eqNombre(sesion.equipo) : "");

      $("sbNombre").textContent = sesion.usuario;
      $("sbRol").textContent = sesion.rol_nombre || sesion.rol;
      $("sbAvatar").textContent =
        (sesion.usuario || "A").charAt(0).toUpperCase();
    } else {
      $("sbNombre").textContent = "Usuario";
      $("sbRol").textContent = "Sin sesión";
      $("sbAvatar").textContent = "A";
    }

    const r = rol();

    $("tabAdmin").hidden = r !== "admin";
    $("inicioAdmin").hidden = r !== "admin";

    const puedeExportar = ["admin", "analista", "investigador"].includes(r);
    const puedeVerMetricas =
      ["admin", "analista", "investigador", "cronometrista"].includes(r);

    document.querySelector('[data-tab="exportar"]').hidden = !puedeExportar;
    document.querySelector('[data-tab="metricas"]').hidden = !puedeVerMetricas;

    // Las tarjetas de Inicio respetan los mismos permisos del menú.
    document.querySelectorAll(".modulo-card[data-tab]").forEach((card) => {
      const destino = document.querySelector(
        `.sidebar-nav [data-tab="${card.dataset.tab}"]`
      );

      card.hidden = !destino || destino.hidden;
    });

    // Si la sección actual deja de estar permitida, volver a Inicio.
    const actual = document.querySelector(`.sidebar-nav [data-tab="${tab}"]`);
    if (!actual || actual.hidden) {
      setTab("inicio");
    } else {
      setTab(tab);
    }
  }

  // ---------- datos ----------
  async function cargar() {
    try { datos = await api("/api/datos"); }
    catch (e) { if (e.status === 401) { sesion = null; try { localStorage.removeItem("agro-web-sesion"); } catch (er) { /* */ } pintarSesion(); datos = await api("/api/datos"); } else { $("aviso").textContent = "No se pudo leer el servidor. Se reintentará en unos segundos."; return; } }
    $("aviso").textContent = rol() === "invitado" ? "Vista de invitado: solo zonas generales y conteos. Entra con tu usuario para ver más." : "";
    pintarKpis(); pintarMapa(); pintarFichas(); pintarGaleria();
  }
  function pintarKpis() {
    let k;
    if (datos.rol === "invitado") {
      const r = datos.resumen; k = [[r.length, "equipos"], [r.reduce((s, x) => s + x.fichas, 0), "fichas"], [r.reduce((s, x) => s + x.areas, 0), "áreas levantadas"], [r.reduce((s, x) => s + x.ha, 0).toFixed(2), "hectáreas"]];
    } else {
      const ha = datos.parcelas.reduce((s, p) => s + (p.area_ha || 0), 0), val = datos.evaluaciones.filter((e) => e.validacion === "validada").length;
      k = [[datos.productores.length, "responsables"], [datos.parcelas.length, "áreas · " + (ha * 10000).toFixed(0) + " m²"], [datos.evaluaciones.length, "fichas · " + val + " validadas"], [datos.evidencias.length, "fotos"]];
    }
    $("kpis").innerHTML = k.map((x) => `<div class="kpi"><b>${x[0]}</b><span>${x[1]}</span></div>`).join("");
  }

  function iniciarMapa() {
    mapa = L.map("mapa", { zoomControl: true }).setView([config.sede.lat, config.sede.lon], 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    capa = L.layerGroup().addTo(mapa);
  }
  function pintarMapa() {
    if (!mapa) iniciarMapa();
    capa.clearLayers(); const b = [];
    if (datos.rol === "invitado") {
      datos.resumen.forEach((r) => { if (!r.zona) return; L.circle(r.zona, { radius: 40, color: r.color, fillOpacity: 0.25 }).bindPopup(`<b>${esc(r.nombre)}</b><br>${r.fichas} fichas`).addTo(capa); b.push(r.zona); });
      $("notaMapa").textContent = "Cada círculo es la zona general de un equipo (sin ubicación exacta).";
    } else {
      datos.parcelas.forEach((p) => { const ll = p.vertices.map((v) => [v[0], v[1]]); L.polygon(ll, { color: eqColor(p.equipo), weight: 2, fillOpacity: 0.3 }).bindPopup(`<b>${esc(eqNombre(p.equipo))}</b><br>${Math.round(p.area_ha * 10000)} m² · ${Math.round(p.perimetro_m)} m de perímetro<br>Precisión media ±${p.precision_media_m ?? "—"} m`).addTo(capa); b.push(...ll); });
      datos.evaluaciones.forEach((e) => {
        if (e.latitud == null) return;
        const foto = datos.evidencias.find((f) => f.evaluacion_uuid === e.uuid);
        const nombre = e.datos.nombre_comun || e.datos.color_grano || "Ficha";
        L.circleMarker([e.latitud, e.longitud], { radius: 7, color: "#fff", weight: 2, fillColor: eqColor(e.equipo), fillOpacity: 1 })
          .bindPopup(`<b>${esc(nombre)}</b><br>${esc(eqNombre(e.equipo))}<br>±${e.precision_m ?? "—"} m · ${esc(e.validacion)}${foto ? `<img class="popfoto" src="/api/foto/${foto.uuid}?token=${encodeURIComponent(sesion.token)}" alt="">` : ""}`).addTo(capa);
        b.push([e.latitud, e.longitud]);
      });
      $("notaMapa").textContent = "Polígonos: áreas levantadas caminando. Puntos: fichas, con su foto al tocarlas.";
    }
    if (b.length && !ajustado) { mapa.fitBounds(b, { padding: [30, 30], maxZoom: 19 }); ajustado = true; }
  }

  function pintarFichas() {
    if (datos.rol === "invitado") { $("tFichas").innerHTML = `<tr><td class="muted">Entra con tu usuario para ver las fichas.</td></tr>`; return; }
    const campos = config.ficha.campos.filter((c) => c.id !== "notas");
    const puede = (e) => rol() === "admin" || (rol() === "investigador" && e.equipo === sesion.equipo);
    $("tFichas").innerHTML = `<tr><th>Equipo</th>${campos.map((c) => `<th>${esc(c.etiqueta)}</th>`).join("")}<th>Precisión</th><th>Fotos</th><th>Avisos</th><th>Estado</th><th></th></tr>` +
      (datos.evaluaciones.length ? datos.evaluaciones.map((e) => {
        const nf = datos.evidencias.filter((f) => f.evaluacion_uuid === e.uuid).length;
        return `<tr><td><span class="dot" style="background:${eqColor(e.equipo)}"></span>${esc(eqNombre(e.equipo))}</td>${campos.map((c) => `<td>${esc(e.datos[c.id] ?? "")}</td>`).join("")}<td>±${e.precision_m ?? "—"} m</td><td>${nf}</td><td>${e.advertencias.length ? "⚠ " + esc(e.advertencias.join(" ")) : ""}</td>
          <td><span class="est ${e.validacion.replace(" ", "")}">${esc(e.validacion)}</span>${e.motivo ? `<br><small class="muted">${esc(e.motivo)}</small>` : ""}</td>
          <td>${puede(e) ? `<button class="chico" data-val="${e.uuid}" data-est="validada">Validar</button> <button class="chico" data-val="${e.uuid}" data-est="corregir">Corregir</button>` : ""}</td></tr>`;
      }).join("") : `<tr><td colspan="${campos.length + 6}" class="muted">Aún no llegan fichas. Se actualiza solo cada 15 segundos.</td></tr>`);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-val]"); if (!b) return;
    let motivo = "";
    if (b.dataset.est === "corregir") {
      const fila = b.closest("td"); if (!fila.querySelector("input")) { fila.insertAdjacentHTML("beforeend", `<div class="fila" style="margin-top:4px"><input placeholder="¿Qué hay que corregir?" aria-label="Motivo"><button class="chico" data-val="${b.dataset.val}" data-est="corregir">Enviar</button></div>`); return; }
      motivo = fila.querySelector("input").value.trim(); if (!motivo) { toast("Escribe qué hay que corregir"); return; }
    }
    try { await api(`/api/evaluaciones/${b.dataset.val}/validacion`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estado: b.dataset.est, motivo }) }); toast(b.dataset.est === "validada" ? "Ficha validada" : "Se pidió corrección"); cargar(); }
    catch (er) { toast(er.message); }
  });

  function pintarGaleria() {
    if (datos.rol === "invitado") { $("galeria").innerHTML = `<p class="muted">Las fotos solo se ven con usuario.</p>`; return; }
    $("galeria").innerHTML = datos.evidencias.length ? datos.evidencias.map((f) => {
      const e = datos.evaluaciones.find((x) => x.uuid === f.evaluacion_uuid); const n = e ? (e.datos.nombre_comun || e.datos.color_grano || "") : "";
      return `<figure><img loading="lazy" src="/api/foto/${f.uuid}?token=${encodeURIComponent(sesion.token)}" alt="${esc(n)}"><figcaption><b>${esc(n)}</b> · ${esc(f.tipo)}<br>${esc(eqNombre(f.equipo))}</figcaption></figure>`;
    }).join("") : `<p class="muted">Aún no llegan fotos.</p>`;
  }

  // ---------- métricas ----------
  async function cargarMetricas() {
    try {
      const m = await api("/api/metricas"); const o = m.objetivos;
      const cel = (v, obj) => { if (v == null) return `<td>—</td>`; const c = v <= obj ? "ok" : v <= obj * 1.5 ? "medio" : "mal"; return `<td class="${c}">${fmt(v)}</td>`; };
      $("tMetricas").innerHTML = `<tr><th>Equipo</th><th>Misión</th><th>Permiso</th><th>Área</th><th>Ficha (prom.)</th><th>Sincronizar</th><th>Errores</th><th>Precisión GPS</th><th>Fichas</th><th>Validadas</th><th>Fotos</th><th>Área m²</th><th>Llegada (min)</th><th>Problemas</th></tr>` +
        m.equipos.map((e) => `<tr><td><span class="dot" style="background:${e.color}"></span>${esc(e.nombre)}</td>${cel(e.mision.media_s, o.mision)}${cel(e.consentimiento.media_s, o.consentimiento)}${cel(e.area.media_s, o.area)}${cel(e.ficha.media_s, o.ficha)}${cel(e.sincronizacion.media_s, o.sincronizacion)}
          <td>${e.consentimiento.errores + e.area.errores + e.ficha.errores}</td><td>${e.precision_gps_m != null ? "±" + e.precision_gps_m + " m" : "—"}</td><td>${e.fichas}</td><td>${e.validadas}</td><td>${e.fotos}</td><td>${Math.round(e.ha * 10000)}</td><td>${e.latencia_sync_min ?? "—"}</td><td>${e.incidencias}</td></tr>`).join("") +
        `<tr><td class="muted">Objetivo</td><td>${fmt(o.mision)}</td><td>${fmt(o.consentimiento)}</td><td>${fmt(o.area)}</td><td>${fmt(o.ficha)}</td><td>${fmt(o.sincronizacion)}</td><td colspan="8"></td></tr>`;
      const max = Math.max(o.mision * 1.6, ...m.equipos.map((e) => e.mision.media_s || 0));
      $("barras").innerHTML = m.equipos.map((e) => `<div class="barra"><span>${esc(e.nombre)}</span><div class="pista"><div class="valor" style="width:${((e.mision.media_s || 0) / max) * 100}%;background:${e.color}"></div><div class="meta" style="left:${(o.mision / max) * 100}%" title="objetivo"></div></div><span>${fmt(e.mision.media_s)}</span></div>`).join("") + `<p class="muted chico">La línea vertical marca el tiempo objetivo (${fmt(o.mision)}).</p>`;
      $("incidencias").innerHTML = m.incidencias.length ? m.incidencias.map((i) => `<li><b>${esc(eqNombre(i.equipo))}</b> · ${esc(i.pantalla)} · <span class="muted">${esc((i.capturado || "").slice(11, 16))}</span><br>${esc(i.texto)}</li>`).join("") : `<li class="muted">Sin problemas reportados.</li>`;
    } catch (e) { $("tMetricas").innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }
  }

  // ---------- exportar ----------
  async function descargar(ruta, nombre) {
    try {
      const r = await fetch(ruta, { headers: { Authorization: "Bearer " + sesion.token } }); if (!r.ok) throw new Error("No se pudo exportar (" + r.status + ")");
      const b = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = nombre; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    catch (e) { toast(e.message); }
  }
  $("xFichas").addEventListener("click", (e) => { e.preventDefault(); descargar("/api/export/fichas.csv", "fichas_taller.csv"); });
  $("xMetricas").addEventListener("click", (e) => { e.preventDefault(); descargar("/api/export/metricas.csv", "metricas_taller.csv"); });
  $("xGeo").addEventListener("click", (e) => { e.preventDefault(); descargar("/api/export/parcelas.geojson", "taller.geojson"); });

  // ---------- admin ----------
  async function cargarAdmin() {
    try {
      const u = await api("/api/admin/usuarios");
      $("tUsuarios").innerHTML = `<tr><th>Equipo</th><th>Usuario</th><th>Rol</th><th>Código</th></tr>` + u.map((x) => `<tr><td>${esc(x.nombre)}</td><td><b>${esc(x.usuario)}</b></td><td>${esc(config.roles[x.rol] || x.rol)}</td><td><b>${esc(x.codigo)}</b></td></tr>`).join("");
    } catch (e) { $("tUsuarios").innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }
  }
  $("bReiniciar").addEventListener("click", async () => {
    try {
      const r = await api("/api/admin/reiniciar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmar: $("confirma").value.trim() }) });
      toast("Listo. Respaldo en " + r.respaldo); $("confirma").value = ""; ajustado = false; cargar();
    }
    catch (e) { toast(e.message); }
  });

  // ---------- arranque ----------
  (async function () {
    try { config = await api("/api/config"); } catch (e) { $("aviso").textContent = "No se pudo conectar con el servidor."; return; }
    $("cOrg").textContent = config.organizacion; pintarSesion(); await cargar();
    setInterval(() => { if (document.visibilityState === "visible" && !document.activeElement.matches("input")) { cargar(); if (tab === "metricas") cargarMetricas(); } }, 15000);
  })();
})();
