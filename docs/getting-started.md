# Getting Started with Hivecode

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0
- Node.js ≥ 18 (for tooling only — Hivecode runs on Bun)
- Git (optional but recommended)
- An API key for at least one supported provider (Anthropic, Google, OpenRouter, etc.)

## Installation

```bash
# Clone the repository
git clone https://github.com/johpaz/hiveCode.git
cd hiveCode

# Install dependencies
bun install

# Build all packages
bun run build
```

For global CLI access:

```bash
bun link packages/cli
# Then use `hivecode` anywhere
```

## First-time setup

Run the interactive setup wizard:

```bash
hivecode init
```

The wizard walks through six steps:

1. **Provider selection** — choose Anthropic Claude, Google Gemini, or OpenRouter
2. **API key** — enter and verify your key (stored encrypted in `~/.hive/config.enc`)
3. **Model selection** — pick the default model for each coordinator
4. **Workspace** — set the working directory where Hivecode edits code
5. **Database** — SQLite path (default: `~/.hive/hive.db`)
6. **Optional channels** — Telegram bot token, Discord webhook, etc.

After init, test the connection:

```bash
hivecode doctor
```

A healthy system shows all providers, gateway, and workers as ✅.

## Your first task

Start an interactive REPL session:

```bash
hivecode
```

Or run a one-shot task:

```bash
hivecode run "añade un endpoint REST /health que retorna {status: 'ok'}"
```

For a structured plan before implementation:

```bash
hivecode plan "añade autenticación JWT"
```

## Troubleshooting

### "Provider not configured"

Run `hivecode init` again or check `~/.hive/config.enc` exists.

### "Gateway failed to start"

Port 16120 may be in use. Check with:

```bash
lsof -i :16120
```

Then stop the conflicting process and retry.

### "No workers available"

The gateway starts workers automatically. If they don't appear within 10 seconds, check logs:

```bash
hivecode logs
```

### Build errors after `bun install`

Run `bun run build --filter '*'` from the repo root to rebuild all packages in dependency order.

### Resetting state

```bash
rm -rf ~/.hive/hive.db   # clears the task database
hivecode init             # reconfigure
```
