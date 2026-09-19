FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install
RUN bun run fixtures
EXPOSE 8080
CMD ["bun", "apps/server/src/index.ts"]
