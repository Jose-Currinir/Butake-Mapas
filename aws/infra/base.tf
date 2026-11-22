# CodeBuild reconstruye el mapa base (OSM → Planetiler → PMTiles) y publica estilos y fuentes.
# Se corre a mano (`aws codebuild start-build --project-name butake-mapas-prod-base`) o cada
# domingo si `actualizar_semanal = true`. Tarda ~25 min en una máquina ARM de 8 GB.

data "aws_iam_policy_document" "asumir_codebuild" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "base" {
  name               = "${local.p}-role-base"
  assume_role_policy = data.aws_iam_policy_document.asumir_codebuild.json
  tags               = local.componente.ci
}

resource "aws_cloudwatch_log_group" "base" {
  name              = "/butake/mapas/${var.entorno}/base"
  retention_in_days = 30
  tags              = local.componente.ci
}

data "aws_iam_policy_document" "base" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.datos.arn}/receta/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = [for p in ["base", "styles", "fonts", "sprites"] : "${aws_s3_bucket.datos.arn}/${p}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.datos.arn]
  }
  statement {
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.mapas.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.base.arn}:*"]
  }
}

resource "aws_iam_role_policy" "base" {
  name   = "${local.p}-policy-base"
  role   = aws_iam_role.base.id
  policy = data.aws_iam_policy_document.base.json
}

resource "aws_codebuild_project" "base" {
  name          = local.n.base
  description   = "Reconstruye el mapa base de Chile y publica estilos, fuentes y sprite"
  service_role  = aws_iam_role.base.arn
  build_timeout = 90

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../build/buildspec.yml")
  }

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    type            = "ARM_CONTAINER"
    compute_type    = "BUILD_GENERAL1_LARGE" # 8 vCPU / 16 GB: Planetiler con 6 GB y Docker
    image           = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    privileged_mode = true # Planetiler y go-pmtiles corren en Docker, como en la máquina actual
    environment_variable {
      name  = "BUCKET"
      value = aws_s3_bucket.datos.id
    }
    environment_variable {
      name  = "DOMINIO"
      value = var.dominio
    }
    environment_variable {
      name  = "DISTRIBUCION"
      value = aws_cloudfront_distribution.mapas.id
    }
  }

  logs_config {
    cloudwatch_logs { group_name = aws_cloudwatch_log_group.base.name }
  }

  tags = local.componente.ci
}

# Programación semanal (apagada por omisión).
data "aws_iam_policy_document" "asumir_scheduler" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "programa" {
  name               = "${local.p}-role-programa"
  assume_role_policy = data.aws_iam_policy_document.asumir_scheduler.json
  tags               = local.componente.ci
}

resource "aws_iam_role_policy" "programa" {
  name = "${local.p}-policy-programa"
  role = aws_iam_role.programa.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "codebuild:StartBuild", Resource = aws_codebuild_project.base.arn }]
  })
}

resource "aws_scheduler_schedule" "base" {
  name                         = "${local.p}-base-semanal"
  state                        = var.actualizar_semanal ? "ENABLED" : "DISABLED"
  schedule_expression          = "cron(0 6 ? * SUN *)"
  schedule_expression_timezone = "America/Santiago"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:codebuild:startBuild"
    role_arn = aws_iam_role.programa.arn
    input    = jsonencode({ ProjectName = aws_codebuild_project.base.name })
  }
}
