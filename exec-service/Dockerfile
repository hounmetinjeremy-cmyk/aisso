FROM node:20-slim

# git, python3/make/g++ couvrent la majorité des `npm install`/builds courants sans alourdir l'image outre mesure.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

RUN mkdir -p /workspace
ENV WORKSPACE_ROOT=/workspace

EXPOSE 3000
CMD ["node", "server.js"]
