# Avisos por correo: errores de las funciones, un mapa base que no se pudo reconstruir y gasto.

resource "aws_sns_topic" "alertas" {
  name = local.n.alertas
  tags = local.componente.alerta
}

resource "aws_sns_topic_subscription" "correo" {
  topic_arn = aws_sns_topic.alertas.arn
  protocol  = "email"
  endpoint  = var.responsable
}

locals {
  alarmas_de_funcion = merge(
    { mosaicos = aws_lambda_function.mosaicos.function_name, capas = aws_lambda_function.capas.function_name },
    length(aws_lambda_function.teselar) > 0 ? { teselar = aws_lambda_function.teselar[0].function_name } : {},
    length(aws_lambda_function.imagen) > 0 ? { imagen = aws_lambda_function.imagen[0].function_name } : {},
  )
}

resource "aws_cloudwatch_metric_alarm" "errores" {
  for_each            = local.alarmas_de_funcion
  alarm_name          = "${local.p}-errores-${each.key}"
  alarm_description   = "La función ${each.key} falló más de 5 veces en 5 minutos"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alertas.arn]
  ok_actions          = [aws_sns_topic.alertas.arn]
  tags                = local.componente.alerta
}

resource "aws_cloudwatch_event_rule" "base_fallida" {
  name        = "${local.p}-base-fallida"
  description = "La reconstrucción del mapa base terminó con error"
  event_pattern = jsonencode({
    source        = ["aws.codebuild"]
    "detail-type" = ["CodeBuild Build State Change"]
    detail        = { "project-name" = [aws_codebuild_project.base.name], "build-status" = ["FAILED", "STOPPED", "TIMED_OUT"] }
  })
  tags = local.componente.alerta
}

resource "aws_cloudwatch_event_target" "base_fallida" {
  rule = aws_cloudwatch_event_rule.base_fallida.name
  arn  = aws_sns_topic.alertas.arn
}

data "aws_iam_policy_document" "alertas" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alertas.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "budgets.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alertas" {
  arn    = aws_sns_topic.alertas.arn
  policy = data.aws_iam_policy_document.alertas.json
}

resource "aws_budgets_budget" "consumo" {
  name         = "butake-mapas-consumo"
  budget_type  = "COST"
  limit_amount = tostring(var.presupuesto_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alertas.arn]
  }
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alertas.arn]
  }
}
