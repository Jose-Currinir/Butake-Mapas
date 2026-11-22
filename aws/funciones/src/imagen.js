/**
 * Lambda de imagen: dibuja un mapa como PNG (para un PDF o un correo) con MapLibre Native.
 *
 * Solo atiende URLs firmadas por la API (`POST /v1/imagenes`): sin eso cualquiera podría gastar
 * cómputo de la cuenta. CloudFront guarda cada imagen por su URL completa. Corre en una imagen de
 * contenedor (`imagen.Dockerfile`) con un servidor X virtual, porque MapLibre Native necesita OpenGL.
 *
 *   GET /imagen?estilo=cl-light&centro=-70.65,-33.44&zoom=14&ancho=800&alto=500
 *              &marcas=-70.65,-33.44&linea=…&vence=…&firma=…
 */
import { spawn } from 'node:child_process'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { imagenValida } from './comun/firma.js'
import { secreto } from './comun/secreto.js'
import { leerImagen } from './comun/imagen.js'
import { enImagen } from './comun/geo.js'

const s3 = new S3Client({})
const BUCKET = process.env.BUCKET
const DOMINIO = process.env.DOMINIO
const ESCALA = 2 // nítido en papel

let x
const iniciarPantalla = () => {
  if (x || process.env.DISPLAY_LISTO) return
  x = spawn('Xvfb', [':99', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true })
  x.unref()
  process.env.DISPLAY = ':99'
}

let mbgl
let sharp
async function cargar() {
  iniciarPantalla()
  mbgl ??= (await import('@maplibre/maplibre-gl-native')).default
  sharp ??= (await import('sharp')).default
}

const estilos = new Map()
async function estilo(nombre) {
  if (!estilos.has(nombre)) {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `styles/${nombre}.json` }))
    estilos.set(nombre, await r.Body.transformToString())
  }
  return estilos.get(nombre)
}

/** MapLibre Native pide mosaicos, fuentes y sprites: solo los de nuestro propio dominio. */
const pedir = (req, listo) => {
  const url = new URL(req.url)
  if (url.hostname !== DOMINIO) {
    listo(new Error(`Origen no permitido: ${url.hostname}`))
    return
  }
  fetch(url)
    .then(async (r) => {
      if (r.status === 204 || r.status === 404) return listo()
      if (!r.ok) return listo(new Error(`${r.status} en ${url.pathname}`))
      return listo(null, { data: Buffer.from(await r.arrayBuffer()) })
    })
    .catch((falla) => listo(falla))
}

const dibujar = (styleJson, v) => new Promise((resolver, rechazar) => {
  const mapa = new mbgl.Map({ request: pedir, ratio: ESCALA, mode: 'static' })
  mapa.load(styleJson)
  mapa.render({ zoom: v.zoom, center: v.centro, width: v.ancho, height: v.alto }, (falla, pixeles) => {
    mapa.release()
    if (falla) rechazar(falla)
    else resolver(pixeles)
  })
})

/** Marcas y recorrido encima del mapa, en SVG. */
function superposicion(v) {
  const w = v.ancho * ESCALA
  const h = v.alto * ESCALA
  const p = (punto) => {
    const { x: px, y: py } = enImagen(punto, v.centro, v.zoom, v.ancho, v.alto)
    return [px * ESCALA, py * ESCALA]
  }
  const linea = v.linea.length > 1
    ? `<polyline points="${v.linea.map((q) => p(q).join(',')).join(' ')}" fill="none" stroke="#1f7a4d" stroke-width="${3 * ESCALA}" stroke-linejoin="round" stroke-linecap="round"/>`
    : ''
  const marcas = v.marcas.map((q) => {
    const [cx, cy] = p(q)
    return `<circle cx="${cx}" cy="${cy}" r="${7 * ESCALA}" fill="#c2410c" stroke="#ffffff" stroke-width="${2 * ESCALA}"/>`
  }).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${linea}${marcas}</svg>`)
}

const respuesta = (statusCode, texto) => ({ statusCode, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: texto })

export async function handler(evento) {
  const q = evento?.queryStringParameters ?? {}
  if (!imagenValida(await secreto(), q)) return respuesta(403, 'Firma vencida o inválida')
  const leido = leerImagen(q)
  if (!leido.ok) return respuesta(400, leido.motivo)
  const v = leido.valor
  try {
    await cargar()
    const pixeles = await dibujar(await estilo(v.estilo), v)
    let png = sharp(pixeles, { raw: { width: v.ancho * ESCALA, height: v.alto * ESCALA, channels: 4, premultiplied: true } })
    if (v.marcas.length || v.linea.length) png = png.composite([{ input: superposicion(v) }])
    const bytes = await png.png({ compressionLevel: 9 }).toBuffer()
    return {
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600, s-maxage=3600' },
      body: bytes.toString('base64'),
      isBase64Encoded: true,
    }
  } catch (falla) {
    console.error(JSON.stringify({ nivel: 'error', error: falla?.message }))
    return respuesta(502, 'No se pudo dibujar el mapa')
  }
}
