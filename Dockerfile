# Syrixa — production image (Node 18 LTS, slim Debian base).
# The app is a single HTTP server: static files + /api/* routes; no separate build step.

FROM node:18-slim
WORKDIR /app

# Install deps first so Docker layer cache stays valid when only app code changes.
COPY package*.json ./
RUN npm install --production

COPY . .
RUN mkdir -p uploads

EXPOSE 3000

# Fails fast if the process stops responding (e.g. event loop blocked).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
