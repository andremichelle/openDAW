FROM node:23-slim

WORKDIR /app

COPY packages/server/yjs-server/package.json ./
RUN npm install --omit=dev

COPY packages/server/yjs-server/ ./

ENV HOST=0.0.0.0
ENV PORT=1234
ENV DISABLE_TLS=true

EXPOSE 1234

CMD ["node", "server.js"]
