/**
 * Lambda de mosaicos: convierte `/{z}/{x}/{y}` en lecturas por rango de un archivo PMTiles en S3.
 *
 * La llama solo CloudFront (URL de función con OAC). Rutas:
 *   GET /base/<archivo>.json                 TileJSON del mapa base (openmaptiles, natural_earth, terrain)
 *   GET /base/<archivo>/{z}/{x}/{y}.<ext>    un mosaico del mapa base (público)
 *   GET /capas/<cuenta>/<capa>/{z}/{x}/{y}.mvt?t=<token>   un mosaico de una capa privada
 *
 * El encabezado y los directorios de cada archivo quedan en memoria entre invocaciones: un
 * mosaico cuesta, en caliente, una sola lectura por rango a S3. CloudFront guarda el resultado.
 */
import { gzipSync } from 'node:zlib'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { EtagMismatch, PMTiles } from 'pmtiles'
import { extDe, leerRuta, mimeDe } from './comun/rutas.js'
import { tokenValido } from './comun/firma.js'
import { secreto } from './comun/secreto.js'

const s3 = new S3Client({})
const BUCKET = process.env.BUCKET
const DOMINIO = process.env.DOMINIO

/** Lee un rango de un objeto de S3; respeta el ETag para no mezclar dos versiones del archivo. */
export class FuenteS3 {
  constructor(clave, cliente = s3, bucket = BUCKET) {
    this.clave = clave
    this.cliente = cliente
    this.bucket = bucket
  }

  getKey() {
    return this.clave
  }

  async getBytes(offset, length, _signal, etag) {
    try {
      const respuesta = await this.cliente.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.clave,
        Range: `bytes=${offset}-${offset + length - 1}`,
        IfMatch: etag,
      }))
      const datos = await respuesta.Body.transformToByteArray()
      return { data: datos.buffer.slice(datos.byteOffset, datos.byteOffset + datos.byteLength), etag: respuesta.ETag }
    } catch (error) {
      if (error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412) throw new EtagMismatch(error.message)
      throw error
    }
  }
}

const archivos = new Map()
const archivo = (clave) => {
  if (!archivos.has(clave)) archivos.set(clave, new PMTiles(new FuenteS3(clave)))
  return archivos.get(clave)
}

const CACHE_BASE = 'public, max-age=86400, s-maxage=604800'
const CACHE_CAPA = 'private, max-age=3600'

const responder = (statusCode, cuerpo, cabeceras = {}) => ({
  statusCode,
  headers: { 'cache-control': 'no-store', ...cabeceras },
  body: cuerpo ?? '',
})

const noEncontrado = (error) => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404

/** @param {{ rawPath: string, queryStringParameters?: Record<string, string>, requestContext?: any }} evento */
export async function handler(evento) {
  if (evento?.requestContext?.http?.method && evento.requestContext.http.method !== 'GET') return responder(405, 'Método no permitido')
  const ruta = leerRuta(evento?.rawPath)
  if (!ruta) return responder(404, 'No existe')

  if (ruta.tipo === 'capa') {
    const token = evento.queryStringParameters?.t
    if (!tokenValido(await secreto(), token, ruta.cuenta)) return responder(403, 'Acceso vencido o inválido')
  }

  try {
    const pm = archivo(ruta.clave)
    const encabezado = await pm.getHeader()

    if (ruta.tipo === 'tilejson') {
      const tilejson = await pm.getTileJson(`https://${DOMINIO}/base/${ruta.archivo}`)
      return responder(200, JSON.stringify(tilejson), { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600, s-maxage=86400' })
    }

    if (ruta.ext !== extDe(encabezado.tileType) && !(ruta.ext === 'pbf' && encabezado.tileType === 1)) return responder(404, 'Formato distinto al del archivo')
    const mosaico = await pm.getZxy(ruta.z, ruta.x, ruta.y)
    const cache = ruta.tipo === 'capa' ? CACHE_CAPA : CACHE_BASE
    // Sin dato en ese punto: 204, y la caché lo recuerda (no se vuelve a preguntar a S3).
    if (!mosaico?.data?.byteLength) return { statusCode: 204, headers: { 'cache-control': cache }, body: '' }

    const vectorial = encabezado.tileType === 1
    const bytes = vectorial ? gzipSync(Buffer.from(mosaico.data)) : Buffer.from(mosaico.data)
    return {
      statusCode: 200,
      headers: {
        'content-type': mimeDe(encabezado.tileType),
        'cache-control': cache,
        ...(vectorial ? { 'content-encoding': 'gzip' } : {}),
      },
      body: bytes.toString('base64'),
      isBase64Encoded: true,
    }
  } catch (error) {
    if (noEncontrado(error)) return responder(404, 'No existe')
    console.error(JSON.stringify({ nivel: 'error', clave: ruta.clave, error: error?.message }))
    return responder(502, 'No se pudo leer el mapa')
  }
}
