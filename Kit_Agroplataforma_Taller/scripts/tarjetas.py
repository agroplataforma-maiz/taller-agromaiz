#!/usr/bin/env python3
"""Genera tarjetas.html (para imprimir y recortar) con el usuario y código de cada persona.
Uso: python3 scripts/tarjetas.py data/usuarios.csv https://taller.agromaiz.mx > tarjetas.html"""
import csv, html, sys
fil = list(csv.DictReader(open(sys.argv[1] if len(sys.argv) > 1 else "data/usuarios.csv", encoding="utf-8-sig")))
url = sys.argv[2] if len(sys.argv) > 2 else "https://taller.agromaiz.mx"
roles = {"tecnico": "Técnico de campo", "productor": "Productor / responsable", "investigador": "Investigador",
         "analista": "Analista de datos", "cronometrista": "Cronometrista", "admin": "Administrador"}
print("""<!doctype html><meta charset="utf-8"><title>Tarjetas</title><style>
body{font-family:system-ui,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
.t{border:1px dashed #999;border-radius:3mm;padding:4mm;break-inside:avoid}.e{font-size:9pt;color:#2A5C3F;font-weight:700}
.r{font-size:10pt;color:#555}.u{font:700 13pt monospace;margin-top:2mm}.c{font:700 16pt monospace;color:#C8820A}.l{font-size:8pt;color:#555;margin-top:2mm}
</style><div class="g">""")
for f in fil:
    if f["rol"] == "admin":
        continue
    print(f'<div class="t"><div class="e">{html.escape(f["nombre_equipo"])}</div><div class="r">{roles.get(f["rol"], f["rol"])}</div>'
          f'<div class="u">{html.escape(f["usuario"])}</div><div class="c">{html.escape(f["codigo"])}</div>'
          f'<div class="l">App: {url}/movil/ · Web: {url}/web/</div></div>')
print("</div>")
