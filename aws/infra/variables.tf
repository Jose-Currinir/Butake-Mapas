variable "cuenta_id" {
  description = "ID de la cuenta AWS butake-mapas-<entorno>."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_id))
    error_message = "cuenta_id: 12 dígitos."
  }
}

variable "perfil" {
  description = "Perfil de AWS CLI con acceso a la cuenta."
  type        = string
  default     = "butake-mapas-admin"
}

variable "entorno" {
  type    = string
  default = "prod"
  validation {
    condition     = contains(["prod", "qa"], var.entorno)
    error_message = "entorno: prod o qa."
  }
}

variable "responsable" {
  description = "Correo de quien responde (etiqueta butake:responsable y alertas)."
  type        = string
}

variable "dominio" {
  description = "Mapa base, estilos, capas e imágenes (CloudFront)."
  type        = string
  default     = "mapas.butake.cl"
}

variable "dominio_api" {
  description = "API de capas, rutas e imágenes firmadas (API Gateway)."
  type        = string
  default     = "api-mapas.butake.cl"
}

variable "origenes_subida" {
  description = "Orígenes web que pueden subir GeoJSON directo a S3 con el POST firmado."
  type        = list(string)
  default     = ["https://movil.butake.cl", "https://salud.butake.cl"]
}

variable "imagen_teselar" {
  description = "Etiqueta de butake/mapas-teselar en ECR. Vacía: la función aún no se crea (primero se sube la imagen)."
  type        = string
  default     = ""
}

variable "imagen_dibujo" {
  description = "Etiqueta de butake/mapas-imagen en ECR. Vacía: la función aún no se crea."
  type        = string
  default     = ""
}

variable "imagen_a_la_vez" {
  description = "Funciones imagen reservadas a la vez. -1: sin reserva (cuenta nueva con tope 10, AWS exige dejar 10 libres)."
  type        = number
  default     = 5
}

variable "actualizar_semanal" {
  description = "Reconstruir el mapa base cada domingo con CodeBuild (cuesta centavos por semana)."
  type        = bool
  default     = false
}

variable "presupuesto_usd" {
  description = "Alerta si el gasto del mes pasa de este monto."
  type        = number
  default     = 10
}

variable "tope_api" {
  description = "Pedidos por segundo a la API (sostenido y ráfaga)."
  type        = object({ por_segundo = number, rafaga = number })
  default     = { por_segundo = 20, rafaga = 50 }
}
