#!/usr/bin/env python3
"""Exporta los datos del taller con los nombres de tablas de la Agroplataforma (agromaiz.mx),
para revisarlos o importarlos después en la plataforma real.

Uso:  python3 scripts/exportar_agromaiz.py data/taller.db salida/
Genera: productor.csv, consentimiento.csv, parcela.csv (WKT), ubicacion.csv, evaluacion.csv,
        evidencia.csv (+ fotos/), metricas_uso.csv, incidencias.csv y LEEME.txt con la correspondencia.
"""
import csv, json, os, shutil, sqlite3, sys

db = sys.argv[1] if len(sys.argv) > 1 else "data/taller.db"
out = sys.argv[2] if len(sys.argv) > 2 else "exportacion_agromaiz"
os.makedirs(out, exist_ok=True)
c = sqlite3.connect(db); c.row_factory = sqlite3.Row


def escribe(nombre, filas):
    filas = [dict(f) for f in filas]
    with open(os.path.join(out, nombre), "w", newline="", encoding="utf-8") as f:
        if filas:
            w = csv.DictWriter(f, fieldnames=list(filas[0].keys())); w.writeheader(); w.writerows(filas)
    print(f"{nombre}: {len(filas)} filas")


escribe("productor.csv", c.execute("SELECT uuid, nombre, comunidad AS comunidad_texto, lengua, equipo AS grupo_capacitacion, capturado AS fecha_registro FROM productor"))
escribe("consentimiento.csv", c.execute("SELECT uuid AS productor_uuid, capturado AS fecha, 'oral' AS tipo, autoriza_foto, autoriza_datos, autoriza_publicacion FROM productor"))
parc = []
for p in c.execute("SELECT * FROM parcela"):
    v = json.loads(p["vertices"]); anillo = v + [v[0]]
    wkt = "POLYGON((" + ", ".join(f"{x[1]} {x[0]}" for x in anillo) + "))"
    parc.append({"uuid": p["uuid"], "productor_uuid": p["productor_uuid"], "superficie_ha": p["area_ha"], "perimetro_m": p["perimetro_m"],
                 "poligono_wkt_4326": wkt, "precision_media_m": p["precision_media_m"], "fuente_captura": p["fuente"], "capturado": p["capturado"]})
escribe("parcela.csv", parc)
escribe("ubicacion.csv", c.execute("SELECT uuid AS evaluacion_uuid, latitud, longitud, precision_m, n_lecturas, 'EPSG:4326' AS sistema_referencia, 'app_gps' AS fuente_captura FROM evaluacion WHERE latitud IS NOT NULL"))
evs = []
for e in c.execute("SELECT * FROM evaluacion"):
    d = json.loads(e["datos"])
    evs.append({"uuid": e["uuid"], "productor_uuid": e["productor_uuid"], "parcela_uuid": e["parcela_uuid"], "plantilla": e["plantilla"],
                **d, "advertencias": e["advertencias"], "validacion": e["validacion"], "validado_por": e["validado_por"], "capturado": e["capturado"]})
escribe("evaluacion.csv", evs)
ev = list(c.execute("SELECT uuid, evaluacion_uuid, tipo, archivo AS ruta_archivo, bytes, sha256, latitud, longitud, capturado AS fecha_captura FROM evidencia"))
escribe("evidencia.csv", ev)
base = os.path.dirname(os.path.abspath(db))
for f in ev:
    src = os.path.join(base, f["ruta_archivo"])
    if os.path.exists(src):
        dst = os.path.join(out, f["ruta_archivo"]); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
escribe("metricas_uso.csv", c.execute("SELECT equipo, usuario, tarea, inicio, fin, duracion_s, errores, extra FROM metrica"))
escribe("incidencias.csv", c.execute("SELECT equipo, usuario, pantalla, texto, capturado FROM incidencia"))
open(os.path.join(out, "LEEME.txt"), "w", encoding="utf-8").write("""Correspondencia con el modelo de datos de la Agroplataforma
-----------------------------------------------------------
productor.csv        -> productor (nombre, lengua; comunidad como texto: ligar a comunidad_id al importar)
consentimiento.csv   -> consentimiento (productor_id, fecha, tipo, autoriza_foto, autoriza_datos, autoriza_publicacion)
parcela.csv          -> parcela (superficie_ha, poligono geometry(Polygon,4326) desde WKT)
ubicacion.csv        -> ubicacion (latitud, longitud, sistema_referencia, fuente_captura)
evaluacion.csv       -> plantilla 'maiz': evaluacion_fenotipica (longitud, diametro, num_hileras, peso_50_semillas_g)
                        plantilla 'campus': datos de capacitación; NO importar a la base de producción
evidencia.csv+fotos/ -> evidencia (evaluacion_id, tipo, ruta_archivo, fecha_captura)
metricas_uso.csv     -> evaluación de usabilidad (no es tabla de la plataforma)
Los UUID permiten importar sin duplicar. Revisa y valida antes de importar a producción.
""")
print("Listo en", out)
