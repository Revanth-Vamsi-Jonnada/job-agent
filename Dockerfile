# Job Agent container for Render (or any Docker host).
# Chromium is included so tailored CVs and cover letters come out as PDFs.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    BROWSER_PATH=/usr/bin/chromium \
    PUBLIC_MODE=1 \
    PORT=10000

WORKDIR /app
COPY . .
EXPOSE 10000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
