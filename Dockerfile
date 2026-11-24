# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 1. Frontend: React + Vite build -> internal/webui/dist
# ---------------------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build
# CV engine: tests of parsing, matching and documents (the build stops if they fail)
COPY cvengine/ /src/cvengine/
RUN node --test /src/cvengine/cv.test.mjs /src/cvengine/cert.test.mjs

# ---------------------------------------------------------------------------
# 2. Backend: single Go binary with the embedded frontend and migrations
# ---------------------------------------------------------------------------
FROM golang:1.27-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
ARG VERSION=1.0.0
RUN go build -ldflags="-s -w -X main.version=${VERSION}" -o /out/portal ./cmd/server

# ---------------------------------------------------------------------------
# 3. Runtime: minimal Alpine with pdftotext/pdftoppm (poppler-utils), Node.js
#    for the CV engine, Tesseract OCR (kaz+rus+eng) for scanned CVs, non-root user
# ---------------------------------------------------------------------------
FROM alpine:3.24
RUN apk add --no-cache poppler-utils ca-certificates tzdata nodejs \
      tesseract-ocr tesseract-ocr-data-rus tesseract-ocr-data-eng \
 && addgroup -S -g 10001 app \
 && adduser -S -D -H -u 10001 -G app app \
 && mkdir -p /data/uploads \
 && chown -R app:app /data
# Alpine packages no Kazakh model: tessdata 4.1.0, pinned by checksum
ADD --checksum=sha256:7187929eb20ffbc7236d5959d761a18d629fc7eb7b1d7a7fb99ad3b226f06740 \
    https://raw.githubusercontent.com/tesseract-ocr/tessdata/4.1.0/kaz.traineddata /usr/share/tessdata/kaz.traineddata
RUN chmod 644 /usr/share/tessdata/kaz.traineddata && tesseract --list-langs | grep -qx kaz
COPY cvengine/ /app/cvengine/
COPY --from=build /out/portal /app/portal
USER app
ENV LISTEN_ADDR=:8080 STORAGE_PATH=/data/uploads
EXPOSE 8080
VOLUME ["/data/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/app/portal", "healthcheck"]
ENTRYPOINT ["/app/portal"]
