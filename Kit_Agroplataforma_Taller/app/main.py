"""
Kit del taller · Agroplataforma (AgroMaíz, PEE-2025-G-369, TecNM – IT Ciudad Valles)

Servidor ligero para talleres de campo:
  * /movil/  aplicación web instalable (PWA) para el teléfono: trabaja sin conexión,
             toma coordenadas con el GPS, levanta polígonos, fichas y fotos, y sincroniza.
  * /web/    tablero de la plataforma: mapa, fichas, evidencias, validación, métricas y exportación.
  * /api/    servicios REST (JSON) que usan ambas.

Los nombres de tablas y campos siguen el modelo de datos de la Agroplataforma
(productor, parcela, ubicacion, evaluacion, evidencia, consentimiento) para facilitar
la migración posterior a la plataforma real.

Ejecutar:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Variables de entorno: ver README.md
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import secrets
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

VERSION = "1.0.0"
BASE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", BASE / "data"))
FOTOS = DATA / "fotos"
DB_PATH = DATA / "taller.db"
USUARIOS_CSV = DATA / "usuarios.csv"

PLANTILLA = os.environ.get("PLANTILLA", "campus")          # campus | maiz
N_EQUIPOS = int(os.environ.get("N_EQUIPOS", "12"))
ORGANIZACION = os.environ.get("ORGANIZACION", "UICSLP – Capacitación")
SEDE_LAT = float(os.environ.get("SEDE_LAT", "21.9850"))
SEDE_LON = float(os.environ.get("SEDE_LON", "-99.0130"))
ADMIN_CODIGO = os.environ.get("ADMIN_CODIGO", "")
MAX_FOTO_MB = float(os.environ.get("MAX_FOTO_MB", "8"))

DATA.mkdir(parents=True, exist_ok=True)
FOTOS.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# Equipos, roles y plantillas de ficha
# --------------------------------------------------------------------------
NOMBRES_CAMPUS = ["Ceiba", "Mango", "Naranjo", "Cafeto", "Cedro", "Palma",
                  "Zapote", "Guayabo", "Ojite", "Cacao", "Aguacate", "Jobo",
                  "Chaca", "Tamarindo", "Mamey", "Nogal"]
NOMBRES_MAIZ = ["Blanco", "Amarillo", "Rojo", "Morado", "Pinto", "Negro",
                "Anaranjado", "Rosado", "Guindo", "Azul", "Crema", "Vino",
                "Jaspeado", "Tostado", "Perla", "Dorado"]
COLORES = ["#2A5C3F", "#C8820A", "#A83220", "#6D3A8C", "#1D4ED8", "#0F766E",
           "#B45309", "#BE185D", "#4D7C0F", "#7C2D12", "#0369A1", "#6B7280",
           "#9333EA", "#15803D", "#DC2626", "#57534E"]
ROLES = {
    "tecnico": "Técnico de campo",
    "productor": "Productor / responsable",
    "investigador": "Investigador",
    "analista": "Analista de datos",
    "cronometrista": "Cronometrista",
    "admin": "Administrador",
}

PLANTILLAS: dict[str, dict[str, Any]] = {
    "campus": {
        "titulo": "Ficha de elemento del campus",
        "area": "Área verde o espacio",
        "campos": [
            {"id": "categoria", "etiqueta": "Categoría", "tipo": "lista", "requerido": True,
             "opciones": ["Árbol", "Planta ornamental", "Planta medicinal", "Cultivo u hortaliza",
                          "Pasto o área verde", "Otro"]},
            {"id": "nombre_comun", "etiqueta": "Nombre común", "tipo": "texto", "requerido": True},
            {"id": "altura_m", "etiqueta": "Altura aproximada (m)", "tipo": "numero", "requerido": True,
             "min": 0.05, "max": 40},
            {"id": "diametro_cm", "etiqueta": "Diámetro del tronco o tallo (cm)", "tipo": "numero",
             "requerido": False, "min": 0.1, "max": 300},
            {"id": "cantidad", "etiqueta": "Cantidad de ejemplares", "tipo": "entero", "requerido": True,
             "min": 1, "max": 1000},
            {"id": "estado", "etiqueta": "Estado", "tipo": "lista", "requerido": True,
             "opciones": ["Bueno", "Regular", "Malo"]},
            {"id": "uso", "etiqueta": "Uso principal", "tipo": "lista", "requerido": False,
             "opciones": ["Sombra", "Alimento", "Medicinal", "Ornamental", "Ninguno", "Otro"]},
            {"id": "notas", "etiqueta": "Notas de campo", "tipo": "texto", "requerido": False},
        ],
    },
    "maiz": {
        "titulo": "Ficha de mazorca",
        "area": "Parcela",
        "campos": [
            {"id": "color_grano", "etiqueta": "Color de grano", "tipo": "lista", "requerido": True,
             "opciones": ["Blanco", "Amarillo", "Rojo", "Morado", "Negro", "Pinto", "Anaranjado"]},
            {"id": "longitud_cm", "etiqueta": "Longitud de mazorca (cm)", "tipo": "numero",
             "requerido": True, "min": 5, "max": 40},
            {"id": "diametro_cm", "etiqueta": "Diámetro de mazorca (cm)", "tipo": "numero",
             "requerido": True, "min": 1, "max": 10},
            {"id": "num_hileras", "etiqueta": "Número de hileras", "tipo": "entero", "requerido": True,
             "min": 4, "max": 30, "aviso_par": True, "aviso_min": 8, "aviso_max": 24},
            {"id": "peso_50_semillas_g", "etiqueta": "Peso de 50 semillas (g)", "tipo": "numero",
             "requerido": False, "min": 2, "max": 80},
            {"id": "notas", "etiqueta": "Notas de campo", "tipo": "texto", "requerido": False},
        ],
    },
}
if PLANTILLA not in PLANTILLAS:
    PLANTILLA = "campus"

# Tiempos objetivo (segundos) por tarea, usados en las métricas
OBJETIVOS = {"consentimiento": 180, "area": 600, "ficha": 420, "sincronizacion": 60, "mision": 2400}


def ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Base de datos
# --------------------------------------------------------------------------
_lock = threading.Lock()
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.row_factory = sqlite3.Row

ESQUEMA = """
CREATE TABLE IF NOT EXISTS usuario(usuario TEXT PRIMARY KEY, equipo TEXT, rol TEXT, codigo TEXT, nombre TEXT);
CREATE TABLE IF NOT EXISTS sesion(token TEXT PRIMARY KEY, usuario TEXT, creada TEXT);
CREATE TABLE IF NOT EXISTS productor(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, nombre TEXT, comunidad TEXT,
  lengua TEXT, autoriza_datos INTEGER, autoriza_foto INTEGER, autoriza_publicacion INTEGER, capturado TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS parcela(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, productor_uuid TEXT, nombre TEXT,
  vertices TEXT, area_ha REAL, perimetro_m REAL, precision_media_m REAL, fuente TEXT, capturado TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS evaluacion(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, productor_uuid TEXT,
  parcela_uuid TEXT, plantilla TEXT, datos TEXT, latitud REAL, longitud REAL, precision_m REAL, n_lecturas INTEGER,
  advertencias TEXT, validacion TEXT DEFAULT 'por validar', motivo TEXT, validado_por TEXT, capturado TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS evidencia(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, evaluacion_uuid TEXT, tipo TEXT,
  archivo TEXT, bytes INTEGER, sha256 TEXT, latitud REAL, longitud REAL, precision_m REAL, capturado TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS metrica(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, tarea TEXT, inicio TEXT, fin TEXT,
  duracion_s REAL, errores INTEGER, extra TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS incidencia(uuid TEXT PRIMARY KEY, equipo TEXT, usuario TEXT, pantalla TEXT, texto TEXT,
  capturado TEXT, recibido TEXT);
CREATE TABLE IF NOT EXISTS lote(id INTEGER PRIMARY KEY AUTOINCREMENT, equipo TEXT, usuario TEXT, dispositivo TEXT,
  n INTEGER, ok INTEGER, duplicados INTEGER, errores INTEGER, recibido TEXT);
"""
with _lock:
    _db.executescript(ESQUEMA)
    _db.commit()


def q(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return _db.execute(sql, args).fetchall()


def ex(sql: str, args: tuple = ()) -> int:
    with _lock:
        cur = _db.execute(sql, args)
        _db.commit()
        return cur.rowcount


# --------------------------------------------------------------------------
# Usuarios (archivo data/usuarios.csv; se genera si no existe)
# --------------------------------------------------------------------------
def nombre_equipo(i: int) -> str:
    nombres = NOMBRES_MAIZ if PLANTILLA == "maiz" else NOMBRES_CAMPUS
    pref = "Maíz " if PLANTILLA == "maiz" else ""
    return f"Equipo {i:02d} · {pref}{nombres[(i - 1) % len(nombres)]}"


def generar_usuarios() -> None:
    filas = []
    for i in range(1, N_EQUIPOS + 1):
        for rol in ["tecnico", "productor", "investigador", "analista", "cronometrista"]:
            filas.append({"usuario": f"e{i:02d}.{rol}", "equipo": f"e{i:02d}", "rol": rol,
                          "codigo": f"{secrets.randbelow(9000) + 1000}", "nombre_equipo": nombre_equipo(i)})
    filas.append({"usuario": "admin", "equipo": "", "rol": "admin",
                  "codigo": ADMIN_CODIGO or secrets.token_hex(3), "nombre_equipo": ORGANIZACION})
    with open(USUARIOS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["usuario", "equipo", "rol", "codigo", "nombre_equipo"])
        w.writeheader()
        w.writerows(filas)


def cargar_usuarios() -> None:
    if not USUARIOS_CSV.exists():
        generar_usuarios()
    with open(USUARIOS_CSV, encoding="utf-8-sig") as f:
        filas = list(csv.DictReader(f))
    with _lock:
        _db.execute("DELETE FROM usuario")
        for r in filas:
            codigo = r["codigo"].strip()
            if r["rol"] == "admin" and ADMIN_CODIGO:
                codigo = ADMIN_CODIGO
            _db.execute("INSERT INTO usuario VALUES (?,?,?,?,?)",
                        (r["usuario"].strip(), r["equipo"].strip(), r["rol"].strip(), codigo,
                         r.get("nombre_equipo", "").strip()))
        _db.commit()


cargar_usuarios()


def equipos() -> list[dict]:
    filas = q("SELECT DISTINCT equipo, nombre FROM usuario WHERE equipo<>'' ORDER BY equipo")
    return [{"id": r["equipo"], "nombre": r["nombre"], "color": COLORES[i % len(COLORES)]}
            for i, r in enumerate(filas)]


# --------------------------------------------------------------------------
# Sesión
# --------------------------------------------------------------------------
class Usuario(BaseModel):
    usuario: str
    equipo: str
    rol: str


def usuario_actual(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)) -> Optional[Usuario]:
    t = token
    if authorization and authorization.lower().startswith("bearer "):
        t = authorization[7:].strip()
    if not t:
        return None
    r = q("SELECT u.usuario, u.equipo, u.rol FROM sesion s JOIN usuario u ON u.usuario=s.usuario WHERE s.token=?", (t,))
    if not r:
        return None
    return Usuario(usuario=r[0]["usuario"], equipo=r[0]["equipo"], rol=r[0]["rol"])


def requiere(*roles: str):
    def dep(u: Optional[Usuario] = Depends(usuario_actual)) -> Usuario:
        if u is None:
            raise HTTPException(401, "Inicia sesión de nuevo: la sesión no es válida.")
        if roles and u.rol not in roles and u.rol != "admin":
            raise HTTPException(403, f"Tu perfil ({ROLES.get(u.rol, u.rol)}) no puede hacer esta acción.")
        return u
    return dep


# --------------------------------------------------------------------------
# Geometría y validaciones
# --------------------------------------------------------------------------
R_TIERRA = 6371008.8


def a_metros(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    x = math.radians(lon - lon0) * R_TIERRA * math.cos(math.radians(lat0))
    y = math.radians(lat - lat0) * R_TIERRA
    return x, y


def area_perimetro(vertices: list[list[float]]) -> tuple[float, float]:
    if len(vertices) < 3:
        return 0.0, 0.0
    lat0 = sum(v[0] for v in vertices) / len(vertices)
    lon0 = sum(v[1] for v in vertices) / len(vertices)
    xy = [a_metros(v[0], v[1], lat0, lon0) for v in vertices]
    s = p = 0.0
    for i in range(len(xy)):
        x1, y1 = xy[i]
        x2, y2 = xy[(i + 1) % len(xy)]
        s += x1 * y2 - x2 * y1
        p += math.hypot(x2 - x1, y2 - y1)
    return abs(s) / 2 / 10000, p


def se_cruza(vertices: list[list[float]]) -> bool:
    lat0, lon0 = vertices[0]
    xy = [a_metros(v[0], v[1], lat0, lon0) for v in vertices]
    n = len(xy)

    def o(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return (v > 1e-9) - (v < -1e-9)

    for i in range(n):
        for j in range(i + 1, n):
            if abs(i - j) <= 1 or (i == 0 and j == n - 1):
                continue
            a, b, c, d = xy[i], xy[(i + 1) % n], xy[j], xy[(j + 1) % n]
            if o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0:
                return True
    return False


def coord_valida(lat: Any, lon: Any) -> bool:
    try:
        return -90 <= float(lat) <= 90 and -180 <= float(lon) <= 180
    except (TypeError, ValueError):
        return False


def validar_ficha(plantilla: str, datos: dict) -> tuple[list[str], list[str]]:
    errores, avisos = [], []
    for c in PLANTILLAS[plantilla]["campos"]:
        v = datos.get(c["id"])
        vacio = v is None or (isinstance(v, str) and not v.strip())
        if vacio:
            if c.get("requerido"):
                errores.append(f"Falta {c['etiqueta'].lower()}.")
            continue
        if c["tipo"] in ("numero", "entero"):
            try:
                num = float(v)
            except (TypeError, ValueError):
                errores.append(f"{c['etiqueta']}: debe ser un número.")
                continue
            if c["tipo"] == "entero" and num != int(num):
                errores.append(f"{c['etiqueta']}: debe ser un número entero.")
            if "min" in c and num < c["min"] or "max" in c and num > c["max"]:
                errores.append(f"{c['etiqueta']}: debe estar entre {c['min']} y {c['max']}.")
            if c.get("aviso_par") and int(num) % 2 == 1:
                avisos.append(f"{c['etiqueta']}: casi siempre es un número par.")
            if "aviso_min" in c and (num < c["aviso_min"] or num > c["aviso_max"]):
                avisos.append(f"{c['etiqueta']}: poco común fuera de {c['aviso_min']}–{c['aviso_max']}.")
        if c["tipo"] == "lista" and v not in c["opciones"]:
            errores.append(f"{c['etiqueta']}: elige una opción de la lista.")
    return errores, avisos


# --------------------------------------------------------------------------
# Aplicación
# --------------------------------------------------------------------------
app = FastAPI(title="Kit del taller · Agroplataforma", version=VERSION)


@app.exception_handler(HTTPException)
def _http_error(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.get("/api/salud")
def salud():
    return {"ok": True, "version": VERSION, "plantilla": PLANTILLA, "hora": ahora()}


class Login(BaseModel):
    usuario: str
    codigo: str


@app.post("/api/login")
def login(d: Login):
    r = q("SELECT * FROM usuario WHERE usuario=?", (d.usuario.strip().lower(),))
    if not r or not secrets.compare_digest(r[0]["codigo"], d.codigo.strip()):
        raise HTTPException(401, "Usuario o código incorrecto. Revisa tu tarjeta.")
    token = secrets.token_urlsafe(24)
    ex("INSERT INTO sesion VALUES (?,?,?)", (token, r[0]["usuario"], ahora()))
    return {"token": token, "usuario": r[0]["usuario"], "equipo": r[0]["equipo"], "rol": r[0]["rol"],
            "rol_nombre": ROLES.get(r[0]["rol"], r[0]["rol"]), "nombre_equipo": r[0]["nombre"]}


@app.get("/api/config")
def config():
    return {"organizacion": ORGANIZACION, "plantilla": PLANTILLA, "ficha": PLANTILLAS[PLANTILLA],
            "sede": {"lat": SEDE_LAT, "lon": SEDE_LON}, "equipos": equipos(), "roles": ROLES,
            "objetivos": OBJETIVOS, "version": VERSION}


class Item(BaseModel):
    tipo: str
    uuid: str
    datos: dict


class Lote(BaseModel):
    dispositivo: str = ""
    items: list[Item]


def _guardar_item(u: Usuario, it: Item) -> tuple[str, str]:
    """Devuelve (estado, motivo). estado: ok | duplicado | error"""
    d = it.datos
    equipo = u.equipo or d.get("equipo", "")
    rec = ahora()
    tablas = {"productor": "productor", "parcela": "parcela", "evaluacion": "evaluacion",
              "metrica": "metrica", "incidencia": "incidencia"}
    if it.tipo not in tablas:
        return "error", f"Tipo desconocido: {it.tipo}"
    if q(f"SELECT 1 FROM {tablas[it.tipo]} WHERE uuid=?", (it.uuid,)):
        return "duplicado", "Ya estaba en el servidor."
    if it.tipo in ("productor", "parcela", "evaluacion") and u.rol not in ("tecnico", "admin"):
        return "error", "Solo el técnico de campo puede capturar registros."

    if it.tipo == "productor":
        if not d.get("autoriza_datos"):
            return "error", "Sin autorización para registrar datos no se guarda el registro."
        if not str(d.get("nombre", "")).strip():
            return "error", "Falta el nombre."
        ex("INSERT INTO productor VALUES (?,?,?,?,?,?,?,?,?,?,?)",
           (it.uuid, equipo, u.usuario, d.get("nombre"), d.get("comunidad", ""), d.get("lengua", ""),
            1, int(bool(d.get("autoriza_foto"))), int(bool(d.get("autoriza_publicacion"))),
            d.get("capturado", rec), rec))
        return "ok", ""

    if it.tipo == "parcela":
        v = d.get("vertices") or []
        if len(v) < 3 or not all(coord_valida(p[0], p[1]) for p in v):
            return "error", "La parcela necesita al menos 3 esquinas con coordenadas válidas."
        if se_cruza(v):
            return "error", "Las orillas se cruzan (forma de moño)."
        a, p = area_perimetro(v)
        if a < 0.0005 or a > 500:
            return "error", f"Área fuera de rango ({a:.4f} ha)."
        ex("INSERT INTO parcela VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
           (it.uuid, equipo, u.usuario, d.get("productor_uuid"), d.get("nombre", ""), json.dumps(v),
            round(a, 4), round(p, 1), d.get("precision_media_m"), d.get("fuente", "app_gps"),
            d.get("capturado", rec), rec))
        return "ok", ""

    if it.tipo == "evaluacion":
        pu = d.get("productor_uuid")
        if pu:
            pr = q("SELECT autoriza_datos FROM productor WHERE uuid=?", (pu,))
            if not pr:
                return "error", "El registro del responsable aún no llega. Se reintentará."
        plantilla = d.get("plantilla", PLANTILLA)
        if plantilla not in PLANTILLAS:
            return "error", "Plantilla de ficha desconocida."
        errores, avisos = validar_ficha(plantilla, d.get("campos", {}))
        if errores:
            return "error", " ".join(errores)
        lat, lon = d.get("latitud"), d.get("longitud")
        if lat is not None and not coord_valida(lat, lon):
            return "error", "Coordenadas inválidas."
        ex("INSERT INTO evaluacion(uuid,equipo,usuario,productor_uuid,parcela_uuid,plantilla,datos,latitud,longitud,"
           "precision_m,n_lecturas,advertencias,capturado,recibido) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
           (it.uuid, equipo, u.usuario, pu, d.get("parcela_uuid"), plantilla, json.dumps(d.get("campos", {})),
            lat, lon, d.get("precision_m"), d.get("n_lecturas"), json.dumps(avisos), d.get("capturado", rec), rec))
        return "ok", ""

    if it.tipo == "metrica":
        ex("INSERT INTO metrica VALUES (?,?,?,?,?,?,?,?,?,?)",
           (it.uuid, equipo, u.usuario, d.get("tarea"), d.get("inicio"), d.get("fin"), d.get("duracion_s"),
            int(d.get("errores", 0) or 0), json.dumps(d.get("extra", {})), rec))
        return "ok", ""

    if it.tipo == "incidencia":
        ex("INSERT INTO incidencia VALUES (?,?,?,?,?,?,?)",
           (it.uuid, equipo, u.usuario, d.get("pantalla", ""), str(d.get("texto", ""))[:500],
            d.get("capturado", rec), rec))
        return "ok", ""
    return "error", "Sin manejar"


@app.post("/api/sync/push")
def sync_push(lote: Lote, u: Usuario = Depends(requiere())):
    orden = {"productor": 0, "parcela": 1, "evaluacion": 2, "metrica": 3, "incidencia": 4}
    items = sorted(lote.items, key=lambda i: orden.get(i.tipo, 9))
    res, n_ok, n_dup, n_err = [], 0, 0, 0
    for it in items:
        try:
            estado, motivo = _guardar_item(u, it)
        except Exception as e:  # noqa: BLE001
            estado, motivo = "error", f"Error del servidor: {e}"
        n_ok += estado == "ok"
        n_dup += estado == "duplicado"
        n_err += estado == "error"
        res.append({"uuid": it.uuid, "estado": estado, "motivo": motivo})
    ex("INSERT INTO lote(equipo,usuario,dispositivo,n,ok,duplicados,errores,recibido) VALUES (?,?,?,?,?,?,?,?)",
       (u.equipo, u.usuario, lote.dispositivo[:80], len(items), n_ok, n_dup, n_err, ahora()))
    return {"resultados": res, "recibido": ahora()}


@app.post("/api/evidencias")
async def subir_evidencia(uuid: str = Form(...), evaluacion_uuid: str = Form(...), tipo: str = Form("foto"),
                          latitud: Optional[float] = Form(None), longitud: Optional[float] = Form(None),
                          precision_m: Optional[float] = Form(None), capturado: str = Form(""),
                          archivo: UploadFile = File(...), u: Usuario = Depends(requiere("tecnico"))):
    if q("SELECT 1 FROM evidencia WHERE uuid=?", (uuid,)):
        return {"estado": "duplicado"}
    ev = q("SELECT e.equipo, p.autoriza_foto FROM evaluacion e LEFT JOIN productor p ON p.uuid=e.productor_uuid "
           "WHERE e.uuid=?", (evaluacion_uuid,))
    if not ev:
        raise HTTPException(409, "La ficha de esta foto aún no llega. Se reintentará.")
    if ev[0]["autoriza_foto"] == 0:
        raise HTTPException(422, "El responsable no autorizó fotos.")
    contenido = await archivo.read()
    if len(contenido) > MAX_FOTO_MB * 1024 * 1024:
        raise HTTPException(413, f"La foto pesa más de {MAX_FOTO_MB:g} MB.")
    if not contenido[:3] == b"\xff\xd8\xff" and not contenido[:8] == b"\x89PNG\r\n\x1a\n":
        raise HTTPException(415, "Solo se aceptan fotos JPG o PNG.")
    ext = ".png" if contenido[:4] == b"\x89PNG" else ".jpg"
    carpeta = FOTOS / (u.equipo or "admin")
    carpeta.mkdir(parents=True, exist_ok=True)
    ruta = carpeta / f"{uuid}{ext}"
    ruta.write_bytes(contenido)
    ex("INSERT INTO evidencia VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
       (uuid, u.equipo, u.usuario, evaluacion_uuid, tipo, str(ruta.relative_to(DATA)), len(contenido),
        hashlib.sha256(contenido).hexdigest(), latitud, longitud, precision_m, capturado or ahora(), ahora()))
    return {"estado": "ok"}


@app.get("/api/foto/{uuid}")
def foto(uuid: str, u: Usuario = Depends(requiere())):
    r = q("SELECT archivo, equipo FROM evidencia WHERE uuid=?", (uuid,))
    if not r:
        raise HTTPException(404, "No existe esa foto.")
    if u.rol == "productor" and r[0]["equipo"] != u.equipo:
        raise HTTPException(403, "Solo puedes ver las fotos de tu equipo.")
    return FileResponse(DATA / r[0]["archivo"])


def _filas(sql: str, args: tuple = ()) -> list[dict]:
    return [dict(r) for r in q(sql, args)]


@app.get("/api/datos")
def datos(u: Optional[Usuario] = Depends(usuario_actual)):
    eqs = equipos()
    if u is None:  # invitado: solo agregados por equipo, sin ubicación exacta ni datos personales
        resumen = []
        for e in eqs:
            n_f = q("SELECT COUNT(*) c FROM evaluacion WHERE equipo=?", (e["id"],))[0]["c"]
            n_a = q("SELECT COUNT(*) c, SUM(area_ha) s FROM parcela WHERE equipo=?", (e["id"],))[0]
            cen = q("SELECT AVG(latitud) la, AVG(longitud) lo FROM evaluacion WHERE equipo=? AND latitud IS NOT NULL",
                    (e["id"],))[0]
            la, lo = cen["la"], cen["lo"]
            if la is not None:  # zona generalizada a ~100 m
                la, lo = round(la, 3), round(lo, 3)
            resumen.append({**e, "fichas": n_f, "areas": n_a["c"], "ha": round(n_a["s"] or 0, 3),
                            "zona": [la, lo] if la is not None else None})
        return {"rol": "invitado", "equipos": eqs, "resumen": resumen}

    filtro, args = "", ()
    if u.rol == "productor":
        filtro, args = " WHERE equipo=?", (u.equipo,)
    prod = _filas("SELECT uuid,equipo,nombre,comunidad,lengua,autoriza_datos,autoriza_foto,autoriza_publicacion,"
                  "capturado,recibido FROM productor" + filtro, args)
    parc = _filas("SELECT * FROM parcela" + filtro, args)
    for p in parc:
        p["vertices"] = json.loads(p["vertices"])
    evs = _filas("SELECT * FROM evaluacion" + filtro + " ORDER BY capturado", args)
    for e in evs:
        e["datos"] = json.loads(e["datos"])
        e["advertencias"] = json.loads(e["advertencias"] or "[]")
    fotos = _filas("SELECT uuid,equipo,evaluacion_uuid,tipo,bytes,latitud,longitud,precision_m,capturado,recibido "
                   "FROM evidencia" + filtro, args)
    return {"rol": u.rol, "usuario": u.usuario, "equipo": u.equipo, "equipos": eqs,
            "productores": prod, "parcelas": parc, "evaluaciones": evs, "evidencias": fotos}


class Validacion(BaseModel):
    estado: str
    motivo: str = ""


@app.patch("/api/evaluaciones/{uuid}/validacion")
def validar(uuid: str, v: Validacion, u: Usuario = Depends(requiere("investigador"))):
    if v.estado not in ("validada", "corregir", "por validar"):
        raise HTTPException(400, "Estado no válido.")
    r = q("SELECT equipo FROM evaluacion WHERE uuid=?", (uuid,))
    if not r:
        raise HTTPException(404, "No existe esa ficha.")
    if u.rol != "admin" and r[0]["equipo"] != u.equipo:
        raise HTTPException(403, "Solo validas las fichas de tu equipo.")
    if v.estado == "corregir" and not v.motivo.strip():
        raise HTTPException(422, "Escribe qué hay que corregir.")
    ex("UPDATE evaluacion SET validacion=?, motivo=?, validado_por=? WHERE uuid=?",
       (v.estado, v.motivo.strip(), u.usuario, uuid))
    return {"ok": True}


def _seg(a: Optional[str], b: Optional[str]) -> Optional[float]:
    try:
        return (datetime.fromisoformat(b.replace("Z", "+00:00")) -
                datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()
    except Exception:  # noqa: BLE001
        return None


@app.get("/api/metricas")
def metricas(u: Usuario = Depends(requiere("analista", "investigador", "cronometrista"))):
    salida = []
    for e in equipos():
        if u.rol != "admin" and u.equipo and e["id"] != u.equipo and u.rol == "cronometrista":
            continue
        fila: dict[str, Any] = {"equipo": e["id"], "nombre": e["nombre"], "color": e["color"]}
        for t in ["consentimiento", "area", "ficha", "sincronizacion", "mision"]:
            r = q("SELECT AVG(duracion_s) m, COUNT(*) n, SUM(errores) er FROM metrica WHERE equipo=? AND tarea=?",
                  (e["id"], t))[0]
            fila[t] = {"media_s": round(r["m"], 1) if r["m"] else None, "n": r["n"], "errores": r["er"] or 0}
        ev = q("SELECT COUNT(*) n, AVG(precision_m) p, SUM(validacion='validada') v, "
               "SUM(advertencias<>'[]') a FROM evaluacion WHERE equipo=?", (e["id"],))[0]
        fila["fichas"] = ev["n"]
        fila["validadas"] = ev["v"] or 0
        fila["con_aviso"] = ev["a"] or 0
        fila["precision_gps_m"] = round(ev["p"], 1) if ev["p"] else None
        fila["fotos"] = q("SELECT COUNT(*) c FROM evidencia WHERE equipo=?", (e["id"],))[0]["c"]
        pa = q("SELECT COUNT(*) n, AVG(precision_media_m) p, SUM(area_ha) s FROM parcela WHERE equipo=?", (e["id"],))[0]
        fila["areas"] = pa["n"]
        fila["ha"] = round(pa["s"] or 0, 3)
        lat = [_seg(r["capturado"], r["recibido"]) for r in
               q("SELECT capturado, recibido FROM evaluacion WHERE equipo=?", (e["id"],))]
        lat = [x for x in lat if x is not None and x >= 0]
        fila["latencia_sync_min"] = round(sum(lat) / len(lat) / 60, 1) if lat else None
        fila["incidencias"] = q("SELECT COUNT(*) c FROM incidencia WHERE equipo=?", (e["id"],))[0]["c"]
        lotes = q("SELECT SUM(n) n, SUM(errores) e FROM lote WHERE equipo=?", (e["id"],))[0]
        fila["items_enviados"] = lotes["n"] or 0
        fila["items_rechazados"] = lotes["e"] or 0
        salida.append(fila)
    inc = _filas("SELECT equipo,usuario,pantalla,texto,capturado FROM incidencia ORDER BY capturado DESC LIMIT 100")
    return {"objetivos": OBJETIVOS, "equipos": salida, "incidencias": inc}


def _csv(filas: list[dict], nombre: str) -> PlainTextResponse:
    buf = io.StringIO()
    if filas:
        w = csv.DictWriter(buf, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    return PlainTextResponse("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{nombre}"'})


@app.get("/api/export/fichas.csv")
def export_fichas(u: Usuario = Depends(requiere("analista", "investigador"))):
    campos = [c["id"] for c in PLANTILLAS[PLANTILLA]["campos"]]
    filas = []
    nombres = {e["id"]: e["nombre"] for e in equipos()}
    for e in q("SELECT * FROM evaluacion ORDER BY equipo, capturado"):
        d = json.loads(e["datos"])
        pa = q("SELECT area_ha, perimetro_m FROM parcela WHERE equipo=? ORDER BY capturado DESC LIMIT 1", (e["equipo"],))
        nf = q("SELECT COUNT(*) c FROM evidencia WHERE evaluacion_uuid=?", (e["uuid"],))[0]["c"]
        fila = {"equipo": nombres.get(e["equipo"], e["equipo"]), "ficha_uuid": e["uuid"]}
        fila.update({c: d.get(c, "") for c in campos})
        fila.update({"latitud": e["latitud"], "longitud": e["longitud"], "precision_m": e["precision_m"],
                     "area_ha": pa[0]["area_ha"] if pa else "", "perimetro_m": pa[0]["perimetro_m"] if pa else "",
                     "n_fotos": nf, "validacion": e["validacion"], "capturado": e["capturado"], "recibido": e["recibido"]})
        filas.append(fila)
    return _csv(filas, "fichas_taller.csv")


@app.get("/api/export/metricas.csv")
def export_metricas(u: Usuario = Depends(requiere("analista", "investigador", "cronometrista"))):
    nombres = {e["id"]: e["nombre"] for e in equipos()}
    filas = [{"equipo": nombres.get(r["equipo"], r["equipo"]), "usuario": r["usuario"], "tarea": r["tarea"],
              "inicio": r["inicio"], "fin": r["fin"], "duracion_s": r["duracion_s"], "errores": r["errores"],
              "extra": r["extra"]} for r in q("SELECT * FROM metrica ORDER BY equipo, inicio")]
    return _csv(filas, "metricas_taller.csv")


@app.get("/api/export/parcelas.geojson")
def export_geojson(u: Usuario = Depends(requiere("analista", "investigador"))):
    feats = []
    for p in q("SELECT * FROM parcela"):
        v = json.loads(p["vertices"])
        anillo = [[x[1], x[0]] for x in v] + [[v[0][1], v[0][0]]]
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [anillo]},
                      "properties": {"uuid": p["uuid"], "equipo": p["equipo"], "area_ha": p["area_ha"],
                                     "perimetro_m": p["perimetro_m"], "fuente": p["fuente"]}})
    for e in q("SELECT * FROM evaluacion WHERE latitud IS NOT NULL"):
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [e["longitud"], e["latitud"]]},
                      "properties": {"uuid": e["uuid"], "equipo": e["equipo"], "precision_m": e["precision_m"],
                                     **json.loads(e["datos"])}})
    return JSONResponse({"type": "FeatureCollection", "features": feats},
                        headers={"Content-Disposition": 'attachment; filename="taller.geojson"'})


class Reinicio(BaseModel):
    confirmar: str


@app.post("/api/admin/reiniciar")
def reiniciar(d: Reinicio, u: Usuario = Depends(requiere("admin"))):
    if d.confirmar != "BORRAR":
        raise HTTPException(422, "Escribe BORRAR para confirmar.")
    destino = DATA / "respaldos" / time.strftime("%Y%m%d-%H%M%S")
    destino.mkdir(parents=True, exist_ok=True)
    with _lock:
        _db.commit()
        shutil.copy2(DB_PATH, destino / "taller.db")
        if FOTOS.exists():
            shutil.copytree(FOTOS, destino / "fotos", dirs_exist_ok=True)
        for t in ["productor", "parcela", "evaluacion", "evidencia", "metrica", "incidencia", "lote"]:
            _db.execute(f"DELETE FROM {t}")
        _db.commit()
    shutil.rmtree(FOTOS, ignore_errors=True)
    FOTOS.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "respaldo": str(destino.relative_to(DATA))}


@app.get("/api/admin/usuarios")
def lista_usuarios(u: Usuario = Depends(requiere("admin"))):
    return _filas("SELECT usuario, equipo, rol, codigo, nombre FROM usuario ORDER BY equipo, rol")


# --------------------------------------------------------------------------
# Archivos estáticos
# --------------------------------------------------------------------------
STATIC = BASE / "static"


@app.get("/")
def raiz():
    return RedirectResponse("/web/")


@app.get("/movil/sw.js")
def service_worker():
    return FileResponse(STATIC / "movil" / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/movil/", "Cache-Control": "no-cache"})


app.mount("/movil", StaticFiles(directory=STATIC / "movil", html=True), name="movil")
app.mount("/web", StaticFiles(directory=STATIC / "web", html=True), name="web")
app.mount("/vendor", StaticFiles(directory=STATIC / "vendor"), name="vendor")
