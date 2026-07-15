# syntax=docker/dockerfile:1.7
# Build with the REPO ROOT as the build context:
#   docker build -f packages/dashboard/Dockerfile -t gitagents-dashboard .

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages

RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund
RUN npm -w @gitagents/dashboard run build

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY packages/dashboard/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /workspace/packages/dashboard/dist ./dist
COPY --from=build /workspace/packages/dashboard/public ./public

USER node
EXPOSE 4173
CMD ["node", "dist/server.js"]
