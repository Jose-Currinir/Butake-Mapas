#!/usr/bin/env bash
# Prueba la API de capas de punta a punta: crea una capa, sube un GeoJSON chico y espera a
# que `teselar` la deje `lista`.
#
#   bash scripts/aws/probar-capa.sh
#
# Lee la clave de Móvil desde su SSM (perfil butake-movil-admin).
set -euo pipefail

API=${API:-https://api-mapas.butake.cl/v1}
CLAVE=$(aws ssm get-parameter --profile "${PERFIL_MOVIL:-butake-movil-admin}" --region us-east-1 \
  --name /butake/movil/prod/api/MAPAS_CLAVE --with-decryption --query Parameter.Value --output text)
TRABAJO=$(mktemp -d)
trap 'rm -rf "$TRABAJO"' EXIT

cat > "$TRABAJO/capa.geojson" <<'GEO'
{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"nombre":"Zona prueba"},
"geometry":{"type":"Polygon","coordinates":[[[-70.66,-33.46],[-70.63,-33.46],[-70.63,-33.43],[-70.66,-33.43],[-70.66,-33.46]]]}}]}
GEO

curl -sf -X POST "$API/capas" -H "Authorization: Bearer $CLAVE" -H 'content-type: application/json' \
  -d '{"nombre":"Prueba"}' > "$TRABAJO/capa.json"

ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$TRABAJO/capa.json")
echo "Capa $ID creada. Subiendo..."

# Arma los -F del POST firmado de S3 (los campos van antes del archivo).
CAMPOS=()
while IFS= read -r -d '' campo; do CAMPOS+=(-F "$campo"); done < <(python3 -c '
import json,sys
s=json.load(open(sys.argv[1]))["subida"]
for k,v in (s.get("campos") or s.get("fields")).items(): sys.stdout.write(f"{k}={v}\0")
' "$TRABAJO/capa.json")
URL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["subida"]["url"])' "$TRABAJO/capa.json")
curl -sf -o /dev/null -w "Subida: %{http_code}\n" "${CAMPOS[@]}" -F "file=@$TRABAJO/capa.geojson;type=application/geo+json" "$URL"

for _ in $(seq 1 30); do
  ESTADO=$(curl -sf "$API/capas/$ID" -H "Authorization: Bearer $CLAVE" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["estado"], d.get("motivo",""))')
  echo "Estado: $ESTADO"
  case "$ESTADO" in lista*|error*) break ;; esac
  sleep 5
done
