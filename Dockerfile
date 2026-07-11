FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js default-content.json ./
COPY public ./public
RUN mkdir -p public/vendor \
 && cp node_modules/marked/marked.min.js public/vendor/ \
 && cp node_modules/dompurify/dist/purify.min.js public/vendor/ \
 && mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
