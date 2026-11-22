# mapas.butake.cl (CloudFront) y api-mapas.butake.cl (API Gateway), con un certificado para los
# dos. Los registros DNS (validación y CNAME) viven en Cloudflare y se cargan a mano: ver outputs.
#
# Sin certificado exportable ni servidor de origen: CloudFront habla con S3 y con las URLs de
# función firmando cada pedido (OAC).

resource "aws_acm_certificate" "mapas" {
  domain_name               = var.dominio
  subject_alternative_names = [var.dominio_api]
  validation_method         = "DNS"
  tags                      = local.componente.red
  lifecycle { create_before_destroy = true }
}

resource "aws_acm_certificate_validation" "mapas" {
  certificate_arn = aws_acm_certificate.mapas.arn
  timeouts { create = "2h" }
}

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${local.p}-oac-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${local.p}-oac-lambda"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Mosaicos: un día en el navegador, una semana en CloudFront (el mapa se rehace cada semana y la
# publicación vacía /base/*). La clave de caché solo lleva `t` (el token del día de las capas).
resource "aws_cloudfront_cache_policy" "mosaicos" {
  name        = "${local.p}-cache-mosaicos"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 604800
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "whitelist"
      query_strings { items = ["t"] }
    }
  }
}

# Imágenes: cada combinación de parámetros (y su firma) es otra imagen.
resource "aws_cloudfront_cache_policy" "imagen" {
  name        = "${local.p}-cache-imagen"
  min_ttl     = 0
  default_ttl = 3600
  max_ttl     = 3600
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "all" }
  }
}

locals {
  # Políticas administradas de AWS.
  cache_optimizada     = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  cors_simple          = "60669652-455b-4ae9-85a4-c4c02393f86c" # SimpleCORS
  todo_menos_host      = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
  dominio_url_mosaicos = trimsuffix(trimprefix(aws_lambda_function_url.mosaicos.function_url, "https://"), "/")
  dominio_url_imagen   = length(aws_lambda_function_url.imagen) > 0 ? trimsuffix(trimprefix(aws_lambda_function_url.imagen[0].function_url, "https://"), "/") : null
}

resource "aws_cloudfront_distribution" "mapas" {
  comment         = local.n.cf
  enabled         = true
  aliases         = [var.dominio]
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.datos.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id                = "mosaicos"
    domain_name              = local.dominio_url_mosaicos
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  dynamic "origin" {
    for_each = local.dominio_url_imagen == null ? [] : [local.dominio_url_imagen]
    content {
      origin_id                = "imagen"
      domain_name              = origin.value
      origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # Estilos, fuentes y sprite: archivos fijos en S3.
  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_optimizada
    response_headers_policy_id = local.cors_simple
  }

  ordered_cache_behavior {
    path_pattern               = "/base/*"
    target_origin_id           = "mosaicos"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false # la Lambda ya entrega gzip
    cache_policy_id            = aws_cloudfront_cache_policy.mosaicos.id
    origin_request_policy_id   = local.todo_menos_host
    response_headers_policy_id = local.cors_simple
  }

  ordered_cache_behavior {
    path_pattern               = "/capas/*"
    target_origin_id           = "mosaicos"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = aws_cloudfront_cache_policy.mosaicos.id
    origin_request_policy_id   = local.todo_menos_host
    response_headers_policy_id = local.cors_simple
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.dominio_url_imagen == null ? [] : ["/imagen"]
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "imagen"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = false
      cache_policy_id            = aws_cloudfront_cache_policy.imagen.id
      origin_request_policy_id   = local.todo_menos_host
      response_headers_policy_id = local.cors_simple
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.mapas.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.componente.red
}

# --- API ---------------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "api" {
  name          = local.n.api
  protocol_type = "HTTP"
  # La llaman los servidores de los productos, no el navegador: sin CORS.
  disable_execute_api_endpoint = true
  tags                         = local.componente.api
}

resource "aws_apigatewayv2_integration" "capas" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.capas.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

locals {
  rutas_api = [
    "POST /v1/capas", "GET /v1/capas", "GET /v1/capas/{id}", "DELETE /v1/capas/{id}",
    "POST /v1/acceso", "GET /v1/estilos/{estilo}", "POST /v1/imagenes", "POST /v1/rutas",
  ]
}

resource "aws_apigatewayv2_route" "api" {
  for_each  = toset(local.rutas_api)
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.capas.id}"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/butake/mapas/${var.entorno}/api-acceso"
  retention_in_days = 30
  tags              = local.componente.api
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_rate_limit  = var.tope_api.por_segundo
    throttling_burst_limit = var.tope_api.rafaga
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      id     = "$context.requestId", ip = "$context.identity.sourceIp", ruta = "$context.routeKey",
      estado = "$context.status", ms = "$context.responseLatency", error = "$context.integrationErrorMessage"
    })
  }
  tags = local.componente.api
}

resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.dominio_api
  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.mapas.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
  tags = local.componente.red
}

resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = aws_apigatewayv2_stage.api.id
}

resource "aws_lambda_permission" "api" {
  statement_id  = "ApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.capas.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
