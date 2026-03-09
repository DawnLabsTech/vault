FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Copy source
COPY tsconfig.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build
RUN npm run build

# Create data directory
RUN mkdir -p data

# Remove dev dependencies
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
