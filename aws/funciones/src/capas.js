/**
 * API de Butake-Mapas (`api-mapas.butake.cl`, API Gateway HTTP → esta Lambda).
 *
 * La llaman los servidores de cada producto (Móvil, Salud…) con su clave:
 * `Authorization: Bearer <clave>`. La clave identifica a una cuenta-cliente; cada capa es de una
 * sola cuenta. Nunca la llama el navegador directo: el producto decide quién ve qué.
 *
 *   POST   /v1/capas              crea una capa y entrega dónde subir el GeoJSON (POST firmado a S3)
 *   GET    /v1/capas              lista las capas de la cuenta (sin las archivadas)
 *   GET    /v1/capas/{id}         una capa con su estado (esperando, procesando, lista, error)
 *   DELETE /v1/capas/{id}         la archiva (deja de servirse; el archivo queda para auditoría)
 *   POST   /v1/acceso             token del día para pedir los mosaicos de las capas de la cuenta
 *   GET    /v1/estilos/{estilo}   style.json de cl-light o cl-dark con las capas pedidas (?capas=a,b)
 *   POST   /v1/imagenes           URL firmada de una imagen de mapa (para PDF), válida una hora
 *   POST   /v1/rutas              ruta en auto con tráfico (Amazon Location) y zonas a evitar
 */
import { createHash, randomUUID } from 'node:crypto'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { CalculateRoutesCommand, GeoRoutesClient } from '@aws-sdk/client-geo-routes'
import { firmarImagen, tokenDeCapas, venceAlFinDelDia } from './comun/firma.js'
import { secreto } from './comun/secreto.js'
import { ESTILOS, leerImagen, parametrosDeTexto } from './comun/imagen.js'
import { capasEnEstilo } from './comun/estilo.js'
import { cuerpoDeRuta, resumenDeRuta } from './comun/ruta.js'
import zonas from '../../../data/car_avoid.json' with { type: 'json' }

const s3 = new S3Client({})
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const rutas = new GeoRoutesClient({})

const BUCKET = process.env.BUCKET
const TABLA = process.env.TABLA
const DOMINIO = process.env.DOMINIO
const MAX_GEOJSON = Number(process.env.MAX_GEOJSON_BYTES ?? 50 * 1024 * 1024)

const json = (statusCode, cuerpo) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(cuerpo),
})
const error = (statusCode, codigo, mensaje) => json(statusCode, { error: { codigo, mensaje } })

const hash = (texto) => createHash('sha256').update(texto).digest('hex')

/** La cuenta de la clave, o `null`. Las claves se guardan solo como hash (`scripts/aws/clave.mjs`). */
async function cuentaDe(evento) {
  const cabecera = evento.headers?.authorization ?? ''
  const clave = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : ''
  if (clave.length < 32) return null
  const { Item } = await db.send(new GetCommand({ TableName: TABLA, Key: { pk: `CLAVE#${hash(clave)}`, sk: 'CLAVE' } }))
  return Item?.activa ? { cuenta: Item.cuenta, nombre: Item.nombre } : null
}

const cuerpo = (evento) => {
  if (!evento.body) return {}
  try {
    return JSON.parse(evento.isBase64Encoded ? Buffer.from(evento.body, 'base64').toString('utf8') : evento.body)
  } catch {
    return null
  }
}

const NOMBRE = /^[\p{L}\p{N} .,_()-]{1,80}$/u
const vista = (item) => ({
  id: item.sk.slice('CAPA#'.length),
  nombre: item.nombre,
  estado: item.estado,
  motivo: item.motivo,
  limites: item.limites,
  minzoom: item.minzoom,
  maxzoom: item.maxzoom,
  geometrias: item.geometrias,
  creadaAtUtc: item.creadaAtUtc,
  creadaPor: item.creadaPor,
  listaAtUtc: item.listaAtUtc,
})

async function capasDe(cuenta) {
  const salida = []
  let desde
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :capa)',
      ExpressionAttributeValues: { ':pk': `CUENTA#${cuenta}`, ':capa': 'CAPA#' },
      ExclusiveStartKey: desde,
    }))
    salida.push(...(r.Items ?? []).filter((item) => item.estado !== 'archivada'))
    desde = r.LastEvaluatedKey
  } while (desde)
  return salida
}

const capa = async (cuenta, id) => {
  if (!/^[a-z0-9-]{36}$/.test(id ?? '')) return null
  const { Item } = await db.send(new GetCommand({ TableName: TABLA, Key: { pk: `CUENTA#${cuenta}`, sk: `CAPA#${id}` } }))
  return Item && Item.estado !== 'archivada' ? Item : null
}

