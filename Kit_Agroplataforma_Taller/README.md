# Kit del taller · Agroplataforma

Servidor ligero para talleres de campo de la Agroplataforma (proyecto SECIHTI PEE-2025-G-369, TecNM – IT Ciudad Valles).

| Ruta | Qué es | Quién la usa |
|---|---|---|
| `/movil/` | App de campo instalable (PWA): trabaja sin señal, GPS con promedio de lecturas, polígono caminando, fichas, fotos, cola y sincronización, cronómetro | Técnico de campo y cronometrista (teléfono) |
| `/web/` | Plataforma: mapa, fichas, validación, evidencias, métricas de uso, exportación, administración | Investigador, analista, productor, invitado, administrador |
| `/api/` | Servicios REST en JSON | App y web |

Los nombres de tablas siguen el modelo de la Agroplataforma (productor, consentimiento, parcela, ubicacion, evaluacion, evidencia) para migrar después a la plataforma real (`scripts/exportar_agromaiz.py`).

## Requisito clave: HTTPS

Los teléfonos **solo dan GPS y cámara a páginas con `https://`** (o `localhost`). Por eso el despliegue usa Caddy (certificado automático) o un túnel con HTTPS.

## Opción 1 · Servidor con dominio (recomendada)

Un servidor Linux con Docker (1 vCPU, 1 GB de RAM, 10 GB de disco alcanzan para 60 personas) y un subdominio (p. ej. `taller.agromaiz.mx`) apuntando a su IP.

```bash
cp .env.ejemplo .env        # edita DOMINIO, SEDE_LAT, SEDE_LON, ADMIN_CODIGO, N_EQUIPOS, PLANTILLA
docker compose up -d --build
docker compose logs -f app  # la primera vez genera data/usuarios.csv con los códigos
```

Abre `https://TU_DOMINIO/web/` y entra como `admin`.

## Opción 2 · Laptop + túnel HTTPS (sin servidor)

```bash
pip install -r requirements.txt
DATA_DIR=./data PLANTILLA=campus N_EQUIPOS=12 ADMIN_CODIGO=xxxx SEDE_LAT=.. SEDE_LON=.. \
  uvicorn app.main:app --host 0.0.0.0 --port 8000
cloudflared tunnel --url http://localhost:8000     # imprime una URL https://….trycloudflare.com
```

La URL del túnel cambia cada vez que se inicia: genera las tarjetas después de iniciarlo. La laptop debe quedar encendida, conectada y sin suspenderse.

## Configuración (`.env`)

| Variable | Valor | Para qué |
|---|---|---|
| `PLANTILLA` | `campus` o `maiz` | Campos de la ficha (elementos del campus o mazorca) |
| `N_EQUIPOS` | 12 | Equipos que se generan en `data/usuarios.csv` |
| `SEDE_LAT`, `SEDE_LON` | grados decimales | Centro del mapa |
| `ADMIN_CODIGO` | texto largo | Código del usuario `admin` |
| `ORGANIZACION` | texto | Nombre que se muestra |
| `MAX_FOTO_MB` | 8 | Tamaño máximo por foto |

Usuarios: `data/usuarios.csv` (`usuario,equipo,rol,codigo,nombre_equipo`). Roles: `tecnico`, `productor`, `investigador`, `analista`, `cronometrista`, `admin`. Si lo editas, reinicia el servicio.

## Scripts

```bash
python3 scripts/tarjetas.py data/usuarios.csv https://TU_DOMINIO > tarjetas.html   # imprimir y recortar
python3 scripts/datos_ejemplo.py https://TU_DOMINIO data/usuarios.csv              # ensayo (luego reiniciar)
python3 scripts/prueba_carga.py https://TU_DOMINIO data/usuarios.csv 2             # 12 equipos a la vez
python3 scripts/exportar_agromaiz.py data/taller.db exportacion/                   # CSV para la plataforma real
```

## Respaldo

Todo vive en `data/` (base SQLite `taller.db` y `fotos/`). Copia esa carpeta al terminar. **Administración → Reiniciar** guarda un respaldo en `data/respaldos/` antes de dejar todo en limpio.

## API (resumen)

`POST /api/login` · `GET /api/config` · `POST /api/sync/push` (lote idempotente por UUID) · `POST /api/evidencias` (multipart) · `GET /api/datos` (filtrado por rol) · `PATCH /api/evaluaciones/{uuid}/validacion` · `GET /api/metricas` · `GET /api/export/fichas.csv|metricas.csv|parcelas.geojson` · `POST /api/admin/reiniciar`.
Documentación interactiva: `https://TU_DOMINIO/docs`.
