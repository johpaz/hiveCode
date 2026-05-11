# Dockerfile Best Practices

## Multi-Stage Build
```dockerfile
# Stage 1: Build
FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY package.json bun.lockb .
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 18791
CMD ["bun", "dist/hive-code.js", "start"]
```

## Rules
- Use specific tags, not `latest`
- Run as non-root user
- Use `.dockerignore` to exclude secrets, .git, node_modules
- Minimize layers: combine RUN commands
- Use `--frozen-lockfile` for reproducible installs

## Bun-Specific
- `oven/bun` is the official image
- `bun install` is faster than npm
- `bun build --compile` creates standalone binaries (no node_modules needed)
- For smallest image: use `distroless` or `scratch` with compiled binary

## Security
- Never copy `.env` or `Bun.secrets`
- Scan images with `docker scan`
- Use read-only filesystem where possible
- Drop capabilities: `--cap-drop=ALL`
