/**
 * Empaqueta cada función en un solo archivo (`dist/<funcion>/index.mjs`) con esbuild.
 * Mosaicos y capas se suben como .zip (Terraform los arma con archive_file); teselar e imagen van
 * dentro de su imagen de contenedor. Las bibliotecas nativas (MapLibre Native, sharp) no se
 * empaquetan: se instalan en la imagen.
 */
import { build } from 'esbuild'

const FUNCIONES = {
  mosaicos: [],
  capas: [],
  teselar: [],
  imagen: ['@maplibre/maplibre-gl-native', 'sharp'],
}

for (const [nombre, externos] of Object.entries(FUNCIONES)) {
  await build({
    entryPoints: [`src/${nombre}.js`],
    outfile: `dist/${nombre}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    external: externos,
    // Para que un paquete en CommonJS (parte del SDK) funcione dentro de un módulo ES.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  console.log(`dist/${nombre}/index.mjs`)
}
