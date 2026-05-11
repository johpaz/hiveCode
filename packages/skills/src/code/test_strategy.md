# Test Strategy

## Testing Pyramid
- **Unit tests** (70%): Fast, isolated, test one function/component
- **Integration tests** (20%): Test module interactions, database, APIs
- **E2E tests** (10%): Full user flows, real browser (Bun.WebView)

## Bun:test Best Practices
```typescript
import { test, expect, describe } from "bun:test"

describe("Auth", () => {
  test("login with valid credentials", async () => {
    const res = await login("user", "pass")
    expect(res.token).toBeDefined()
  })
})
```

## Flags
- Always use `--isolate` for clean state per test
- Use `--coverage` to track coverage goals (>= 80%)
- Use `--parallel` for speed when tests are independent

## Test-Driven Development
1. Write failing test
2. Write minimum code to pass
3. Refactor while keeping tests green

## Mocking in Bun
- `jest.mock` equivalent: use `bun:test` mock functions
- Mock `fetch` for external API calls
- Use in-memory SQLite for DB tests

## Coverage Goals
- Hive-Code target: 80% minimum
- Critical paths: 100% (auth, payments, security)
