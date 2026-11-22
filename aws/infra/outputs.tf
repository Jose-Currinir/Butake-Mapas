output "dns" {
  description = "Registros para Cloudflare (nube gris: solo DNS)."
  value = {
    validacion = [for o in aws_acm_certificate.mapas.domain_validation_options : {
      nombre = o.resource_record_name, tipo = o.resource_record_type, valor = o.resource_record_value
    }]
    cname = {
      (var.dominio)     = aws_cloudfront_distribution.mapas.domain_name
      (var.dominio_api) = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
    }
  }
}

output "mapas" {
  value = {
    bucket       = aws_s3_bucket.datos.id
    distribucion = aws_cloudfront_distribution.mapas.id
    tabla        = aws_dynamodb_table.catalogo.name
    base         = aws_codebuild_project.base.name
    alertas      = aws_sns_topic.alertas.arn
    ecr          = { for k, r in aws_ecr_repository.funcion : k => r.repository_url }
    estilo       = "https://${var.dominio}/styles/cl-light/style.json"
    api          = "https://${var.dominio_api}/v1"
  }
}
