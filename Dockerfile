# Debian-based image: ships with OpenSSL, which Prisma needs.
# (Alpine/musl causes "Prisma failed to detect libssl" + engine crashes.)
FROM node:20-slim

# Install OpenSSL and CA certs explicitly so Prisma's engine loads cleanly.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
