FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

# Routes directory for dynamic route loading
RUN mkdir -p /app/routes

EXPOSE 8080

CMD ["node", "server.js"]