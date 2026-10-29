FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "src/server.mjs"]
