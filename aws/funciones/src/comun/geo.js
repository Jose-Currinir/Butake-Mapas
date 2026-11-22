/** Web Mercator con mosaicos de 512 px, como dibuja MapLibre. */
const TAM = 512

export function aPixel(lng, lat, zoom) {
  const escala = TAM * 2 ** zoom
  const seno = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180)
  return {
    x: ((lng + 180) / 360) * escala,
    y: (0.5 - Math.log((1 + seno) / (1 - seno)) / (4 * Math.PI)) * escala,
  }
}

/** Posición de un punto dentro de una imagen de `ancho`×`alto` centrada en `centro`. */
export function enImagen(punto, centro, zoom, ancho, alto) {
  const p = aPixel(punto[0], punto[1], zoom)
  const c = aPixel(centro[0], centro[1], zoom)
  return { x: Math.round(p.x - c.x + ancho / 2), y: Math.round(p.y - c.y + alto / 2) }
}

/** `"lng,lat"` → `[lng, lat]` válido, o `null`. */
export function leerPunto(texto) {
  const partes = String(texto ?? '').split(',').map(Number)
  if (partes.length !== 2 || !partes.every(Number.isFinite)) return null
  const [lng, lat] = partes
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return [lng, lat]
}
