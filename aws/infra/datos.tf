# Un bucket privado con todo lo que se sirve. Nadie lo lee directo: CloudFront (OAC) para
# estilos, fuentes y sprite; las Lambdas para los PMTiles.
#
#   base/      openmaptiles.pmtiles, natural_earth.pmtiles, terrain.pmtiles   (CodeBuild)
#   styles/    cl-light.json, cl-dark.json (+ <estilo>/style.json)            (CodeBuild)
#   fonts/     sprites/                                                       (CodeBuild)
#   entrada/   GeoJSON subidos por los productos; se borran a los 7 días      (POST firmado)
#   capas/     <cuenta>/<capa>.pmtiles                                        (teselar)
#   receta/    receta.zip para CodeBuild                                      (subir-receta.sh)

resource "aws_s3_bucket" "datos" {
  bucket = local.n.bucket
  tags   = local.componente.datos
}

resource "aws_s3_bucket_public_access_block" "datos" {
  bucket                  = aws_s3_bucket.datos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "datos" {
  bucket = aws_s3_bucket.datos.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "datos" {
  bucket = aws_s3_bucket.datos.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versiones: una capa o un mapa base reemplazado por error se puede recuperar 30 días.
resource "aws_s3_bucket_versioning" "datos" {
  bucket = aws_s3_bucket.datos.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "datos" {
  bucket     = aws_s3_bucket.datos.id
  depends_on = [aws_s3_bucket_versioning.datos]

  rule {
    id     = "entrada-7-dias"
    status = "Enabled"
    filter { prefix = "entrada/" }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }

  rule {
    id     = "versiones-viejas-30-dias"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

# El POST firmado de subida viene del navegador del producto.
resource "aws_s3_bucket_cors_configuration" "datos" {
  bucket = aws_s3_bucket.datos.id
  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = var.origenes_subida
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "datos" {
  statement {
    sid       = "CloudFrontLeeArchivosFijos"
    actions   = ["s3:GetObject"]
    resources = concat([for p in ["styles", "fonts", "sprites"] : "${aws_s3_bucket.datos.arn}/${p}/*"], ["${aws_s3_bucket.datos.arn}/index.html"])
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.mapas.arn]
    }
  }
  statement {
    sid       = "SoloTLS"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.datos.arn, "${aws_s3_bucket.datos.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "datos" {
  bucket     = aws_s3_bucket.datos.id
  policy     = data.aws_iam_policy_document.datos.json
  depends_on = [aws_s3_bucket_public_access_block.datos]
}

# Catálogo de capas y claves de API (una tabla: pk/sk).
#   CLAVE#<sha256> / CLAVE           cuenta, nombre, activa
#   CUENTA#<cuenta> / CAPA#<uuid>    nombre, estado, límites, zooms, quién y cuándo
resource "aws_dynamodb_table" "catalogo" {
  name         = local.n.tabla
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  # Sin `server_side_encryption`: DynamoDB cifra siempre con su llave propia (gratis). Con `enabled =
  # true` pide la llave KMS aws/dynamodb, que en una cuenta recién creada aún no existe.
  deletion_protection_enabled = true
  tags                        = local.componente.datos
}
