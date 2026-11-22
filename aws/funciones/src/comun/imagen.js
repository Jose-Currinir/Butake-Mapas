/**
 * Los parámetros de una imagen de mapa (para un PDF o un correo). Los validan la API, que firma, y
 * la Lambda de imagen, que dibuja: los dos leen las mismas reglas.
 *
 *   estilo   cl-light | cl-dark
 *   centro   lng,lat
 *   zoom     0 a 18 (puede tener decimales)
 *   ancho    64 a 1280 px      alto  64 a 1280 px
 *   marcas   lng,lat;lng,lat…  hasta 50 (opcional)
 *   linea    lng,lat;lng,lat…  hasta 500 puntos (opcional; un recorrido)
 */
import { leerPunto } from './geo.js'

export const ESTILOS = Object.freeze(['cl-light', 'cl-dark'])

const lista = (texto, maximo) => {
  if (texto === undefined || texto === '') return []
  const puntos = String(texto).split(';').map(leerPunto)
  if (puntos.length > maximo || puntos.some((p) => !p)) return null
  return puntos
}

const entero = (valor, min, max) => {
  const n = Number(valor)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** @returns {{ ok: true, valor: any } | { ok: false, motivo: string }} */
export function leerImagen(q = {}) {
  if (!ESTILOS.includes(q.estilo)) return { ok: false, motivo: 'estilo debe ser cl-light o cl-dark' }
  const centro = leerPunto(q.centro)
  if (!centro) return { ok: false, motivo: 'centro debe ser lng,lat' }
  const zoom = Number(q.zoom)
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 18) return { ok: false, motivo: 'zoom va de 0 a 18' }
  const ancho = entero(q.ancho, 64, 1280)
  const alto = entero(q.alto, 64, 1280)
  if (!ancho || !alto) return { ok: false, motivo: 'ancho y alto van de 64 a 1280' }
  const marcas = lista(q.marcas, 50)
  if (!marcas) return { ok: false, motivo: 'marcas: hasta 50 puntos lng,lat separados por ;' }
  const linea = lista(q.linea, 500)
  if (!linea) return { ok: false, motivo: 'linea: hasta 500 puntos lng,lat separados por ;' }
  return { ok: true, valor: { estilo: q.estilo, centro, zoom, ancho, alto, marcas, linea } }
}

/** Los parámetros de texto que viajan en la URL (lo que se firma). */
export function parametrosDeTexto(v) {
  const p = (punto) => `${punto[0]},${punto[1]}`
  return {
    estilo: v.estilo,
    centro: p(v.centro),
    zoom: String(v.zoom),
    ancho: String(v.ancho),
    alto: String(v.alto),
    ...(v.marcas.length ? { marcas: v.marcas.map(p).join(';') } : {}),
    ...(v.linea.length ? { linea: v.linea.map(p).join(';') } : {}),
  }
}
