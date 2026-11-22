#!/usr/bin/env node
/**
 * Crea o desactiva la clave con que un producto llama a la API de Butake-Mapas.
 *
 * La clave se muestra una sola vez; en DynamoDB queda solo su hash SHA-256. El producto la guarda
 * en su SSM (p. ej. /butake/movil/prod/api/MAPAS_CLAVE), nunca en el repo.
 *
 *   node aws/funciones/herramientas/clave.mjs crear  --tabla butake-mapas-prod-capas --cuenta movil --nombre "Butake Móvil prod"
 *   node aws/funciones/herramientas/clave.mjs quitar --tabla butake-mapas-prod-capas --hash <sha256>
 *
 * Usa el perfil de AWS del entorno (AWS_PROFILE=butake-mapas-admin).
 */
import { createHash, randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tabla: { type: 'string' }, cuenta: { type: 'string' }, nombre: { type: 'string' }, hash: { type: 'string' } },
})
const accion = positionals[0]
if (!values.tabla) throw new Error('Falta --tabla')
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }))

if (accion === 'crear') {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.cuenta ?? '')) throw new Error('--cuenta: minúsculas, números y guiones (ej. movil)')
  if (!values.nombre) throw new Error('Falta --nombre')
  const clave = `bkm_${randomBytes(32).toString('base64url')}`
  const hash = createHash('sha256').update(clave).digest('hex')
  await db.send(new PutCommand({
    TableName: values.tabla,
    Item: { pk: `CLAVE#${hash}`, sk: 'CLAVE', cuenta: values.cuenta, nombre: values.nombre, activa: true, creadaAtUtc: new Date().toISOString() },
    ConditionExpression: 'attribute_not_exists(pk)',
  }))
  console.log(`Clave para ${values.cuenta} (se muestra una sola vez):\n\n  ${clave}\n\nhash: ${hash}`)
} else if (accion === 'quitar') {
  if (!/^[0-9a-f]{64}$/.test(values.hash ?? '')) throw new Error('--hash: el sha256 que mostró «crear»')
  await db.send(new UpdateCommand({
    TableName: values.tabla,
    Key: { pk: `CLAVE#${values.hash}`, sk: 'CLAVE' },
    UpdateExpression: 'SET activa = :no, quitadaAtUtc = :t',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':no': false, ':t': new Date().toISOString() },
  }))
  console.log('Clave desactivada.')
} else {
  console.error('Uso: clave.mjs crear|quitar …')
  process.exit(2)
}
