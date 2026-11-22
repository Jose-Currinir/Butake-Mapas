/**
 * Suma capas de una cuenta a un style.json base (cl-light o cl-dark), sin tocar el original.
 * Cada capa trae puntos, líneas y polígonos en la capa interna `capa` (tippecanoe `-l capa`): se
 * dibujan con tres capas de estilo filtradas por tipo de geometría, encima de todo lo demás.
 */
const COLORES = ['#1f7a4d', '#2563eb', '#c2410c', '#7c3aed', '#0e7490', '#b91c1c', '#a16207', '#be185d']

export function capasEnEstilo(base, capas, { dominio, cuenta, t }) {
  const estilo = structuredClone(base)
  estilo.sources = { ...estilo.sources }
  estilo.layers = [...estilo.layers]
  capas.forEach((capa, indice) => {
    const fuente = `capa-${capa.id}`
    const color = COLORES[indice % COLORES.length]
    estilo.sources[fuente] = {
      type: 'vector',
      tiles: [`https://${dominio}/capas/${cuenta}/${capa.id}/{z}/{x}/{y}.mvt?t=${t}`],
      minzoom: capa.minzoom ?? 0,
      maxzoom: capa.maxzoom ?? 14,
      ...(Array.isArray(capa.limites) ? { bounds: capa.limites } : {}),
      attribution: capa.nombre,
    }
    const comun = { source: fuente, 'source-layer': 'capa', metadata: { 'butake:capa': capa.id, 'butake:nombre': capa.nombre } }
    estilo.layers.push(
      { ...comun, id: `${fuente}-relleno`, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': 0.2 } },
      { ...comun, id: `${fuente}-borde`, type: 'line', filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]], paint: { 'line-color': color, 'line-width': 2 } },
      { ...comun, id: `${fuente}-punto`, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': color, 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } },
    )
  })
  return estilo
}
