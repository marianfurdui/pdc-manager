FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
