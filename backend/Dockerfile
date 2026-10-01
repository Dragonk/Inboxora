FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
# Install dev dependencies too so the TypeScript compiler is available for the build stage.
RUN npm ci

FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

ARG BUILD_SHA
ARG APP_VERSION
ENV BUILD_SHA=${BUILD_SHA:-dev}
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/preview/requirements.txt /app/preview/requirements.txt
RUN apk add --no-cache python3 py3-pip libarchive libseccomp tzdata && \
    python3 -m venv /opt/inboxora-preview && \
    /opt/inboxora-preview/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r /app/preview/requirements.txt
ENV ATTACHMENT_PREVIEW_PYTHON=/opt/inboxora-preview/bin/python
COPY backend/preview /app/preview

COPY --from=build /app/dist ./dist
COPY backend/migrations ./migrations

RUN APP_VERSION_VALUE="${APP_VERSION:-$(node -p "require('./package.json').version")}"; \
    APP_VERSION_VALUE="$(printf '%s' "$APP_VERSION_VALUE" | sed 's/^v[.]//' | sed 's/^v//')"; \
    printf '{"version":"%s"}\n' "$APP_VERSION_VALUE" > ./build-meta.json && \
    chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
