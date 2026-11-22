#!/usr/bin/env bash
#
# Primera puesta en marcha de Butake-Mapas sin servidor. Lo corre una persona (crea buckets y
# aplica Terraform), en este orden:
#
#   ./scripts/aws/primera-vez.sh estado        # bucket del estado de Terraform (una vez)
#   ./scripts/aws/primera-vez.sh certificado   # crea el certificado y muestra los registros DNS
#        … cargar en Cloudflare (nube gris) los registros de validación …
#   ./scripts/aws/primera-vez.sh todo          # espera la validación y crea lo demás; muestra los CNAME
#        … cargar en Cloudflare los dos CNAME …
#
# Requisitos: perfil SSO butake-mapas-admin (aws sso login --sso-session butake), terraform,
# node 22+, el secreto /butake/mapas/prod/firma/SECRETO en SSM, y aws/infra/estado.hcl +
# aws/infra/prod.tfvars (salen de los .example).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERFIL="${PERFIL:-butake-mapas-admin}"
CUENTA="$(aws sts get-caller-identity --profile "$PERFIL" --query Account --output text)"
ESTADO="butake-mapas-prod-tfstate-$CUENTA"
INFRA="$RAIZ/aws/infra"

etiquetas='TagSet=[{Key=butake:proyecto,Value=mapas},{Key=butake:entorno,Value=prod},{Key=butake:fase,Value=produccion},{Key=butake:componente,Value=ci},{Key=butake:responsable,Value=jose@butake.cl}]'

preparar() {
  [[ -f "$INFRA/estado.hcl" && -f "$INFRA/prod.tfvars" ]] || { echo "Faltan aws/infra/estado.hcl y prod.tfvars (copia los .example)." >&2; exit 1; }
  echo "1/4 Secreto de firma en SSM..."
  aws ssm get-parameter --profile "$PERFIL" --name /butake/mapas/prod/firma/SECRETO --query Parameter.Version --output text >/dev/null
  echo "2/4 Dependencias y pruebas de las funciones..."
  (cd "$RAIZ/aws/funciones" && npm ci --no-audit --no-fund --loglevel=error && npm test --silent > /tmp/butake-mapas-pruebas.log 2>&1) \
    || { echo "Fallaron las pruebas; detalle en /tmp/butake-mapas-pruebas.log" >&2; tail -20 /tmp/butake-mapas-pruebas.log >&2; exit 1; }
  echo "3/4 Empaquetado..."
  (cd "$RAIZ/aws/funciones" && npm run build --silent >/dev/null)
  echo "4/4 terraform init..."
  terraform -chdir="$INFRA" init -input=false -backend-config=estado.hcl >/dev/null
}

trap 'echo "Se detuvo en la línea $LINENO (código $?)." >&2' ERR

case "${1:-}" in
  estado)
    if aws s3api head-bucket --profile "$PERFIL" --bucket "$ESTADO" 2>/dev/null; then
      echo "Ya existe s3://$ESTADO"
      exit 0
    fi
    aws s3api create-bucket --profile "$PERFIL" --bucket "$ESTADO" --region us-east-1 >/dev/null
    aws s3api put-public-access-block --profile "$PERFIL" --bucket "$ESTADO" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-versioning --profile "$PERFIL" --bucket "$ESTADO" --versioning-configuration Status=Enabled
    aws s3api put-bucket-encryption --profile "$PERFIL" --bucket "$ESTADO" \
      --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    aws s3api put-bucket-tagging --profile "$PERFIL" --bucket "$ESTADO" --tagging "$etiquetas"
    echo "Estado listo: s3://$ESTADO (privado, versionado, cifrado)"
    ;;
  certificado)
    preparar
    terraform -chdir="$INFRA" apply -input=false -var-file=prod.tfvars -target=aws_acm_certificate.mapas
    echo
    echo "Carga en Cloudflare (DNS > Agregar registro, nube gris) estos CNAME de validación:"
    terraform -chdir="$INFRA" output -json dns 2>/dev/null | python3 -c 'import json,sys; [print(f"  {v[\"tipo\"]}  {v[\"nombre\"]}  ->  {v[\"valor\"]}") for v in json.load(sys.stdin)["validacion"]]' 2>/dev/null \
      || aws acm list-certificates --profile "$PERFIL" --region us-east-1 --query 'CertificateSummaryList[?DomainName==`mapas.butake.cl`].CertificateArn' --output text \
        | xargs -I{} aws acm describe-certificate --profile "$PERFIL" --region us-east-1 --certificate-arn {} --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
    echo "Después: ./scripts/aws/primera-vez.sh todo"
    ;;
  todo)
    preparar
    terraform -chdir="$INFRA" apply -input=false -var-file=prod.tfvars
    echo
    echo "Carga en Cloudflare (nube gris) estos CNAME:"
    terraform -chdir="$INFRA" output -json dns | python3 -c 'import json,sys; [print(f"  CNAME  {k}  ->  {v}") for k,v in json.load(sys.stdin)["cname"].items()]'
    ;;
  *)
    echo "Uso: $0 estado | certificado | todo" >&2
    exit 2
    ;;
esac
