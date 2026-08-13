# Image du conteneur distant qui remplace WebContainer pour le terminal et
# les builds (npm install, npm run build, git, etc.).
#
# Construite avec Docker par `wrangler deploy` (Docker doit tourner en
# local), cf. https://developers.cloudflare.com/containers/get-started/

FROM node:20-slim

# Outils nécessaires pour builder les projets générés par l'IA
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /agent
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --omit=dev

COPY agent/server.mjs ./server.mjs

# Workspace où atterrissent les fichiers du projet généré par l'IA
# (voir WORKDIR dans server.mjs — doit correspondre à WORK_DIR_NAME côté app)
RUN mkdir -p /workspace/project
WORKDIR /workspace/project

ENV AGENT_PORT=8081
ENV WORKDIR=/workspace/project
EXPOSE 8081

CMD ["node", "/agent/server.mjs"]
