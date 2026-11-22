import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

const ssm = new SSMClient({})
let guardado = null
let leidoEn = 0

/** El secreto de firma, leído de SSM una vez cada 10 minutos (rotarlo no exige redesplegar). */
export async function secreto() {
  if (guardado && Date.now() - leidoEn < 10 * 60 * 1000) return guardado
  const nombre = process.env.PARAMETRO_SECRETO
  if (!nombre) throw new Error('Falta PARAMETRO_SECRETO')
  const respuesta = await ssm.send(new GetParameterCommand({ Name: nombre, WithDecryption: true }))
  guardado = respuesta.Parameter?.Value
  if (!guardado || guardado.length < 32) throw new Error('El secreto de firma no existe o es corto')
  leidoEn = Date.now()
  return guardado
}
