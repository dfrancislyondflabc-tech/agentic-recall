# A container that starts the server and answers introspection.
#
# This exists for directory listings (Glama and similar) whose checks need to start an MCP server
# and call tools/list. It is NOT how you would normally run agentic-recall: the whole point is that
# it reads a folder of YOUR markdown files on YOUR machine, so a container with no corpus mounted
# has nothing to remember. To use it for real, mount your memory folder and set MEMORY_DIR:
#
#   docker run -i --rm -v /path/to/your/memories:/memories \
#     -e MEMORY_DIR=/memories agentic-recall
#
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source change does not refetch them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Defaults that make the container self-contained when nothing is mounted: an empty corpus in a
# writable place, and the derived indexes beside it. Every one of these is overridable.
ENV MEMORY_DIR=/memories \
    MEMORY_OWN_STORE=/data/store \
    MEMORY_INDEX=/data/curated.json \
    MEMORY_STAGING_INDEX=/data/staging.json \
    MEMORY_HANDOFF_INDEX=0 \
    MEMORY_PROJECTS_INDEX=0 \
    MEMORY_MODEL_CACHE=/data/model-cache \
    HOME=/data

RUN mkdir -p /memories /data/store /data/model-cache

# stdio transport: the server talks JSON-RPC over stdin/stdout, so run it with -i.
ENTRYPOINT ["node", "/app/index.js"]
