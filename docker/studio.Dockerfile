FROM node:23-slim AS builder

WORKDIR /app

COPY package.json package-lock.json turbo.json lerna.json ./
COPY packages/ ./packages/

RUN npm install

ARG VITE_VJS_ONLINE_SERVER_URL=wss://live.opendaw.studio
ARG VITE_VJS_USE_LOCAL_SERVER=false
ARG VITE_VJS_LOCAL_SERVER_URL=wss://localhost:1234
ARG VITE_SELFHOSTED_STORAGE_URL=
ENV VITE_VJS_ONLINE_SERVER_URL=${VITE_VJS_ONLINE_SERVER_URL}
ENV VITE_VJS_USE_LOCAL_SERVER=${VITE_VJS_USE_LOCAL_SERVER}
ENV VITE_VJS_LOCAL_SERVER_URL=${VITE_VJS_LOCAL_SERVER_URL}
ENV VITE_SELFHOSTED_STORAGE_URL=${VITE_SELFHOSTED_STORAGE_URL}

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/packages/app/studio/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
