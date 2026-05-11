# React Patterns

## Component Design
- **Single Responsibility**: One component = one job
- **Composition over Inheritance**: Build complex UIs from simple pieces
- **Controlled vs Uncontrolled**: Prefer controlled for form inputs

## Hooks Rules
- Only call hooks at top level (not in loops/conditions)
- Only call hooks from React functions
- Custom hooks: extract reusable stateful logic

## Performance
- `useMemo` for expensive computations
- `useCallback` for stable function references passed to children
- `React.memo` to prevent unnecessary re-renders
- Split code with dynamic imports

## Bun/WebView Testing
- Use `Bun.WebView` for visual verification
- Capture screenshots after each component change
- Check console errors with `view.onConsoleMessage`
- Mock API calls when backend is not ready

## State Management
- Local state: `useState`, `useReducer`
- Server state: React Query / SWR
- Global state: Zustand (lightweight) or Context (simple)
- NEVER put secrets in React state
