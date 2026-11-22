/**
 * Lambda que convierte una capa subida (GeoJSON) en PMTiles con tippecanoe.
 *
 * La dispara S3 al llegar `entrada/<cuenta>/<capa>.geojson`. Deja `capas/<cuenta>/<capa>.pmtiles`
 * y marca la capa como `lista` (o `error` con el motivo) en DynamoDB. Corre en una imagen de
 * contenedor con tippecanoe (`teselar.Dockerfile`).
 */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { PMTiles } from 'pmtiles'
import { leerEntrada, resumenGeojson } from './comun/entrada.js'

const s3 = new S3Client({})
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const TABLA = process.env.TABLA

const marcar = (cuenta, id, cambios) => {
  const claves = Object.keys(cambios)
  return db.send(new UpdateCommand({
    TableName: TABLA,
    Key: { pk: `CUENTA#${cuenta}`, sk: `CAPA#${id}` },
    // Una capa archivada mientras se procesaba no vuelve a aparecer.
    ConditionExpression: 'attribute_exists(pk) AND estado <> :archivada',
    UpdateExpression: `SET ${claves.map((c) => `#${c} = :${c}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(claves.map((c) => [`#${c}`, c])),
    ExpressionAttributeValues: { ':archivada': 'archivada', ...Object.fromEntries(claves.map((c) => [`:${c}`, cambios[c]])) },
  }))
}

const correr = (comando, argumentos) => new Promise((resolver, rechazar) => {
  const proceso = spawn(comando, argumentos, { stdio: ['ignore', 'ignore', 'pipe'] })
  let errores = ''
  proceso.stderr.on('data', (trozo) => { errores = (errores + trozo).slice(-4000) })
  proceso.on('error', rechazar)
  proceso.on('close', (codigo) => (codigo === 0 ? resolver() : rechazar(new Error(`tippecanoe salió con ${codigo}: ${errores.trim().split('\n').pop()}`))))
})

/** Una lectura local de PMTiles para guardar límites y zooms en el catálogo. */
class FuenteLocal {
  constructor(bytes) { this.bytes = bytes }
  getKey() { return 'local' }
  async getBytes(offset, length) {
    const trozo = this.bytes.subarray(offset, offset + length)
    return { data: trozo.buffer.slice(trozo.byteOffset, trozo.byteOffset + trozo.byteLength) }
  }
}

async function procesar(bucket, clave) {
  const entrada = leerEntrada(clave)
  if (!entrada) {
    console.warn(JSON.stringify({ nivel: 'aviso', mensaje: 'clave fuera de formato', clave }))
    return
  }
  const { cuenta, id } = entrada
  const geojson = `/tmp/${id}.geojson`
  const salida = `/tmp/${id}.pmtiles`
  try {
    await marcar(cuenta, id, { estado: 'procesando' })
    const objeto = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: clave }))
    await pipeline(objeto.Body, createWriteStream(geojson))

    const resumen = resumenGeojson(JSON.parse(await readFile(geojson, 'utf8')))
    if (!resumen.ok) throw new Error(resumen.motivo)

    await correr('tippecanoe', ['-o', salida, '-l', 'capa', '-zg', '--drop-densest-as-needed', '--extend-zooms-if-still-dropping', '--force', '--quiet', geojson])

    const { size } = await stat(salida)
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `capas/${cuenta}/${id}.pmtiles`,
      Body: createReadStream(salida),
      ContentLength: size,
      ContentType: 'application/vnd.pmtiles',
    }))
    const encabezado = await new PMTiles(new FuenteLocal(await readFile(salida))).getHeader()
    await marcar(cuenta, id, {
      estado: 'lista',
      listaAtUtc: new Date().toISOString(),
      minzoom: encabezado.minZoom,
      maxzoom: encabezado.maxZoom,
      limites: [encabezado.minLon, encabezado.minLat, encabezado.maxLon, encabezado.maxLat],
      geometrias: resumen.geometrias,
      bytes: size,
    })
  } catch (falla) {
    console.error(JSON.stringify({ nivel: 'error', cuenta, id, error: falla?.message }))
    if (falla?.name !== 'ConditionalCheckFailedException') {
      await marcar(cuenta, id, { estado: 'error', motivo: String(falla?.message ?? 'Error desconocido').slice(0, 300) }).catch(() => {})
    }
  } finally {
    await rm(geojson, { force: true })
    await rm(salida, { force: true })
  }
}

export async function handler(evento) {
  for (const registro of evento?.Records ?? []) {
    const bucket = registro.s3?.bucket?.name
    const clave = decodeURIComponent(String(registro.s3?.object?.key ?? '').replace(/\+/g, ' '))
    if (bucket && clave) await procesar(bucket, clave)
  }
}
