# Las cuatro funciones. Cada una con su rol y solo los permisos que usa.
#   mosaicos  zip, arm64    CloudFront → URL de función (OAC)     lee base/ y capas/
#   capas     zip, arm64    API Gateway                          catálogo, POST firmado, rutas
#   teselar   imagen, arm64 S3 entrada/*.geojson                 escribe capas/
#   imagen    imagen, x86   CloudFront → URL de función (OAC)     lee styles/, dibuja PNG
# Antes de `apply`: `npm ci && npm run build` en aws/funciones (deja dist/).

data "aws_iam_policy_document" "asumir_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  secreto_arn = "arn:aws:ssm:us-east-1:${var.cuenta_id}:parameter${local.parametro_secreto}"
  roles = {
    mosaicos = [
      { actions = ["s3:GetObject"], resources = ["${aws_s3_bucket.datos.arn}/base/*", "${aws_s3_bucket.datos.arn}/capas/*"] },
      # Con ListBucket, un archivo que falta responde 404 (NoSuchKey) y no 502 (AccessDenied).
      { actions = ["s3:ListBucket"], resources = [aws_s3_bucket.datos.arn] },
      { actions = ["ssm:GetParameter"], resources = [local.secreto_arn] },
    ]
    capas = [
      { actions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], resources = [aws_dynamodb_table.catalogo.arn] },
      { actions = ["s3:PutObject"], resources = ["${aws_s3_bucket.datos.arn}/entrada/*"] },
      { actions = ["s3:GetObject"], resources = ["${aws_s3_bucket.datos.arn}/styles/*"] },
      { actions = ["ssm:GetParameter"], resources = [local.secreto_arn] },
      { actions = ["geo-routes:CalculateRoutes"], resources = ["arn:aws:geo-routes:us-east-1::provider/default"] },
    ]
    teselar = [
      { actions = ["s3:GetObject"], resources = ["${aws_s3_bucket.datos.arn}/entrada/*"] },
      { actions = ["s3:PutObject"], resources = ["${aws_s3_bucket.datos.arn}/capas/*"] },
      { actions = ["dynamodb:UpdateItem"], resources = [aws_dynamodb_table.catalogo.arn] },
    ]
    imagen = [
      { actions = ["s3:GetObject"], resources = ["${aws_s3_bucket.datos.arn}/styles/*"] },
      { actions = ["ssm:GetParameter"], resources = [local.secreto_arn] },
    ]
  }
}

resource "aws_iam_role" "funcion" {
  for_each           = local.roles
  name               = "${local.p}-role-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.asumir_lambda.json
  tags               = local.componente.api
}

data "aws_iam_policy_document" "funcion" {
  for_each = local.roles
  dynamic "statement" {
    for_each = each.value
    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.funcion[each.key].arn}:*"]
  }
}

resource "aws_iam_role_policy" "funcion" {
  for_each = local.roles
  name     = "${local.p}-policy-${each.key}"
  role     = aws_iam_role.funcion[each.key].id
  policy   = data.aws_iam_policy_document.funcion[each.key].json
}

resource "aws_cloudwatch_log_group" "funcion" {
  for_each          = local.roles
  name              = "/butake/mapas/${var.entorno}/${each.key}"
  retention_in_days = 30
  tags              = local.componente.api
}

# --- mosaicos ---------------------------------------------------------------------------------

data "archive_file" "mosaicos" {
  type        = "zip"
  source_file = "${local.funciones}/mosaicos/index.mjs"
  output_path = "${path.module}/.dist/mosaicos.zip"
}

