/**
 * Firmas HMAC-SHA256 de Butake-Mapas.
 *
 * - Acceso a capas privadas: `t=<cuenta>.<vence>.<mac>` en la URL de cada mosaico. Vence al final
 *   del día UTC, así todos los mosaicos de una cuenta comparten la caché de CloudFront ese día.
 * - Imagen para PDF: `vence` y `firma` sobre los parámetros ordenados, para que nadie pida
 *   imágenes a nuestra cuenta sin pasar por la API.
 *
 * El secreto vive en SSM (`/butake/mapas/<entorno>/firma/SECRETO`); nunca en el código ni en
 * variables de entorno de la Lambda.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const mac = (secreto, texto) => createHmac('sha256', secreto).update(texto).digest('base64url')

const iguales = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Fin del día UTC (segundos) de `ahora`, o del día siguiente si quedan menos de 2 horas. */
export function venceAlFinDelDia(ahora = Date.now()) {
  const fin = new Date(ahora)
  fin.setUTCHours(24, 0, 0, 0)
  if (fin.getTime() - ahora < 2 * 3600 * 1000) fin.setUTCDate(fin.getUTCDate() + 1)
  return Math.floor(fin.getTime() / 1000)
}

export function tokenDeCapas(secreto, cuenta, vence) {
  return `${cuenta}.${vence}.${mac(secreto, `capas:${cuenta}:${vence}`)}`
}

/** `true` si el token es de esa cuenta, está bien firmado y no venció. */
export function tokenValido(secreto, token, cuenta, ahora = Date.now()) {
  const partes = String(token ?? '').split('.')
  if (partes.length !== 3) return false
  const [deCuenta, vence, firma] = partes
  if (deCuenta !== cuenta || !/^\d{9,11}$/.test(vence)) return false
  if (Number(vence) * 1000 < ahora) return false
  return iguales(firma, mac(secreto, `capas:${deCuenta}:${vence}`))
}

/** Texto canónico de los parámetros de una imagen: ordenados, sin `firma`. */
const canonico = (parametros) => Object.keys(parametros)
  .filter((clave) => clave !== 'firma')
  .sort()
  .map((clave) => `${clave}=${parametros[clave]}`)
  .join('&')

export function firmarImagen(secreto, parametros) {
  return mac(secreto, `imagen:${canonico(parametros)}`)
}

export function imagenValida(secreto, parametros, ahora = Date.now()) {
  if (!/^\d{9,11}$/.test(String(parametros.vence ?? ''))) return false
  if (Number(parametros.vence) * 1000 < ahora) return false
  return iguales(parametros.firma ?? '', firmarImagen(secreto, parametros))
}
