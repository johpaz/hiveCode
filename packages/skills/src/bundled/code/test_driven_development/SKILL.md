---
name: test_driven_development
description: "Test-Driven Development workflow: red-green-refactor cycle with test-first approach"
version: 1.0.0
icon: "🧪"
category: code
tools: [code_test, code_search, fs_read, fs_write, fs_edit]
triggers:
  - "tdd"
  - "test first"
  - "red green refactor"
  - "test driven"
  - "primero los tests"
  - "pruebas primero"
  - "desarrollo guiado por tests"
  - "test unitario"
  - "unit test"
  - "coverage"
preferred_agents: []
steps:
  - step: 1
    action: understand_requirement
    instruction: "Understand the requirement and identify the expected behavior"
  - step: 2
    action: write_test_first
    instruction: "Write a failing test first (RED phase) that describes the desired behavior"
  - step: 3
    action: run_test_red
    instruction: "Run the test to confirm it fails (RED)"
  - step: 4
    action: write_minimal_code
    instruction: "Write minimal code to make the test pass (GREEN phase)"
  - step: 5
    action: run_test_green
    instruction: "Run the test to confirm it passes (GREEN)"
  - step: 6
    action: refactor
    instruction: "Refactor code while keeping tests green (REFACTOR phase)"
  - step: 7
    action: run_test_final
    instruction: "Run all tests to ensure nothing is broken"
rules:
  - "Always write the test before implementation code"
  - "Run tests after each phase to confirm state"
  - "Keep tests simple and focused on one behavior"
  - "Refactor only when tests are green"
  - "Never refactor without test coverage"
output_format:
  structure: markdown
  sections:
    - "test_written"
    - "implementation"
    - "test_results"
    - "refactoring_notes"
examples:
  - user_input: "implementá una función suma con TDD"
    expected_behavior: "Write test → run (fails) → implement → run (passes) → refactor"
---
# Test-Driven Development Skill

## Ciclo Red-Green-Refactor

1. **RED**: Escribir test que falla
2. **GREEN**: Código mínimo para que pase
3. **REFACTOR**: Mejorar código manteniendo tests verdes

## Estructura de Tests

```typescript
describe('sum', () => {
  it('should return 0 for empty array', () => {
    expect(sum([])).toBe(0)
  })
  it('should return sum of numbers', () => {
    expect(sum([1, 2, 3])).toBe(6)
  })
})
```
