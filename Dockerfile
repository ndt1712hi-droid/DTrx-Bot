FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json index.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "lib/index.js"]
