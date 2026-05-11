# TypeScript Strict

## Strict Mode Rules
Always enable in `tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true
  }
}
```

## Best Practices
- **No `any`**: Use `unknown` + type guards
- **Explicit return types**: On public APIs
- **Null safety**: Always handle `undefined`/`null`
- **Discriminated unions**: For state machines

## Patterns
```typescript
// Type guard
function isUser(obj: unknown): obj is User {
  return obj !== null && typeof obj === "object" && "id" in obj
}

// Discriminated union
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

// Branded types for IDs
type UserId = string & { __brand: "UserId" }
function UserId(id: string): UserId { return id as UserId }
```

## Bun-Specific
- `bun:sqlite` types are built-in
- `Bun.file()` returns `BunFile` with `.text()`, `.json()`, `.stream()`
- Workers: use `declare var self` for type safety
