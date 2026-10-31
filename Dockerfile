# Planning Events — image de production
FROM node:20-alpine

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
