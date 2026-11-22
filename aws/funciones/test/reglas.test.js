import test from 'node:test'
import assert from 'node:assert/strict'
import { leerRuta } from '../src/comun/rutas.js'
import { firmarImagen, imagenValida, tokenDeCapas, tokenValido, venceAlFinDelDia } from '../src/comun/firma.js'
import { leerImagen, parametrosDeTexto } from '../src/comun/imagen.js'
import { enImagen } from '../src/comun/geo.js'
import { leerEntrada, resumenGeojson } from '../src/comun/entrada.js'
import { cuerpoDeRuta, resumenDeRuta, zonasAEvitar } from '../src/comun/ruta.js'
import { capasEnEstilo } from '../src/comun/estilo.js'

const SECRETO = 'x'.repeat(48)

test('rutas de mosaicos: solo las conocidas llegan a S3', () => {
  assert.deepEqual(leerRuta('/base/openmaptiles/14/4810/9854.mvt'), { tipo: 'mosaico', archivo: 'openmaptiles', clave: 'base/openmaptiles.pmtiles', z: 14, x: 4810, y: 9854, ext: 'mvt' })
  assert.equal(leerRuta('/base/terrain.json').clave, 'base/terrain.pmtiles')
  assert.equal(leerRuta('/capas/movil/abc-1/3/2/4.mvt').clave, 'capas/movil/abc-1.pmtiles')
  for (const mala of ['/base/../secreto/1/1/1.mvt', '/base/otra/1/1/1.mvt', '/base/openmaptiles/2/4/1.mvt', '/base/openmaptiles/-1/0/0.mvt',
    '/base/openmaptiles/23/0/0.mvt', '/capas/Movil/x/1/1/1.mvt', '/capas/movil/x/1/1/1.png', '/styles/cl-light.json', '/base/openmaptiles/1/1/1.exe']) {
    assert.equal(leerRuta(mala), null, mala)
  }
})

test('token de capas: de una cuenta, firmado y con vencimiento', () => {
  const ahora = Date.UTC(2026, 10, 22, 12)
  const vence = venceAlFinDelDia(ahora)
  assert.equal(vence, Date.UTC(2026, 10, 23) / 1000)
  assert.equal(venceAlFinDelDia(Date.UTC(2026, 10, 22, 23)), Date.UTC(2026, 10, 24) / 1000, 'quedan menos de 2 horas: vale hasta mañana')
  const t = tokenDeCapas(SECRETO, 'movil', vence)
  assert.ok(tokenValido(SECRETO, t, 'movil', ahora))
  assert.equal(tokenValido(SECRETO, t, 'salud', ahora), false, 'otra cuenta')
  assert.equal(tokenValido(SECRETO, t, 'movil', (vence + 1) * 1000), false, 'vencido')
  assert.equal(tokenValido('y'.repeat(48), t, 'movil', ahora), false, 'otro secreto')
  assert.equal(tokenValido(SECRETO, t.replace(/.$/, 'A'), 'movil', ahora), false, 'alterado')
  assert.equal(tokenValido(SECRETO, undefined, 'movil', ahora), false)
})

test('imagen: parámetros validados y firma que cubre todos', () => {
  const leido = leerImagen({ estilo: 'cl-light', centro: '-70.65,-33.44', zoom: '14', ancho: '800', alto: '500', marcas: '-70.65,-33.44;-70.64,-33.45' })
  assert.ok(leido.ok)
  const p = { ...parametrosDeTexto(leido.valor), vence: String(Math.floor(Date.now() / 1000) + 60) }
  p.firma = firmarImagen(SECRETO, p)
  assert.ok(imagenValida(SECRETO, p))
  assert.equal(imagenValida(SECRETO, { ...p, zoom: '15' }), false, 'cambiar un parámetro rompe la firma')
  assert.equal(imagenValida(SECRETO, { ...p, vence: '1000000000' }), false, 'vencida')
  assert.equal(leerImagen({ ...p, ancho: '5000' }).ok, false)
  assert.equal(leerImagen({ ...p, estilo: 'osm-bright' }).ok, false)
  assert.equal(leerImagen({ ...p, marcas: Array(51).fill('1,1').join(';') }).ok, false)
})

