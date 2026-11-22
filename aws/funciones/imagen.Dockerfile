# Lambda imagen: MapLibre Native (dibujo con OpenGL por software) + sharp + Xvfb. x86_64.
# Ubuntu 24.04: el binario de MapLibre Native 6.x pide glibc 2.38, libjpeg8 e ICU 74.
#   docker build --platform linux/amd64 -f imagen.Dockerfile -t butake/mapas-imagen .
ARG NODE=22.23.5

# Node oficial, verificado contra SHASUMS256 de nodejs.org.
FROM ubuntu:24.04 AS node
ARG NODE
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
RUN cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE}/SHASUMS256.txt" | grep " node-v${NODE}-linux-x64.tar.xz$" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xJf "node-v${NODE}-linux-x64.tar.xz" -C /opt/node --strip-components=1

# aws-lambda-ric se compila: las herramientas quedan solo en esta etapa.
FROM node AS dependencias
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake g++ make autoconf automake libtool python3 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/node/bin:$PATH
WORKDIR /var/task
RUN npm install --omit=dev --no-audit --no-fund aws-lambda-ric@4.0.2 @maplibre/maplibre-gl-native@6.4.1 sharp@0.35.5

FROM ubuntu:24.04
ENV NODE_ENV=production PATH=/opt/node/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth libgl1 libegl1 libgles2 libopengl0 libuv1t64 libcurl4t64 libjpeg-turbo8 libpng16-16t64 libwebp7 libicu74 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /opt/node/bin/node /opt/node/bin/node
WORKDIR /var/task
COPY --from=dependencias /var/task/node_modules ./node_modules
COPY dist/imagen/index.mjs ./index.mjs
ENTRYPOINT ["node", "node_modules/aws-lambda-ric/index.mjs"]
CMD ["index.handler"]
