# Butake-Mapas sin servidor en AWS (cuenta propia `butake-mapas-prod`, D-002 de Butake-Base).
#
#   terraform init -backend-config=estado.hcl     # estado.hcl sale de estado.hcl.example
#   terraform plan  -var-file=prod.tfvars         # solo lee
#   terraform apply -var-file=prod.tfvars         # muestra el plan y pide «yes»
#
# Antes del primer plan: la cuenta, el perfil `butake-mapas-admin`, el bucket del estado y el
# parámetro SSM del secreto de firma (ver aws/README.md, «Primera vez»).

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.20" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
  # Estado cifrado en S3, uno por cuenta (como los productos). Valores en estado.hcl.
  backend "s3" {}
}

provider "aws" {
  region              = "us-east-1"
  profile             = var.perfil
  allowed_account_ids = [var.cuenta_id]
  default_tags { tags = local.etiquetas }
}
