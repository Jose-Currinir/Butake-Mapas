"""Prepara estilos, fuentes y sprite para servirlos desde S3 + CloudFront.

TileServer reescribía en caliente `mbtiles://{openmaptiles}` y las rutas relativas de fuentes y
sprite. Sin servidor, el style.json ya tiene que traer las URLs completas:

  mbtiles://{openmaptiles}  -> https://<dominio>/base/openmaptiles.json   (TileJSON de la Lambda)
  {fontstack}/{range}.pbf   -> https://<dominio>/fonts/{fontstack}/{range}.pbf
  cl                        -> https://<dominio>/sprites/cl

Cada estilo se publica en dos rutas: `styles/<estilo>.json` y `styles/<estilo>/style.json`
(la que ya usan los clientes de TileServer). Solo `cl-light` y `cl-dark`.

Uso: python3 scripts/aws/publicar-estilos.py --dominio mapas.butake.cl --data data --salida .construir/salida
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ESTILOS = ("cl-light", "cl-dark")
FUENTE = re.compile(r"^mbtiles://\{([a-z_]+)\}$")


def reescribir(estilo: dict, dominio: str) -> dict:
    salida = json.loads(json.dumps(estilo))
    for nombre, fuente in salida.get("sources", {}).items():
        url = fuente.get("url", "")
        coincide = FUENTE.match(url)
        if not coincide:
            raise SystemExit(f"Fuente {nombre}: se esperaba mbtiles://{{id}} y llegó {url!r}")
        fuente["url"] = f"https://{dominio}/base/{coincide.group(1)}.json"
    salida["glyphs"] = f"https://{dominio}/fonts/{{fontstack}}/{{range}}.pbf"
    salida["sprite"] = f"https://{dominio}/sprites/{salida.get('sprite', 'cl')}"
    return salida


def main() -> int:
    argumentos = argparse.ArgumentParser()
    argumentos.add_argument("--dominio", required=True)
    argumentos.add_argument("--data", required=True, type=Path)
    argumentos.add_argument("--salida", required=True, type=Path)
    a = argumentos.parse_args()
    if not re.fullmatch(r"[a-z0-9.-]+", a.dominio):
        raise SystemExit("Dominio inválido")

    estilos = a.salida / "styles"
    estilos.mkdir(parents=True, exist_ok=True)
    for nombre in ESTILOS:
        documento = reescribir(json.loads((a.data / "styles" / f"{nombre}.json").read_text("utf-8")), a.dominio)
        texto = json.dumps(documento, ensure_ascii=False, separators=(",", ":"))
        (estilos / f"{nombre}.json").write_text(texto, "utf-8")
        (estilos / nombre).mkdir(exist_ok=True)
        (estilos / nombre / "style.json").write_text(texto, "utf-8")

    for carpeta in ("fonts", "sprites"):
        destino = a.salida / carpeta
        if destino.exists():
            shutil.rmtree(destino)
        shutil.copytree(a.data / carpeta, destino)
    print(f"Estilos publicados en {estilos}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
