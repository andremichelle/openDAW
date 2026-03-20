FROM node:23-slim

WORKDIR /app

COPY packages/server/storage-server/ ./

ENV HOST=0.0.0.0
ENV PORT=3000
ENV STORAGE_DIR=/data

EXPOSE 3000

CMD ["node", "server.js"]