test('una marca en el centro queda en el centro de la imagen', () => {
  assert.deepEqual(enImagen([-70.65, -33.44], [-70.65, -33.44], 14, 800, 500), { x: 400, y: 250 })
  const este = enImagen([-70.64, -33.44], [-70.65, -33.44], 14, 800, 500)
  assert.ok(este.x > 400 && este.y === 250)
})

test('capa subida: clave con cuenta y uuid; GeoJSON con geometrías conocidas', () => {
  assert.deepEqual(leerEntrada('entrada/movil/0b9a6f9e-7d3c-4c2a-9a54-2d1a1f6b8c11.geojson'), { cuenta: 'movil', id: '0b9a6f9e-7d3c-4c2a-9a54-2d1a1f6b8c11' })
  assert.equal(leerEntrada('entrada/movil/../x.geojson'), null)
  assert.equal(leerEntrada('capas/movil/0b9a6f9e-7d3c-4c2a-9a54-2d1a1f6b8c11.geojson'), null)
  const punto = { type: 'Feature', geometry: { type: 'Point', coordinates: [-70, -33] }, properties: {} }
  assert.deepEqual(resumenGeojson({ type: 'FeatureCollection', features: [punto, punto] }), { ok: true, geometrias: { Point: 2 } })
  assert.equal(resumenGeojson({ type: 'Feature' }).ok, false)
  assert.equal(resumenGeojson({ type: 'FeatureCollection', features: [] }).ok, false)
  assert.equal(resumenGeojson({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'GeometryCollection' } }] }).ok, false)
})

test('ruta: zonas de GraphHopper pasan a Amazon Location y el pedido se valida', () => {
  const zonas = { areas: { centro: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-70.6, -33.4], [-70.5, -33.4], [-70.5, -33.5], [-70.6, -33.4]]] } } } }
  assert.equal(zonasAEvitar(zonas).length, 1)
  const ok = cuerpoDeRuta({ origen: [-70.65, -33.44], destino: [-70.6, -33.42] }, zonas)
  assert.ok(ok.ok)
  assert.equal(ok.valor.Traffic.Usage, 'UseTrafficData')
  assert.equal(ok.valor.DepartNow, true)
  assert.equal(ok.valor.Avoid.Areas.length, 1)
  assert.equal(cuerpoDeRuta({ origen: [-70.65, -33.44], destino: [-70.6, -33.42], evitarZonas: false }, zonas).valor.Avoid, undefined)
  assert.equal(cuerpoDeRuta({ origen: [200, 0], destino: [0, 0] }, zonas).ok, false)
  assert.equal(cuerpoDeRuta({ origen: [0, 0], destino: [1, 1], salida: 'mañana' }, zonas).ok, false)
  assert.deepEqual(resumenDeRuta({ Routes: [{ Summary: { Distance: 1200, Duration: 300 }, Legs: [{ Geometry: { LineString: [[0, 0], [1, 1]] } }] }] }),
    { encontrada: true, distanciaMetros: 1200, duracionSegundos: 300, linea: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })
})

test('estilo con capas: suma fuentes y capas sin tocar el original', () => {
  const base = { version: 8, sources: { openmaptiles: { type: 'vector' } }, layers: [{ id: 'fondo', type: 'background' }] }
  const salida = capasEnEstilo(base, [{ id: 'a1', nombre: 'Grifos', minzoom: 2, maxzoom: 12, limites: [-71, -34, -70, -33] }], { dominio: 'mapas.butake.cl', cuenta: 'movil', t: 'T' })
  assert.equal(base.layers.length, 1, 'el original queda igual')
  assert.equal(salida.layers.length, 4)
  assert.equal(salida.sources['capa-a1'].tiles[0], 'https://mapas.butake.cl/capas/movil/a1/{z}/{x}/{y}.mvt?t=T')
  assert.deepEqual(salida.sources['capa-a1'].bounds, [-71, -34, -70, -33])
})
