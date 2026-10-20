FROM python:3.13-slim-bookworm AS dictionary
WORKDIR /src
COPY tools/prepare_dictionary.py ./tools/prepare_dictionary.py
COPY third_party/ecdict ./third_party/ecdict
RUN python3 tools/prepare_dictionary.py --output /dictionary/ecdict

FROM node:22-bookworm-slim AS frontend
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN pnpm build

FROM golang:1.26-bookworm AS backend
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /firstleap ./cmd/firstleap

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/* && groupadd -g 10001 firstleap && useradd -u 10001 -g firstleap -M firstleap && mkdir -p /data /media /textbooks /app/web && chown firstleap:firstleap /data
COPY --from=dictionary /dictionary /app/dictionary
COPY --from=backend /firstleap /usr/local/bin/firstleap
COPY --from=frontend /src/web/dist /app/web
WORKDIR /app
ENV PORT=8000 WEB_ROOT=/app/web MEDIA_ROOT=/media DATA_ROOT=/data DICTIONARY_ROOT=/app/dictionary/ecdict
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["firstleap", "healthcheck"]
ENTRYPOINT ["firstleap"]
