locals {
  # butake-<producto>-<entorno>-<pieza> (docs/nomenclatura.md de Butake-Base).
  p = "butake-mapas-${var.entorno}"

  n = {
    bucket   = "${local.p}-datos-${var.cuenta_id}"
    cf       = "${local.p}-cf"
    tabla    = "${local.p}-catalogo"
    alertas  = "${local.p}-alertas"
    api      = "${local.p}-api"
    base     = "${local.p}-base"
    mosaicos = "${local.p}-mosaicos"
    capas    = "${local.p}-capas"
    teselar  = "${local.p}-teselar"
    imagen   = "${local.p}-imagen"
  }

  parametro_secreto = "/butake/mapas/${var.entorno}/firma/SECRETO"

  etiquetas = {
    "butake:proyecto"    = "mapas"
    "butake:entorno"     = var.entorno
    "butake:fase"        = "produccion"
    "butake:responsable" = var.responsable
  }

  componente = {
    datos  = { "butake:componente" = "datos" }
    red    = { "butake:componente" = "red" }
    api    = { "butake:componente" = "api" }
    ci     = { "butake:componente" = "ci" }
    alerta = { "butake:componente" = "alertas" }
  }

  funciones = "${path.module}/../funciones/dist"
}
