#!/usr/bin/env python3
"""Prueba de carga: simula a todos los equipos sincronizando al mismo tiempo al regresar al salón.

Uso:  python3 scripts/prueba_carga.py https://taller.agromaiz.mx  data/usuarios.csv  [fotos_por_ficha]
Crea datos de PRUEBA: después reinicia la plataforma desde Administración.
"""
import csv, json, math, os, random, sys, threading, time, uuid, urllib.request

URL = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
USUARIOS = sys.argv[2] if len(sys.argv) > 2 else "data/usuarios.csv"
FOTOS = int(sys.argv[3]) if len(sys.argv) > 3 else 2
FICHAS = 4


def pedir(ruta, datos=None, token=None, cuerpo=None, tipo="application/json"):
    h = {"Content-Type": tipo}
    if token:
        h["Authorization"] = "Bearer " + token
    data = cuerpo if cuerpo is not None else (json.dumps(datos).encode() if datos is not None else None)
    req = urllib.request.Request(URL + ruta, data=data, headers=h, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def multipart(campos, archivo):
    b = uuid.uuid4().hex
    partes = []
    for k, v in campos.items():
        partes.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    partes.append(f'--{b}\r\nContent-Disposition: form-data; name="archivo"; filename="f.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
                  + archivo + b"\r\n")
    partes.append(f"--{b}--\r\n".encode())
    return b"".join(partes), f"multipart/form-data; boundary={b}"


resultados = []


def equipo(usuario, codigo, lat0, lon0):
    t0 = time.time()
    s = pedir("/api/login", {"usuario": usuario, "codigo": codigo})
    tk = s["token"]
    pid = str(uuid.uuid4())
    d = lambda m: m / 111320
    vert = [[lat0, lon0], [lat0, lon0 + d(25)], [lat0 + d(18), lon0 + d(25)], [lat0 + d(18), lon0]]
    items = [{"tipo": "productor", "uuid": pid, "datos": {"nombre": "Prueba", "comunidad": "Campus", "autoriza_datos": True, "autoriza_foto": True}},
             {"tipo": "parcela", "uuid": str(uuid.uuid4()), "datos": {"productor_uuid": pid, "vertices": vert, "precision_media_m": 4}}]
    evs = []
    for i in range(FICHAS):
        eid = str(uuid.uuid4()); evs.append(eid)
        items.append({"tipo": "evaluacion", "uuid": eid, "datos": {"productor_uuid": pid, "plantilla": "campus", "latitud": lat0 + d(5 + i), "longitud": lon0 + d(5),
                      "precision_m": 4, "campos": {"categoria": "Árbol", "nombre_comun": "Prueba", "altura_m": 3, "cantidad": 1, "estado": "Bueno"}}})
    items.append({"tipo": "metrica", "uuid": str(uuid.uuid4()), "datos": {"tarea": "mision", "duracion_s": 1800, "errores": 0}})
    r = pedir("/api/sync/push", {"dispositivo": "prueba_carga", "items": items}, tk)
    malos = [x for x in r["resultados"] if x["estado"] == "error"]
    t_datos = time.time() - t0
    for eid in evs:
        for _ in range(FOTOS):
            cuerpo, ct = multipart({"uuid": str(uuid.uuid4()), "evaluacion_uuid": eid, "tipo": "Prueba"}, b"\xff\xd8\xff" + os.urandom(400_000))
            pedir("/api/evidencias", token=tk, cuerpo=cuerpo, tipo=ct)
    resultados.append((usuario, t_datos, time.time() - t0, len(malos)))


filas = [r for r in csv.DictReader(open(USUARIOS, encoding="utf-8-sig")) if r["rol"] == "tecnico"]
print(f"Simulando {len(filas)} equipos · {FICHAS} fichas y {FICHAS * FOTOS} fotos de 400 KB cada uno contra {URL}")
hilos = []
for i, f in enumerate(filas):
    h = threading.Thread(target=equipo, args=(f["usuario"], f["codigo"], 22.1498 + i * 0.0004, -100.9792))
    hilos.append(h); h.start()
t = time.time()
for h in hilos:
    h.join()
for u, td, tt, m in sorted(resultados):
    print(f"  {u:<16} datos {td:5.1f} s · con fotos {tt:6.1f} s · rechazados {m}")
print(f"Total: {time.time() - t:.1f} s para {len(resultados)} equipos. Si cada equipo tarda menos de 60 s, el servidor y la red alcanzan.")
