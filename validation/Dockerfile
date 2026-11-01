FROM node:22-bookworm
WORKDIR /workspace
COPY package.json package-lock.json LICENSE NOTICE ./
COPY packages/i18n/package.json ./packages/i18n/package.json
COPY packages/document-model/package.json ./packages/document-model/package.json
COPY packages/sync-core/package.json ./packages/sync-core/package.json
COPY packages/editor/package.json ./packages/editor/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY packages ./packages
COPY validation ./validation
RUN npm run build:validation
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","validation/dist/server/api/main.js"]
