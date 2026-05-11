# Bun Native APIs

## When to Use What
| Need | API | Why |
|------|-----|-----|
| HTTP server | `Bun.serve()` | Fast, native, WebSocket built-in |
| Database | `bun:sqlite` | Zero deps, WAL mode, 10x faster than node-sqlite3 |
| Parallel work | `new Worker()` | Real threads, `smol` for light workers |
| Secrets | `Bun.secrets` | OS keystore, never in env |
| File I/O | `Bun.file()` / `Bun.write()` | Optimized, streaming |
| Hashing | `Bun.CryptoHasher` | Fast, native |
| Passwords | `Bun.password.hash()` | bcrypt, argon2 |
| Process spawn | `Bun.spawn()` | Type-safe, streaming |
| Cron jobs | `Bun.cron()` | Native, no external deps |
| Bundling | `Bun.build()` | Fast bundler built-in |

## Worker Tips
- Use `{ smol: true }` for I/O-light workers (Security, DevOps)
- Use normal heap for heavy workers (Backend, Test)
- `postMessage(string)` is 500x faster than objects
- `setEnvironmentData` for static config (zero overhead)

## SQLite Tips
- Always enable WAL: `PRAGMA journal_mode = WAL`
- Use prepared statements
- `Database.transaction()` for atomic batches
- Memory-map large DBs: `PRAGMA mmap_size = 256MB`
