FROM node:20-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy config files
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json vite.config.ts ./

# Install dependencies (frozen-lockfile ensures reproducibility)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build both server (dist/) and library (lib/)
RUN pnpm run build

# Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built artifacts and dependencies
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/lib ./dist/lib
COPY --from=builder /app/node_modules ./node_modules

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Start server
CMD ["pnpm", "start"]
