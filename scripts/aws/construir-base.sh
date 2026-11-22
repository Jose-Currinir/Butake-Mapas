#!/usr/bin/env bash
#
# Construye el mapa base de Chile y lo publica en S3 para la versión sin servidor de
# Butake-Mapas. Lo corre CodeBuild (aws/build/buildspec.yml); también sirve en una máquina con
# Docker, curl, sqlite3, python3 y la CLI de AWS.
#
# Pasos (los mismos scripts que la versión con TileServer):
#   1. OSM de Geofabrik → Planetiler → chile.mbtiles     (fetch-pbf.sh, build-tiles.sh)
#   2. Relieve y Natural Earth                            (build-terrain.sh, fetch-natural-earth.sh)
#   3. Nombres y atribución en los metadatos              (label-tilesets.sh)
#   4. .mbtiles → .pmtiles                                (go-pmtiles)
#   5. Estilos con URLs de https://$DOMINIO, fuentes y sprite  (publicar-estilos.py)
#   6. Sube todo a s3://$BUCKET y vacía la caché de CloudFront de lo que cambió
#
# Uso:  BUCKET=… DOMINIO=mapas.butake.cl DISTRIBUCION=E123… ./scripts/aws/construir-base.sh
#       SOLO_ESTILOS=1 …   publica solo estilos, fuentes y sprite (sin regenerar el mapa)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${BUCKET:?Falta BUCKET}"
: "${DOMINIO:?Falta DOMINIO}"
TRABAJO="${TRABAJO:-$RAIZ/.construir}"
PMTILES_IMAGE="${PMTILES_IMAGE:-protomaps/go-pmtiles:v1.30.3}"
SALIDA="$TRABAJO/salida"

mkdir -p "$TRABAJO/data" "$SALIDA/base"
# Los datos fuera del repo; los estilos, fuentes y sprite se leen del repo.
cp -R "$RAIZ/data/styles" "$RAIZ/data/sprites" "$RAIZ/data/fonts" "$TRABAJO/data/" 2>/dev/null || true
ENV_FILE="$TRABAJO/.env.aws"
cat >"$ENV_FILE" <<ENV
DATA_PATH=$TRABAJO/data
ACTIVE_COUNTRY=chile
MAPS_PRIMARY_TILESET=chile.mbtiles
MAPS_BACKGROUND_TILESET=natural_earth.mbtiles
ENV

if [[ "${SOLO_ESTILOS:-0}" != "1" ]]; then
  # Geofabrik a veces rechaza conexiones desde rangos de AWS (CodeBuild): si falla, el espejo de
  # openstreetmap.fr publica el mismo extracto con su .md5.
  bajar() {
    set +e
    bash "$RAIZ/scripts/fetch-pbf.sh" "$ENV_FILE" --force
    local codigo=$?
    set -e
    (( codigo == 0 || codigo == 3 ))
  }
  if ! bajar; then
    echo "Geofabrik no respondió; uso el espejo de openstreetmap.fr."
    echo "OSM_EXTRACT_URL=https://download.openstreetmap.fr/extracts/south-america/chile.osm.pbf" >>"$ENV_FILE"
    bajar
  fi
  pbf_dir="$TRABAJO/data/countries/chile"
  [[ -f "$pbf_dir/map.osm.pbf.new" ]] && mv "$pbf_dir/map.osm.pbf.new" "$pbf_dir/map.osm.pbf"

  PLANETILER_MEMORY="${PLANETILER_MEMORY:-6g}" bash "$RAIZ/scripts/build-tiles.sh" "$ENV_FILE"
  bash "$RAIZ/scripts/build-terrain.sh" "$ENV_FILE"
  bash "$RAIZ/scripts/fetch-natural-earth.sh" "$ENV_FILE"
  bash "$RAIZ/scripts/label-tilesets.sh" "$ENV_FILE"

  convertir() {
    echo "Convirtiendo $1.mbtiles a PMTiles..."
    docker run --rm --user "$(id -u):$(id -g)" -v "$TRABAJO/data/mbtiles:/entrada" -v "$SALIDA/base:/salida" \
      "$PMTILES_IMAGE" convert "/entrada/$1.mbtiles" "/salida/$2.pmtiles"
    docker run --rm -v "$SALIDA/base:/salida" "$PMTILES_IMAGE" verify "/salida/$2.pmtiles"
  }
  convertir chile openmaptiles
  convertir natural_earth natural_earth
  convertir terrain terrain
fi

python3 -I "$RAIZ/scripts/aws/publicar-estilos.py" --dominio "$DOMINIO" --data "$RAIZ/data" --salida "$SALIDA"

echo "Subiendo a s3://$BUCKET..."
if [[ "${SOLO_ESTILOS:-0}" != "1" ]]; then
  # Archivo nuevo completo antes de que alguien lo lea: la Lambda compara el ETag en cada lectura.
  aws s3 cp "$SALIDA/base/" "s3://$BUCKET/base/" --recursive --content-type application/vnd.pmtiles --only-show-errors
fi
aws s3 cp "$SALIDA/styles/" "s3://$BUCKET/styles/" --recursive --content-type application/json --cache-control "public, max-age=300, s-maxage=3600" --only-show-errors
aws s3 cp "$SALIDA/fonts/" "s3://$BUCKET/fonts/" --recursive --content-type application/x-protobuf --cache-control "public, max-age=604800" --only-show-errors
aws s3 cp "$SALIDA/sprites/" "s3://$BUCKET/sprites/" --recursive --cache-control "public, max-age=86400" --only-show-errors

if [[ -n "${DISTRIBUCION:-}" ]]; then
  rutas=("/styles/*" "/sprites/*")
  [[ "${SOLO_ESTILOS:-0}" == "1" ]] || rutas+=("/base/*")
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUCION" --paths "${rutas[@]}" --query Invalidation.Id --output text
fi
echo "Listo: https://$DOMINIO/styles/cl-light/style.json"
