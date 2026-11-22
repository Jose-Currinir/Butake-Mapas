/** Reglas de una capa subida: dónde llega y qué GeoJSON se acepta. */

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `entrada/<cuenta>/<uuid>.geojson` → `{ cuenta, id }`, o `null`. */
export function leerEntrada(clave) {
  const m = /^entrada\/([^/]+)\/([^/]+)\.geojson$/.exec(String(clave ?? ''))
  if (!m || !ID.test(m[1]) || !UUID.test(m[2])) return null
  return { cuenta: m[1], id: m[2] }
}

const TIPOS = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])
export const MAX_ELEMENTOS = 200_000

/** Revisa que sea un FeatureCollection con geometrías conocidas; cuenta cada tipo. */
export function resumenGeojson(geojson) {
  if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) return { ok: false, motivo: 'Se espera un GeoJSON FeatureCollection' }
  if (geojson.features.length === 0) return { ok: false, motivo: 'La capa no tiene elementos' }
  if (geojson.features.length > MAX_ELEMENTOS) return { ok: false, motivo: `Hasta ${MAX_ELEMENTOS} elementos por capa` }
  const geometrias = {}
  for (const elemento of geojson.features) {
    const tipo = elemento?.geometry?.type
    if (elemento?.type !== 'Feature' || !TIPOS.has(tipo)) return { ok: false, motivo: `Geometría no admitida: ${tipo ?? 'vacía'}` }
    geometrias[tipo] = (geometrias[tipo] ?? 0) + 1
  }
  return { ok: true, geometrias }
}
