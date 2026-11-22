/**
 * Ruta en auto con Amazon Location (Routes v2): tráfico en vivo y las zonas a evitar de
 * `data/car_avoid.json` (las mismas que usaba GraphHopper en el perfil `car_custom`).
 */
import { leerPunto } from './geo.js'

const punto = (valor) => (Array.isArray(valor) ? leerPunto(valor.join(',')) : leerPunto(valor))

/** Los polígonos de `car_avoid.json` (formato de áreas de GraphHopper) en el formato de Amazon Location. */
export function zonasAEvitar(archivo) {
  return Object.values(archivo?.areas ?? {})
    .filter((area) => area?.geometry?.type === 'Polygon')
    .map((area) => ({ Geometry: { Polygon: area.geometry.coordinates } }))
}

/** @returns {{ ok: true, valor: any } | { ok: false, motivo: string }} */
export function cuerpoDeRuta(datos, zonas) {
  if (!datos) return { ok: false, motivo: 'El cuerpo debe ser JSON' }
  const origen = punto(datos.origen)
  const destino = punto(datos.destino)
  if (!origen || !destino) return { ok: false, motivo: 'origen y destino: [lng, lat]' }
  const paradas = Array.isArray(datos.paradas) ? datos.paradas.map(punto) : []
  if (paradas.length > 23 || paradas.some((p) => !p)) return { ok: false, motivo: 'paradas: hasta 23 puntos [lng, lat]' }
  let salida
  if (datos.salida !== undefined) {
    salida = new Date(datos.salida)
    if (Number.isNaN(salida.getTime())) return { ok: false, motivo: 'salida: fecha ISO-8601' }
  }
  const areas = datos.evitarZonas === false ? [] : zonasAEvitar(zonas)
  return {
    ok: true,
    valor: {
      Origin: origen,
      Destination: destino,
      ...(paradas.length ? { Waypoints: paradas.map((p) => ({ Position: p })) } : {}),
      TravelMode: 'Car',
      ...(salida ? { DepartureTime: salida.toISOString() } : { DepartNow: true }),
      Traffic: { Usage: 'UseTrafficData' },
      LegGeometryFormat: 'Simple',
      Languages: ['es'],
      InstructionsMeasurementSystem: 'Metric',
      ...(areas.length ? { Avoid: { Areas: areas } } : {}),
    },
  }
}

/** Lo que necesita un producto: distancia, duración y la línea para dibujarla. */
export function resumenDeRuta(respuesta) {
  const ruta = respuesta?.Routes?.[0]
  if (!ruta) return { encontrada: false }
  const linea = (ruta.Legs ?? []).flatMap((tramo) => tramo.Geometry?.LineString ?? [])
  return {
    encontrada: true,
    distanciaMetros: ruta.Summary?.Distance,
    duracionSegundos: ruta.Summary?.Duration,
    linea: { type: 'LineString', coordinates: linea },
  }
}
