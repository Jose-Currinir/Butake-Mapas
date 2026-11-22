import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

process.env.BUCKET = 'prueba'
process.env.DOMINIO = 'mapas.butake.cl'

/**
 * Un PMTiles mínimo armado en memoria (spec v3): un directorio raíz con un mosaico en 0/0/0.
 * Sirve para probar la Lambda de punta a punta sin S3: la fuente se reemplaza por un cliente falso.
 */
function varint(n) {
  const salida = []
  while (n >= 0x80) { salida.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  salida.push(n)
  return salida
}
function pmtilesDePrueba(mosaico) {
  const directorio = Buffer.from([...varint(1), ...varint(0), ...varint(1), ...varint(mosaico.length), ...varint(1)])
  const metadatos = Buffer.from(JSON.stringify({ vector_layers: [{ id: 'capa' }], name: 'prueba' }))
  const cab = Buffer.alloc(127)
  cab.write('PMTiles', 0, 'ascii')
  cab.writeUInt8(3, 7)
  const u64 = (pos, v) => cab.writeBigUInt64LE(BigInt(v), pos)
  const raiz = 127
  u64(8, raiz); u64(16, directorio.length)
  u64(24, raiz + directorio.length); u64(32, metadatos.length)
  u64(40, 0); u64(48, 0)
  u64(56, raiz + directorio.length + metadatos.length); u64(64, mosaico.length)
  u64(72, 1); u64(80, 1); u64(88, 1)
  cab.writeUInt8(1, 96) // agrupado
  cab.writeUInt8(1, 97) // directorios sin comprimir
  cab.writeUInt8(1, 98) // mosaicos sin comprimir
  cab.writeUInt8(1, 99) // mvt
  cab.writeUInt8(0, 100); cab.writeUInt8(0, 101)
  cab.writeInt32LE(-760000000, 102); cab.writeInt32LE(-560000000, 106)
  cab.writeInt32LE(-650000000, 110); cab.writeInt32LE(-170000000, 114)
  return Buffer.concat([cab, directorio, metadatos, mosaico])
}

test('mosaicos: lee el mosaico por rango, lo entrega comprimido y responde 404 fuera de reglas', async () => {
  const mosaico = Buffer.from('datos-del-mosaico')
  const archivo = pmtilesDePrueba(mosaico)
  const { S3Client } = await import('@aws-sdk/client-s3')
  const pedidos = []
  S3Client.prototype.send = async function (comando) {
    const [, desde, hasta] = /bytes=(\d+)-(\d+)/.exec(comando.input.Range)
    pedidos.push(comando.input.Range)
    const trozo = archivo.subarray(Number(desde), Number(hasta) + 1)
    return { ETag: '"e1"', Body: { transformToByteArray: async () => new Uint8Array(trozo) } }
  }
  const { handler } = await import('../src/mosaicos.js')

  const r = await handler({ rawPath: '/base/openmaptiles/0/0/0.mvt', requestContext: { http: { method: 'GET' } } })
  assert.equal(r.statusCode, 200)
  assert.equal(r.headers['content-encoding'], 'gzip')
  assert.match(r.headers['cache-control'], /s-maxage=604800/)
  assert.equal(gunzipSync(Buffer.from(r.body, 'base64')).toString(), 'datos-del-mosaico')

  const tilejson = await handler({ rawPath: '/base/openmaptiles.json', requestContext: { http: { method: 'GET' } } })
  assert.equal(JSON.parse(tilejson.body).tiles[0], 'https://mapas.butake.cl/base/openmaptiles/{z}/{x}/{y}.mvt')

  assert.equal((await handler({ rawPath: '/base/openmaptiles/0/0/0.png' })).statusCode, 404, 'formato distinto al del archivo')
  assert.equal((await handler({ rawPath: '/base/../x' })).statusCode, 404)
  assert.equal((await handler({ rawPath: '/base/openmaptiles/0/0/0.mvt', requestContext: { http: { method: 'POST' } } })).statusCode, 405)

  const antes = pedidos.length
  await handler({ rawPath: '/base/openmaptiles/0/0/0.mvt' })
  assert.equal(pedidos.length - antes, 1, 'en caliente, un mosaico es una sola lectura a S3')
})