const operaciones = {
  async 'POST /v1/capas'(evento, quien) {
    const datos = cuerpo(evento)
    if (!datos || !NOMBRE.test(String(datos.nombre ?? '').trim())) return error(400, 'NOMBRE_INVALIDO', 'nombre: 1 a 80 letras, números o . , _ ( ) -')
    const id = randomUUID()
    const ahora = new Date().toISOString()
    await db.send(new PutCommand({
      TableName: TABLA,
      Item: { pk: `CUENTA#${quien.cuenta}`, sk: `CAPA#${id}`, nombre: String(datos.nombre).trim(), estado: 'esperando', creadaAtUtc: ahora, creadaPor: quien.nombre },
      ConditionExpression: 'attribute_not_exists(pk)',
    }))
    const subida = await createPresignedPost(s3, {
      Bucket: BUCKET,
      Key: `entrada/${quien.cuenta}/${id}.geojson`,
      Conditions: [['content-length-range', 1, MAX_GEOJSON], ['eq', '$Content-Type', 'application/geo+json']],
      Fields: { 'Content-Type': 'application/geo+json' },
      Expires: 900,
    })
    return json(201, { id, estado: 'esperando', subida: { url: subida.url, campos: subida.fields, venceEnSegundos: 900, maxBytes: MAX_GEOJSON } })
  },

  async 'GET /v1/capas'(_evento, quien) {
    return json(200, { capas: (await capasDe(quien.cuenta)).map(vista) })
  },

  async 'GET /v1/capas/{id}'(evento, quien) {
    const item = await capa(quien.cuenta, evento.pathParameters?.id)
    return item ? json(200, vista(item)) : error(404, 'NO_EXISTE', 'La capa no existe')
  },

  async 'DELETE /v1/capas/{id}'(evento, quien) {
    const item = await capa(quien.cuenta, evento.pathParameters?.id)
    if (!item) return error(404, 'NO_EXISTE', 'La capa no existe')
    await db.send(new UpdateCommand({
      TableName: TABLA,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: 'SET estado = :a, archivadaAtUtc = :t, archivadaPor = :p',
      ExpressionAttributeValues: { ':a': 'archivada', ':t': new Date().toISOString(), ':p': quien.nombre },
    }))
    return json(200, { id: evento.pathParameters.id, estado: 'archivada' })
  },

  async 'POST /v1/acceso'(_evento, quien) {
    const vence = venceAlFinDelDia()
    const t = tokenDeCapas(await secreto(), quien.cuenta, vence)
    return json(200, { t, venceAtUtc: new Date(vence * 1000).toISOString(), plantilla: `https://${DOMINIO}/capas/${quien.cuenta}/{capa}/{z}/{x}/{y}.mvt?t=${t}` })
  },

  async 'GET /v1/estilos/{estilo}'(evento, quien) {
    const estilo = evento.pathParameters?.estilo
    if (!ESTILOS.includes(estilo)) return error(404, 'NO_EXISTE', 'Estilos: cl-light o cl-dark')
    const pedidas = String(evento.queryStringParameters?.capas ?? '').split(',').filter(Boolean)
    if (pedidas.length > 20) return error(400, 'DEMASIADAS_CAPAS', 'Hasta 20 capas por estilo')
    const listas = (await Promise.all(pedidas.map((id) => capa(quien.cuenta, id)))).filter((item) => item?.estado === 'lista')
    const base = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `styles/${estilo}.json` }))
    const documento = JSON.parse(await base.Body.transformToString())
    const vence = venceAlFinDelDia()
    const t = tokenDeCapas(await secreto(), quien.cuenta, vence)
    return json(200, capasEnEstilo(documento, listas.map(vista), { dominio: DOMINIO, cuenta: quien.cuenta, t }))
  },

  async 'POST /v1/imagenes'(evento) {
    const datos = cuerpo(evento)
    if (!datos) return error(400, 'JSON_INVALIDO', 'El cuerpo debe ser JSON')
    const leido = leerImagen(datos)
    if (!leido.ok) return error(400, 'IMAGEN_INVALIDA', leido.motivo)
    const parametros = { ...parametrosDeTexto(leido.valor), vence: String(Math.floor(Date.now() / 1000) + 3600) }
    parametros.firma = firmarImagen(await secreto(), parametros)
    const q = new URLSearchParams(parametros).toString()
    return json(200, { url: `https://${DOMINIO}/imagen?${q}`, venceAtUtc: new Date(Number(parametros.vence) * 1000).toISOString() })
  },

  async 'POST /v1/rutas'(evento) {
    const pedido = cuerpoDeRuta(cuerpo(evento), zonas)
    if (!pedido.ok) return error(400, 'RUTA_INVALIDA', pedido.motivo)
    const respuesta = await rutas.send(new CalculateRoutesCommand(pedido.valor))
    return json(200, resumenDeRuta(respuesta))
  },
}

export async function handler(evento) {
  const operacion = operaciones[evento?.routeKey]
  if (!operacion) return error(404, 'NO_EXISTE', 'Ruta desconocida')
  try {
    const quien = await cuentaDe(evento)
    if (!quien) return error(401, 'SIN_CLAVE', 'Falta una clave válida en Authorization: Bearer')
    return await operacion(evento, quien)
  } catch (falla) {
    console.error(JSON.stringify({ nivel: 'error', ruta: evento.routeKey, error: falla?.message, nombre: falla?.name }))
    if (falla?.name === 'ValidationException') return error(400, 'RUTA_INVALIDA', 'Amazon Location rechazó la ruta')
    return error(500, 'ERROR_INTERNO', 'No se pudo completar la operación')
  }
}
