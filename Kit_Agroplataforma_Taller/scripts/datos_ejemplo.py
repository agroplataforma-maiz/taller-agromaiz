#!/usr/bin/env python3
"""Carga datos de EJEMPLO (ficticios) para ensayar la demostración y revisar el tablero.
Uso:  python3 scripts/datos_ejemplo.py https://taller.agromaiz.mx data/usuarios.csv
Después del ensayo, reinicia la plataforma desde Administración (escribe BORRAR)."""
import csv, json, math, random, sys, uuid, urllib.request
from datetime import datetime, timedelta, timezone

URL = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
USU = sys.argv[2] if len(sys.argv) > 2 else "data/usuarios.csv"
random.seed(7)


def post(ruta, datos, token=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    r = urllib.request.Request(URL + ruta, data=json.dumps(datos).encode(), headers=h, method="POST")
    with urllib.request.urlopen(r) as x: return json.loads(x.read())


cfg = json.loads(urllib.request.urlopen(URL + "/api/config").read())
lat0, lon0 = cfg["sede"]["lat"], cfg["sede"]["lon"]
m = lambda d: d / 111320
CAMPUS = [("Árbol", "Ceiba", 12, 60, "Sombra"), ("Árbol", "Mango", 7, 35, "Alimento"), ("Planta medicinal", "Sábila", 0.5, None, "Medicinal"),
          ("Planta ornamental", "Bugambilia", 2.5, 8, "Ornamental"), ("Árbol", "Nim", 6, 25, "Sombra"), ("Cultivo u hortaliza", "Chile", 0.6, None, "Alimento"),
          ("Planta medicinal", "Hierbabuena", 0.3, None, "Medicinal"), ("Árbol", "Naranjo", 4, 18, "Alimento"), ("Pasto o área verde", "Pasto", 0.1, None, "Ninguno")]
filas = [r for r in csv.DictReader(open(USU, encoding="utf-8-sig")) if r["rol"] == "tecnico"]
inicio = datetime.now(timezone.utc) - timedelta(hours=1)
for i, f in enumerate(filas):
    tk = post("/api/login", {"usuario": f["usuario"], "codigo": f["codigo"]})["token"]
    ang = 2 * math.pi * i / len(filas); cx, cy = lat0 + m(110 * math.sin(ang)), lon0 + m(140 * math.cos(ang))
    w, h = random.uniform(18, 35), random.uniform(12, 25)
    vert = [[cx, cy], [cx, cy + m(w)], [cx + m(h), cy + m(w * 0.95)], [cx + m(h * 1.05), cy - m(2)]]
    pid = str(uuid.uuid4())
    items = [{"tipo": "productor", "uuid": pid, "datos": {"nombre": f"Responsable {i + 1:02d} (ejemplo)", "comunidad": "Campus", "lengua": "Español",
              "autoriza_datos": True, "autoriza_foto": True, "autoriza_publicacion": i % 4 != 0}},
             {"tipo": "parcela", "uuid": str(uuid.uuid4()), "datos": {"productor_uuid": pid, "vertices": vert, "precision_media_m": round(random.uniform(3, 9), 1), "fuente": "app_gps"}}]
    t = inicio + timedelta(minutes=random.uniform(0, 5))
    def met(tarea, seg, err=0):
        global t
        items.append({"tipo": "metrica", "uuid": str(uuid.uuid4()), "datos": {"tarea": tarea, "inicio": t.isoformat(), "fin": (t + timedelta(seconds=seg)).isoformat(),
                      "duracion_s": round(seg), "errores": err, "extra": {"fuente": "ejemplo"}}})
        t += timedelta(seconds=seg + random.uniform(20, 60))
    met("consentimiento", random.uniform(90, 260), random.choice([0, 0, 1]))
    met("area", random.uniform(300, 900), random.choice([0, 1, 2]))
    for k in random.sample(CAMPUS, 3):
        items.append({"tipo": "evaluacion", "uuid": str(uuid.uuid4()), "datos": {"productor_uuid": pid, "plantilla": "campus",
            "latitud": cx + m(random.uniform(2, h)), "longitud": cy + m(random.uniform(2, w)), "precision_m": round(random.uniform(3, 10), 1), "n_lecturas": random.randint(4, 12),
            "campos": {"categoria": k[0], "nombre_comun": k[1], "altura_m": round(k[2] * random.uniform(.7, 1.3), 1), **({"diametro_cm": round(k[3] * random.uniform(.7, 1.3))} if k[3] else {}),
                       "cantidad": random.randint(1, 6), "estado": random.choice(["Bueno", "Bueno", "Regular", "Malo"]), "uso": k[4]}}})
        met("ficha", random.uniform(240, 600), random.choice([0, 0, 1, 2]))
    met("sincronizacion", random.uniform(15, 90))
    items.append({"tipo": "metrica", "uuid": str(uuid.uuid4()), "datos": {"tarea": "mision", "duracion_s": round(random.uniform(1800, 3300)), "errores": 0, "extra": {"fuente": "ejemplo"}}})
    if i % 3 == 0:
        items.append({"tipo": "incidencia", "uuid": str(uuid.uuid4()), "datos": {"pantalla": random.choice(["Área y GPS", "Sincronización", "Fotos"]),
                      "texto": random.choice(["La precisión no bajaba de 12 m junto al edificio", "Tardó en subir la foto con la red de la escuela", "No encontrábamos la categoría para un cactus"])}})
    r = post("/api/sync/push", {"dispositivo": "datos_ejemplo", "items": items}, tk)
    print(f["usuario"], sum(x["estado"] == "ok" for x in r["resultados"]), "registros")
print("Listo. Son datos de ejemplo: reinicia la plataforma antes del taller.")
