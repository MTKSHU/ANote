FROM node:22-bookworm AS build
WORKDIR /workspace
COPY package.json package-lock.json LICENSE NOTICE ./
COPY packages/i18n/package.json ./packages/i18n/package.json
COPY packages/document-model/package.json ./packages/document-model/package.json
COPY packages/sync-core/package.json ./packages/sync-core/package.json
COPY packages/editor/package.json ./packages/editor/package.json
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=cache,target=/root/.npm ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --registry="$NPM_REGISTRY" --fetch-retries=1 --no-audit --no-fund
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY apps/desktop/renderer ./apps/desktop/renderer
RUN npm run build:workspace
ENV NODE_ENV=production
RUN mkdir -p /data/resources/originals /data/resources/uploads /data/resources/derived && chown -R node:node /data/resources
EXPOSE 3000
USER node
CMD ["node","apps/api/dist/main.js"]
