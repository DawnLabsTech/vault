FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

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
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]
