# Use official Node.js 20 lightweight Alpine image
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci

# Copy remaining source code and build
COPY . .
RUN npm run build

# Create production image
FROM node:20-alpine

WORKDIR /app

# Copy production dependencies and build outputs from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Expose the standard port
EXPOSE 3000

# Start the compiled CommonJS server
CMD ["npm", "run", "start"]
