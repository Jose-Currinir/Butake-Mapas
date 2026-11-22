# Lambda teselar: tippecanoe + la función empaquetada (dist/teselar). arm64.
#   docker build --platform linux/arm64 -f teselar.Dockerfile -t butake/mapas-teselar .
FROM public.ecr.aws/lambda/nodejs:22 AS tippecanoe
ARG TIPPECANOE=2.79.0
RUN dnf install -y gcc-c++ make sqlite-devel zlib-devel tar gzip && dnf clean all
RUN curl -fsSL "https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE}.tar.gz" | tar xz -C /tmp \
 && make -C "/tmp/tippecanoe-${TIPPECANOE}" -j"$(nproc)" \
 && cp "/tmp/tippecanoe-${TIPPECANOE}/tippecanoe" /usr/local/bin/tippecanoe

FROM public.ecr.aws/lambda/nodejs:22
RUN dnf install -y sqlite-libs && dnf clean all
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe
COPY dist/teselar/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs
CMD ["index.handler"]
