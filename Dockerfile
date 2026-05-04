FROM oven/bun:1.3.7-alpine

WORKDIR /app

ENV NODE_ENV=development
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_ORIGIN=http://localhost:3000
ENV DATA_DIR=/data

COPY package.json bun.lock* ./
COPY README.md ./
COPY .env.example ./
COPY .gmrc.cjs ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY test ./test
COPY docs ./docs
COPY migrations ./migrations

RUN bun install --frozen-lockfile || bun install
RUN bun run build

EXPOSE 3000
VOLUME ["/data"]

CMD ["bun", "run", "start"]
