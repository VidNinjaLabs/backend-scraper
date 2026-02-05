FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Start
CMD ["npm", "start"]
