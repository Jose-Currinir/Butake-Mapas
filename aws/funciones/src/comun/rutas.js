/**
 * Las direcciones que atiende la Lambda de mosaicos. Todo lo que no calce se rechaza antes de
 * tocar S3: un nombre libre en la clave de S3 dejaría leer cualquier objeto del bucket.
 */

/** Archivos del mapa base publicados (`base/<nombre>.pmtiles`). */
export const ARCHIVOS_BASE = Object.freeze(['openmaptiles', 'natural_earth', 'terrain'])

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const EXT = { mvt: 1, pbf: 1, png: 2, jpg: 3, webp: 4 }

const coordenada = (z, x, y) => {
  const [zz, xx, yy] = [z, x, y].map(Number)
  if (![zz, xx, yy].every(Number.isInteger) || zz < 0 || zz > 22) return null
  const lado = 2 ** zz
  if (xx < 0 || yy < 0 || xx >= lado || yy >= lado) return null
  return { z: zz, x: xx, y: yy }
}

/**
 * @param {string} ruta `event.rawPath`
 * @returns {null
 *   | { tipo: 'tilejson', archivo: string, clave: string }
 *   | { tipo: 'mosaico', archivo: string, clave: string, z: number, x: number, y: number, ext: string }
 *   | { tipo: 'capa', cuenta: string, capa: string, clave: string, z: number, x: number, y: number, ext: string }}
 */
export function leerRuta(ruta) {
  const partes = String(ruta ?? '').split('/').filter(Boolean)

  if (partes[0] === 'base' && partes.length === 2) {
    const archivo = partes[1].replace(/\.json$/, '')
    if (!partes[1].endsWith('.json') || !ARCHIVOS_BASE.includes(archivo)) return null
    return { tipo: 'tilejson', archivo, clave: `base/${archivo}.pmtiles` }
  }

  if (partes[0] === 'base' && partes.length === 5) {
    const [, archivo, z, x, archivoY] = partes
    const [y, ext] = archivoY.split('.')
    const punto = coordenada(z, x, y)
    if (!ARCHIVOS_BASE.includes(archivo) || !punto || !(ext in EXT)) return null
    return { tipo: 'mosaico', archivo, clave: `base/${archivo}.pmtiles`, ...punto, ext }
  }

  if (partes[0] === 'capas' && partes.length === 6) {
    const [, cuenta, capa, z, x, archivoY] = partes
    const [y, ext] = archivoY.split('.')
    const punto = coordenada(z, x, y)
    if (!ID.test(cuenta) || !ID.test(capa) || !punto || ext !== 'mvt') return null
    return { tipo: 'capa', cuenta, capa, clave: `capas/${cuenta}/${capa}.pmtiles`, ...punto, ext }
  }

  return null
}

/** Tipo MIME según el tipo de mosaico del encabezado PMTiles (1 mvt, 2 png, 3 jpg, 4 webp). */
export const mimeDe = (tipo) => ({ 1: 'application/vnd.mapbox-vector-tile', 2: 'image/png', 3: 'image/jpeg', 4: 'image/webp' })[tipo] ?? 'application/octet-stream'
export const extDe = (tipo) => ({ 1: 'mvt', 2: 'png', 3: 'jpg', 4: 'webp' })[tipo] ?? 'bin'
