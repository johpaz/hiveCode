# HIVETUI premium components from TUIE reference

Date: 2026-05-28
Scope: terminal UI only. Web UI is out of scope.

## Decision

`tuie-main-example` is a reference implementation, not a dependency target.
`hivetui` keeps its current Rust + crossterm + Canvas runtime because it is
already wired to HiveCode IPC, headless tests, task streaming, and the current
60 fps render budget.

The work is to port the useful ideas from TUIE into native HIVETUI modules:

- flex constraints instead of fixed split math everywhere;
- mouse hit regions instead of hard-coded row/column checks;
- reusable panes, tables, virtual lists, scrollables, and markdown views;
- better text overflow, wrapping, and cell-width handling;
- semantic theme tokens for agent roles, task state, risk, and review state.

## What we take from TUIE

Useful references:

- `src/widget/flex.rs`: main-axis flex grow/shrink resolver.
- `src/widget/widgets/split.rs`: nested split panes and draggable boundaries.
- `src/widget/widgets/list.rs`: virtualized list window and scroll anchors.
- `src/util/text_overflow.rs`: text overflow iterator and wrapping strategies.
- `src/widget/scrollbar.rs`: scrollbar state, visibility, drag, and smooth thumb.
- `src/theme/harmonious.rs`: palette/token thinking.

What we do not take:

- TUIE runtime lifecycle.
- TUIE widget tree as the root app model.
- GUI/font/GPU/image stack in the first pass.
- Async callback runtime.

Those parts are useful later only if HIVETUI needs a separate GUI mode.

## Phase 1: Base modules

Create `packages/hivetui/src/ui` as the internal component foundation:

```text
ui/layout.rs   Constraint, FlexSpec, split helpers
ui/text.rs     cell width, wrap, ellipsis, overflow helpers
ui/hit.rs      MouseRegion, HitMap, actions
ui/theme.rs    semantic colors and role colors
```

This phase must not migrate existing screens yet. It provides tested primitives
that later screens can adopt one by one.

Acceptance criteria:

- `cargo test` passes.
- Layout resolver supports fixed, percent, fill, and preferred/min/max specs.
- Text helpers do not split wide terminal cells.
- HitMap returns the topmost matching region.
- Theme maps HiveCode worker roles consistently.

## Phase 2: Component kit

Build reusable components on top of `ui` and current `Canvas`:

```text
Pane
SplitPane
Scrollable
VirtualList
Table
MarkdownView
CodeBlock
DiffView
CommandPalette
Modal
InputBox
StatusBadge
WorkerStrip
TaskCard
```

Priority order:

1. `Scrollable` and draggable scrollbars.
2. `Table` with header, selection, fill/fixed/percent columns, and horizontal scroll.
3. `MarkdownView` with cached parse/render output.
4. `VirtualList` for history, logs, workers, and task projections.
5. `SplitPane` with mouse resizing.

## Phase 3: Mouse model

Replace ad hoc mouse routing with a per-frame hit map:

- renderer registers regions as it draws;
- controller routes click, wheel, drag, and release through the hit map;
- widgets expose actions like tab change, row select, split resize, scroll thumb
  drag, approve/cancel, and modal submit;
- keyboard remains first-class and must keep parity with mouse.

This preserves the current crossterm event loop while making mouse behavior
predictable and reusable.

## Phase 4: Markdown

Current HIVETUI markdown is basic and view-specific. The target is a reusable
`MarkdownView`:

- headings, paragraphs, lists, blockquotes, code blocks, inline code;
- markdown tables;
- links rendered as visible terminal text;
- cached render lines keyed by content hash and width;
- virtualized viewport for long agent responses and ADRs;
- no full parse on every frame.

Recommended dependency for this phase: `pulldown-cmark`, with GFM table options.
Syntax highlighting is deferred until markdown layout is stable.

## Phase 5: Screen migration

Migrate screens after the primitives are proven:

- `Dashboard`: task cards, worker strip, task table.
- `Plan`: split pane, markdown ADR, risk table, phase list.
- `Code`: diff view, file table, worker activity.
- `Review`: approval panel, markdown summary, risk/checkpoint tables.
- `Focus`: markdown response view and virtualized history.

Each migration should keep the current visual direction from the research work:
amber identity, dense operational layout, clear agent state, and no web UI.

## Phase 6: Performance guardrails

The target is not continuous repaint for its own sake. The target is a fluid TUI
while agents stream, workers run in parallel, and logs grow.

Rules:

- keep differential Canvas flush;
- cache markdown and wrapped text by width;
- virtualize large lists;
- do not compute hidden tabs on every frame;
- route task updates to projections, then render only visible data;
- keep IPC and render events coalesced to the existing frame budget.

## Implementation order

1. Land Phase 1 primitives and tests.
2. Build `Scrollable`, `Table`, and `MarkdownView`.
3. Migrate `Dashboard` and `Plan`.
4. Add HitMap-backed mouse regions to migrated screens.
5. Migrate `Code`, `Review`, and `Focus`.
6. Add visual polish and performance tests.

## Implementation status

Implemented in this pass:

- `ui/layout.rs`: constraint resolver and split helpers.
- `ui/text.rs`: cell-width aware truncation, ellipsis, wrapping.
- `ui/hit.rs`: per-frame hit map and mouse actions.
- `ui/theme.rs`: semantic theme and role colors.
- `ui/scroll.rs`: scrollbar state and renderer.
- `ui/table.rs`: header, selected rows, fill/fixed/percent columns.
- `ui/markdown.rs`: reusable markdown lines and renderer for headings, lists,
  code blocks, quotes, and markdown tables.
- `ui/virtual_list.rs`: visible range and ensure-visible state.
- `ui/split.rs`: split panes and handle rendering.
- `ui/pane.rs`: reusable pane shell.

Migrated screens:

- `Dashboard`: uses the new premium data table.
- `Plan`: uses constraint split panes and MarkdownView for ADR extracts.
- `Code`: uses constraint split panes for diff/workers/checkpoints.
- `Review`: uses MarkdownView and the new premium data table.
- `Focus`: agent responses now use the shared markdown line builder.

Mouse integration:

- renderer now builds a per-frame `HitMap`;
- tab regions are registered as hit targets;
- controller consumes hit-map tab actions before falling back to legacy
  coordinate routing.

Remaining follow-up, intentionally deferred:

- draggable split handles;
- scrollbar thumb dragging;
- full markdown parser dependency such as `pulldown-cmark`;
- syntax highlighting beyond current lightweight rendering;
- optional terminal palette probing.

## Non-goals

- Do not replace HIVETUI with TUIE.
- Do not change the agent coordinator flow.
- Do not touch the web UI.
- Do not add GUI/font/image protocols until terminal fundamentals are complete.
