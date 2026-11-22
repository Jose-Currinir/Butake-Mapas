# Butake-Mapas sin servidor (AWS)

El mapa de Chile, las capas de cada cuenta, las rutas con tráfico y las imágenes para PDF, sin
máquinas encendidas: S3 guarda los datos, CloudFront los entrega y unas Lambdas chicas responden
lo que no es un archivo fijo. Reemplaza a TileServer GL + GraphHopper en una EC2 (que hoy responde
530 en `mapa.butake.cl`).

```
mapas.butake.cl ─ CloudFront ─┬─ /styles /fonts /sprites ──────────── S3 (archivos fijos)
                              ├─ /base/<archivo>/{z}/{x}/{y} ── Lambda mosaicos ── base/*.pmtiles
                              ├─ /capas/<cuenta>/<capa>/{z}/{x}/{y}?t=… ─┘   └─ capas/*.pmtiles
                              └─ /imagen?…&firma=… ───────────── Lambda imagen (PNG para PDF)

api-mapas.butake.cl ─ API Gateway ─ Lambda capas ─┬─ DynamoDB (catálogo y claves)
                                                  ├─ S3 entrada/ ─► Lambda teselar ─► capas/
                                                  └─ Amazon Location (rutas con tráfico)

CodeBuild (a mano o cada domingo): OSM → Planetiler → PMTiles → S3, y vacía la caché.
```

## Cómo funciona PMTiles

Un mapa vectorial son millones de mosaicos chicos: uno por zoom y por cuadrado
(`z/x/y`). TileServer los guardaba en un `.mbtiles` (una base SQLite) y necesitaba un proceso
encendido para buscarlos. PMTiles los guarda en **un solo archivo ordenado**, con un índice al
principio, pensado para leerse por trozos:

```
chile.pmtiles
┌────────────┬───────────────┬────────────────┬──────────────────────────────────────┐
│ encabezado │ índice raíz   │ metadatos      │ mosaicos, uno detrás de otro          │
│ 127 bytes  │ (comprimido)  │ (capas, attr.) │ ordenados por curva de Hilbert        │
└────────────┴───────────────┴────────────────┴──────────────────────────────────────┘
      │              │
      │              └── «el mosaico 12/1234/2345 está en el byte 81.203.554 y mide 9.120»
      └── dónde está el índice, zooms, límites, tipo (mvt/png) y compresión
```

Para entregar `12/1234/2345`:

1. La Lambda lee los primeros 16 KB del archivo **una vez** (encabezado + índice raíz) y los deja
   en memoria.
2. Convierte `z/x/y` en un número (posición en la curva de Hilbert) y lo busca en el índice. Si
   cae en un índice de hoja, lo lee una vez y también lo guarda.
3. Pide a S3 **solo esos bytes** (`Range: bytes=81203554-81212673`).
4. Lo devuelve comprimido; CloudFront lo guarda y los siguientes pedidos ni llegan a la Lambda.

En caliente, cada mosaico nuevo es **una lectura por rango a S3**. Por eso no hace falta un
servidor: el «servidor» es S3 leyendo trozos de un archivo. La curva de Hilbert deja juntos los
mosaicos vecinos, así que un mapa que se mueve pide bytes cercanos.

La Lambda está solo para que los clientes sigan pidiendo `{z}/{x}/{y}` como siempre (web,
Android e iOS sin cambios) y para revisar el token de las capas privadas. MapLibre también podría
leer el `.pmtiles` directo por rango (`pmtiles://…`), pero así no se podría proteger una capa por
cuenta ni cambiar el archivo sin tocar los clientes.

## Piezas

| Pieza | Qué hace | Dónde |
|---|---|---|
| `aws/funciones/src/mosaicos.js` | `{z}/{x}/{y}` → lectura por rango del PMTiles; TileJSON | Lambda zip arm64 |
| `aws/funciones/src/capas.js` | API de capas, acceso del día, estilos con capas, imágenes firmadas, rutas | Lambda zip arm64 |
| `aws/funciones/src/teselar.js` | GeoJSON subido → PMTiles con tippecanoe | Lambda imagen arm64 |
| `aws/funciones/src/imagen.js` | PNG del mapa con marcas y recorrido (para PDF) | Lambda imagen x86_64 |
| `scripts/aws/construir-base.sh` | mapa base, relieve, Natural Earth, estilos → S3 | CodeBuild |
| `aws/infra/` | todo lo anterior en Terraform | cuenta `butake-mapas-prod` |

## API (`https://api-mapas.butake.cl/v1`)

La llaman los **servidores** de los productos con `Authorization: Bearer <clave>`; el navegador
nunca ve la clave. Una clave = una cuenta-cliente (por ejemplo `movil`).

| Pedido | Respuesta |
|---|---|
| `POST /v1/capas {nombre}` | `id` y un POST firmado a S3 (15 min, hasta 50 MB, `application/geo+json`) |
| `GET /v1/capas`, `GET /v1/capas/{id}` | estado: `esperando` → `procesando` → `lista` o `error` (con motivo) |
| `DELETE /v1/capas/{id}` | la archiva: deja de servirse, el archivo queda (historial) |
| `POST /v1/acceso` | token del día y plantilla de URL de mosaicos de la cuenta |
| `GET /v1/estilos/{cl-light\|cl-dark}?capas=a,b` | style.json listo para MapLibre, con las capas encima |
| `POST /v1/imagenes {estilo, centro, zoom, ancho, alto, marcas?, linea?}` | URL firmada del PNG (1 hora) |
| `POST /v1/rutas {origen, destino, paradas?, salida?, evitarZonas?}` | distancia, duración y línea, con tráfico |

