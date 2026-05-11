# SQL Query Optimization

## Common Anti-Patterns
- **N+1 queries**: Fetch parent + N children queries. Fix with JOIN or batch fetch.
- **SELECT ***: Only select columns you need.
- **Missing indexes**: Add indexes on WHERE, JOIN, ORDER BY columns.
- **Unbounded queries**: Always add LIMIT.

## SQLite in Bun
```typescript
// Use prepared statements for repeated queries
const stmt = db.query("SELECT * FROM users WHERE id = ?")
const user = stmt.get(userId)

// Batch inserts with transactions
db.transaction(() => {
  for (const row of rows) {
    db.query("INSERT INTO logs (msg) VALUES (?)").run(row)
  }
})()
```

## Indexing Rules
- Index foreign keys
- Index columns used in WHERE, JOIN, ORDER BY
- Composite indexes: order matters (equality first, range last)
- Don't over-index: writes become slower

## WAL Mode (Hive-Code default)
- `PRAGMA journal_mode = WAL` enables concurrent reads
- Perfect for multi-worker coordinator system
- Auto-checkpoint: no manual intervention needed