resource "aws_lambda_function" "mosaicos" {
  function_name    = local.n.mosaicos
  role             = aws_iam_role.funcion["mosaicos"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.mosaicos.output_path
  source_code_hash = data.archive_file.mosaicos.output_base64sha256
  memory_size      = 512
  timeout          = 10
  environment {
    variables = { BUCKET = aws_s3_bucket.datos.id, DOMINIO = var.dominio, PARAMETRO_SECRETO = local.parametro_secreto }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.funcion["mosaicos"].name
  }
  tags = local.componente.api
}

resource "aws_lambda_function_url" "mosaicos" {
  function_name      = aws_lambda_function.mosaicos.function_name
  authorization_type = "AWS_IAM"
}

# --- capas (API) ------------------------------------------------------------------------------

data "archive_file" "capas" {
  type        = "zip"
  source_file = "${local.funciones}/capas/index.mjs"
  output_path = "${path.module}/.dist/capas.zip"
}

resource "aws_lambda_function" "capas" {
  function_name    = local.n.capas
  role             = aws_iam_role.funcion["capas"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.capas.output_path
  source_code_hash = data.archive_file.capas.output_base64sha256
  memory_size      = 512
  timeout          = 15
  environment {
    variables = {
      BUCKET            = aws_s3_bucket.datos.id
      TABLA             = aws_dynamodb_table.catalogo.name
      DOMINIO           = var.dominio
      PARAMETRO_SECRETO = local.parametro_secreto
      MAX_GEOJSON_BYTES = tostring(50 * 1024 * 1024)
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.funcion["capas"].name
  }
  tags = local.componente.api
}

# --- teselar (imagen de contenedor) -----------------------------------------------------------

resource "aws_ecr_repository" "funcion" {
  for_each             = toset(["mapas-teselar", "mapas-imagen"])
  name                 = "butake/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  tags = local.componente.ci
}

resource "aws_ecr_lifecycle_policy" "funcion" {
  for_each   = aws_ecr_repository.funcion
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Quedan las últimas 5"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_lambda_function" "teselar" {
  count         = var.imagen_teselar == "" ? 0 : 1
  function_name = local.n.teselar
  role          = aws_iam_role.funcion["teselar"].arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.funcion["mapas-teselar"].repository_url}:${var.imagen_teselar}"
  architectures = ["arm64"]
  memory_size   = 3008
  timeout       = 900
  ephemeral_storage { size = 4096 }
  environment {
    variables = { TABLA = aws_dynamodb_table.catalogo.name }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.funcion["teselar"].name
  }
  tags = local.componente.api
}

resource "aws_lambda_permission" "teselar_s3" {
  count          = length(aws_lambda_function.teselar)
  statement_id   = "S3Entrada"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.teselar[0].function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.datos.arn
  source_account = var.cuenta_id
}

resource "aws_s3_bucket_notification" "entrada" {
  count  = length(aws_lambda_function.teselar)
  bucket = aws_s3_bucket.datos.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.teselar[0].arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "entrada/"
    filter_suffix       = ".geojson"
  }
  depends_on = [aws_lambda_permission.teselar_s3]
}

# --- imagen (dibujo para PDF) -----------------------------------------------------------------

resource "aws_lambda_function" "imagen" {
  count         = var.imagen_dibujo == "" ? 0 : 1
  function_name = local.n.imagen
  role          = aws_iam_role.funcion["imagen"].arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.funcion["mapas-imagen"].repository_url}:${var.imagen_dibujo}"
  architectures = ["x86_64"]
  memory_size   = 2048
  timeout       = 30
  # Pocas a la vez: cada imagen cuesta cómputo; una ola de pedidos espera en vez de multiplicar el gasto.
  reserved_concurrent_executions = 5
  environment {
    variables = { BUCKET = aws_s3_bucket.datos.id, DOMINIO = var.dominio, PARAMETRO_SECRETO = local.parametro_secreto }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.funcion["imagen"].name
  }
  tags = local.componente.api
}

resource "aws_lambda_function_url" "imagen" {
  count              = length(aws_lambda_function.imagen)
  function_name      = aws_lambda_function.imagen[0].function_name
  authorization_type = "AWS_IAM"
}

# CloudFront (OAC) firma cada pedido; la función solo acepta a esta distribución.
locals {
  urls_de_funcion = merge(
    { mosaicos = aws_lambda_function.mosaicos.function_name },
    length(aws_lambda_function.imagen) > 0 ? { imagen = aws_lambda_function.imagen[0].function_name } : {},
  )
}

resource "aws_lambda_permission" "cloudfront_url" {
  for_each               = local.urls_de_funcion
  statement_id           = "CloudFrontInvocaUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = each.value
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.mapas.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoca" {
  for_each      = local.urls_de_funcion
  statement_id  = "CloudFrontInvoca"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.mapas.arn
}
