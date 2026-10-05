FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production DB_FILE=/data/bookclub.sqlite PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
