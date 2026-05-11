# Clean Architecture

## Principles
- Separation of concerns through layers
- Dependency inversion: inner layers define interfaces, outer layers implement them
- Domain logic is independent of frameworks, UI, and databases

## Layers (inside → outside)
1. **Entities**: Enterprise-wide business rules
2. **Use Cases**: Application-specific business rules
3. **Interface Adapters**: Converters between use cases and external agents
4. **Frameworks/Drivers**: UI, database, web, external interfaces

## Dependency Rule
Source code dependencies must point only inward, toward higher-level policies.

## SOLID Reminders
- **S**ingle Responsibility: One reason to change per module
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable
- **I**nterface Segregation: Many client-specific interfaces > one general-purpose
- **D**ependency Inversion: Depend on abstractions, not concretions

## In Bun/TypeScript
- Use `interface` for contracts between layers
- Keep framework imports (Bun.serve, sqlite) in outer layers only
- Never import `bun:sqlite` in a use-case file
