#!/usr/bin/env bash
#
# Sube a S3 lo que CodeBuild necesita para reconstruir el mapa base: los scripts y data/ ligeros
# (estilos, sprite, fuentes, perfiles), sin datos pesados ni archivos locales. Sale de `git`, así
# que solo viaja lo que está en el commit actual.
#
# Uso:  AWS_PROFILE=butake-mapas-admin BUCKET=butake-mapas-prod-datos-<cuenta> ./scripts/aws/subir-receta.sh
#       … y después:  aws codebuild start-build --project-name butake-mapas-prod-base
set -euo pipefail
: "${BUCKET:?Falta BUCKET}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ"
[[ -z "$(git status --porcelain -- scripts data)" ]] || { echo "Hay cambios sin commit en scripts/ o data/: la receta sale del commit." >&2; exit 1; }
zip="$(mktemp -d)/receta.zip"
git archive --format=zip -o "$zip" HEAD scripts data
aws s3 cp "$zip" "s3://$BUCKET/receta/receta.zip" --only-show-errors
echo "Receta $(git rev-parse --short HEAD) en s3://$BUCKET/receta/receta.zip"
