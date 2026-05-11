# Async Error Handling

## Rules for Bun/TypeScript
1. **Always await**: Unhandled promises crash the process
2. **Use try/catch**: Wrap every async boundary
3. **Preserve stack traces**: Bun 1.3+ has excellent async stacks

## Patterns
```typescript
// Good: catch and wrap
async function fetchUser(id: string): Promise<User> {
  try {
    const res = await fetch(`/api/users/${id}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    throw new Error(`Failed to fetch user ${id}: ${(err as Error).message}`)
  }
}

// Good: never swallow errors
async function main() {
  try {
    const user = await fetchUser("123")
    console.log(user.name)
  } catch (err) {
    console.error("Fatal:", err)
    process.exit(1)
  }
}
```

## Worker Error Handling
- Catch errors in worker `onerror`
- Restart workers automatically
- Log full stack traces with `logger.error`

## Bun.spawn Error Handling
```typescript
const proc = Bun.spawn(["git", "status"], { cwd: "." })
const exitCode = await proc.exited
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text()
  throw new Error(`git status failed: ${stderr}`)
}
```
