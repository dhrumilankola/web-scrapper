# Use Node 20 slim for smaller image
FROM node:20-slim

# Prevent Next.js telemetry in CI/CD
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run default port
ENV PORT=8080

WORKDIR /app

# Install system deps required by Playwright browsers
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libasound2 libxcomposite1 libxrandr2 libxdamage1 libgbm1 libpango-1.0-0 \
    libxshmfence1 libxfixes3 libxext6 libx11-6 libx11-xcb1 libxcb1 libxss1 \
    fonts-liberation libgtk-3-0 libglib2.0-0 wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies (cached)
COPY package.json package-lock.json* ./
RUN npm ci

# Install Playwright Chromium (+ deps) for runtime
# If only Chromium is needed:
RUN npx playwright install --with-deps chromium

# Copy source and build
COPY . .
RUN npm run build

# Cloud Run will send traffic to PORT; ensure Next binds to it
CMD ["sh","-c","npm run start -- -p ${PORT:-8080}"]