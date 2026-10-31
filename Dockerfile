# Planning Events — image de production
FROM node:20-alpine

# Correctifs de sécurité des paquets système de l'image de base
# (openssl 3.5.6-r0 → 3.5.8-r0 : ALPINE-CVE-2026-34182 / -63073 / -75803 et suivants)
RUN apk upgrade --no-cache \
 && apk add --no-cache openssl ca-certificates

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
