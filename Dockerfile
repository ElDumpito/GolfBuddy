# No packages at all: Node's own http, crypto and sqlite modules do everything.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8790 DATA_DIR=/app/data TZ=America/Los_Angeles
EXPOSE 8790
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