Las zonas a evitar son las de `data/car_avoid.json` (las mismas de GraphHopper).

## Primera vez

Lo hace José (cuenta, contraseña y el «yes» final); el resto lo dejan listo los scripts.

1. Crear la cuenta `butake-mapas-prod` en Organizations y el perfil `butake-mapas-admin` (SSO).
2. Bucket del estado: `butake-mapas-prod-tfstate-<cuenta>` (cifrado, versionado, sin acceso público).
3. Secreto de firma (SSM, nunca en el repo):
   `aws ssm put-parameter --profile butake-mapas-admin --name /butake/mapas/prod/firma/SECRETO --type SecureString --value "$(openssl rand -base64 48)"`
4. Funciones: `cd aws/funciones && npm ci && npm test && npm run build`.
5. `cd aws/infra`, copiar `estado.hcl.example` y `prod.tfvars.example`, `terraform init -backend-config=estado.hcl`,
   `terraform plan -var-file=prod.tfvars` y `terraform apply -var-file=prod.tfvars`.
6. Cargar en Cloudflare (nube gris) los registros de `terraform output dns`: validación del
   certificado y los dos CNAME.
7. Imágenes de contenedor (teselar e imagen): construir, subir a ECR y poner sus etiquetas en
   `prod.tfvars`; `terraform apply` crea esas dos funciones.
   ```bash
   docker build --platform linux/arm64 -f teselar.Dockerfile -t <ecr>/butake/mapas-teselar:<commit> .
   docker build --platform linux/amd64 -f imagen.Dockerfile  -t <ecr>/butake/mapas-imagen:<commit> .
   ```
8. Mapa base: `BUCKET=… ./scripts/aws/subir-receta.sh` y
   `aws codebuild start-build --project-name butake-mapas-prod-base` (~25 min).
9. Clave para Móvil: `node aws/funciones/herramientas/clave.mjs crear --tabla butake-mapas-prod-catalogo --cuenta movil --nombre "Butake Móvil prod"`
   y guardarla en el SSM de Móvil.

## Costo

| Qué | Al mes |
|---|---|
| S3 (~0,9 GB base + capas) | ~0,02 USD |
| CloudFront | 0 dentro de la capa gratis permanente (1 TB y 10 M pedidos) |
| Lambda mosaicos y capas | 0 dentro de la capa gratis (1 M pedidos); la caché absorbe casi todo |
| DynamoDB | centavos (por pedido) |
| CodeBuild semanal (~25 min ARM grande) | ~0,6 USD si se activa |
| Imágenes para PDF | ~0,000033 USD por imagen (2 GB, ~1 s) |
| Rutas (Amazon Location) | por pedido; ver precio vigente |

Todo es de AWS: lo cubren los créditos promocionales. El presupuesto `butake-mapas-consumo` avisa
al 80 % del monto de `presupuesto_usd`.

## Pausar sin borrar

No hay nada encendido que apagar: si nadie pide mapas, el costo es el del almacenamiento
(centavos). Para cortar el acceso del todo sin perder datos:

- `enabled = false` en la distribución (`aws_cloudfront_distribution.mapas`) y `terraform apply`.
- Desactivar las claves de API (`clave.mjs quitar`).
- Dejar `actualizar_semanal = false`.

## Estado (2026-11-22)

| Pieza | Estado |
|---|---|
| Cuenta `butake-mapas-prod` (678357652266), perfil `butake-mapas-admin` | ✓ |
| Terraform `aws/infra` aplicado (estado en `butake-mapas-prod-tfstate-678357652266`) | ✓ |
| `mapas.butake.cl` (CloudFront `E2PVO3O0C5QZ2T`) y `api-mapas.butake.cl` (DNS en Cloudflare, nube gris) | ✓ |
| Visor en la raíz (`aws/visor/index.html`) | ✓ |
| Mapa base de Chile (`base/*.pmtiles`, CodeBuild `butake-mapas-prod-base`) | ✓ |
| Estilos `cl-light` / `cl-dark`, fuentes y sprite | ✓ |
| API de capas: catálogo, subida firmada, acceso del día, estilo con capas, imágenes firmadas, rutas | ✓ desplegada |
| Función `teselar` (convierte la capa subida) | ✓ desplegada (imagen `6de1917`); probar con `scripts/aws/probar-capa.sh` |
| Función `imagen` (PNG para PDF) | ✓ probada: ~5 s en caliente, ~50 s la primera vez |
| Clave de API | Móvil: en `/butake/movil/prod/api/MAPAS_CLAVE` (SSM de Móvil) |
| Tope de Lambdas a la vez | 10 (cuenta nueva); pedido 1000, caso abierto. Con la caché fría algunos mosaicos dan 429. Mientras, `imagen_a_la_vez = -1` (sin reserva) |
| Actualización semanal | apagada (`actualizar_semanal = false`) |

## Pendiente

1. Cuando AWS apruebe el tope: `imagen_a_la_vez = 5` y `terraform apply`.
2. Clientes: Móvil web (`PUBLIC_MAP_STYLE`) y Android (`flota.mapStyleUrl`, hoy
   `maps.butake.cl/…/urban-gray`, que no existe) a `https://mapas.butake.cl/styles/cl-light/style.json`.
3. Capas en el Web Kit (`web-core`): pedir el estilo con capas al servidor del producto.
4. Retirar TileServer, GraphHopper y el túnel de `mapa.butake.cl` / `ruta.butake.cl` cuando los clientes estén migrados.

Geofabrik a veces rechaza descargas desde AWS: `construir-base.sh` usa entonces el espejo de
openstreetmap.fr.
