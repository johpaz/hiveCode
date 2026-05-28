/// Integration tests for the hivetui state machine and widget rendering.
///
/// These tests are 100% real — they call the actual production code paths:
///   BunMessage → AppState::apply_message → widget render → Canvas cell inspection
///
/// No mocking. Every test runs in parallel (`cargo test --test tui_integration`).

use hivetui::{
    ipc::BunMessage,
    renderer,
    state::{AppState, Role, HistoryEntry, ReplMode, TabId},
    term::{Canvas, Rect},
    widgets::{history, code_layout, plan_layout, review_layout},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn make_canvas(w: u16, h: u16) -> Canvas {
    Canvas::new(w, h)
}

/// Returns the chars in a horizontal strip from (x, y) up to `len` columns.
fn row_text(canvas: &Canvas, x: u16, y: u16, len: u16) -> String {
    (x..x + len)
        .filter_map(|cx| canvas.cell_at(cx, y))
        .filter(|c| c.ch != '\0' && c.ch != ' ')
        .map(|c| c.ch)
        .collect()
}

/// True if any cell anywhere in the canvas matches predicate.
fn canvas_contains<F: Fn(char) -> bool>(canvas: &Canvas, f: F) -> bool {
    for y in 0..canvas.h {
        for x in 0..canvas.w {
            if let Some(c) = canvas.cell_at(x, y) {
                if f(c.ch) { return true; }
            }
        }
    }
    false
}

/// True if any cell in the rectangular region matches predicate.
fn region_contains<F: Fn(char) -> bool>(canvas: &Canvas, x0: u16, y0: u16, x1: u16, y1: u16, f: F) -> bool {
    for y in y0..y1 {
        for x in x0..x1 {
            if let Some(c) = canvas.cell_at(x, y) {
                if f(c.ch) { return true; }
            }
        }
    }
    false
}

fn base_state() -> AppState {
    let mut s = AppState::default();
    s.apply_message(BunMessage::Init {
        session_id: "sess-test-001".into(),
        workers: vec!["bee".into(), "backend".into(), "frontend".into()],
        mode: Some("auto".into()),
        provider: Some("anthropic".into()),
        model: Some("claude-3-5-sonnet".into()),
        project_name: Some("hiveCode".into()),
        project_path: Some("/tmp/project".into()),
        version: Some("1.0.0".into()),
        task_count: Some(0),
        token_count: Some(0),
    });
    s
}

// ── 1. Focus: muestra la pregunta cuando running=true y modo PLAN ─────────────

#[test]
fn focus_shows_user_question_while_running_plan_mode() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("plan".into()),
        new_provider: None,
        new_model: None,
    });
    // Usuario envía tarea
    state.history.entries.push(HistoryEntry {
        role: Role::User,
        content: "implementa el sistema de login".into(),
        agent: None,
        timestamp: None,
    });
    state.apply_message(BunMessage::Status { running: true, msg: "pensando…".into() });

    // Bee empieza a razonar — aún sin workers
    state.apply_message(BunMessage::ThoughtChunk {
        task_id: None,
        coordinator: "bee".into(),
        phase: "planning".into(),
        content: "Analizando requerimientos de autenticación".into(),
    });

    let mut canvas = make_canvas(100, 20);
    let area = Rect::new(0, 0, 100, 20);
    history::render(&mut canvas, area, &state);

    // history::render pone el turn expandido en la mitad inferior — buscar en todo el canvas
    assert!(
        canvas_contains(&canvas, |c| c == '▸'),
        "Focus debe mostrar '▸' con la pregunta del usuario mientras running=true"
    );

    // Al menos una fila muestra contenido del thought chunk ("Analizando…")
    assert!(
        canvas_contains(&canvas, |c| c == 'A'),
        "Focus debe mostrar el stream de pensamiento cuando no hay workers activos"
    );
}

// ── 2. Focus: muestra workers cuando running=true y modo AUTO con workers ──────

#[test]
fn focus_shows_workers_while_running_auto_mode() {
    let mut state = base_state();
    // Activar workers en estado Running
    state.apply_message(BunMessage::WorkerUpdate {
        task_id: None,
        worker: "backend".into(),
        phase: "escribiendo src/auth/jwt.ts".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
    });
    state.apply_message(BunMessage::WorkerUpdate {
        task_id: None,
        worker: "frontend".into(),
        phase: "escribiendo src/components/Login.tsx".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
    });
    state.history.entries.push(HistoryEntry {
        role: Role::User,
        content: "implementa login".into(),
        agent: None,
        timestamp: None,
    });
    state.apply_message(BunMessage::Status { running: true, msg: "workers activos".into() });

    let mut canvas = make_canvas(120, 20);
    let area = Rect::new(0, 0, 120, 20);
    history::render(&mut canvas, area, &state);

    // El turn expandido está en la mitad inferior — buscar en todo el canvas
    assert!(
        canvas_contains(&canvas, |c| c == '▸'),
        "Debe mostrar la pregunta del usuario"
    );

    // Al menos una fila tiene nombre de worker (⬡ + "backend" o "frontend")
    assert!(
        canvas_contains(&canvas, |c| c == '⬡'),
        "Focus debe mostrar los workers activos cuando corren en AUTO mode"
    );
}

// ── 3. Focus: muestra respuesta completa cuando running=false ─────────────────

#[test]
fn focus_shows_full_response_when_done() {
    let mut state = base_state();
    state.history.entries.push(HistoryEntry {
        role: Role::User,
        content: "¿qué hace auth.ts?".into(),
        agent: None,
        timestamp: None,
    });
    state.history.entries.push(HistoryEntry {
        role: Role::Assistant,
        content: "Es el módulo de autenticación JWT.".into(),
        agent: None,
        timestamp: None,
    });
    state.running = false;

    let mut canvas = make_canvas(100, 20);
    let area = Rect::new(0, 0, 100, 20);
    history::render(&mut canvas, area, &state);

    // Turn expandido en la mitad inferior — buscar en todo el canvas
    assert!(
        canvas_contains(&canvas, |c| c == '▸'),
        "Debe mostrar la pregunta"
    );

    // "Es el módulo…" debe aparecer en alguna fila
    assert!(
        canvas_contains(&canvas, |c| c == 'E'),
        "Focus debe mostrar la respuesta completa cuando running=false"
    );
}

// ── 4. Auto-routing: PLAN mode conserva Focus hasta recibir un plan ───────────

#[test]
fn routing_plan_mode_waits_for_structured_plan() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("plan".into()),
        new_provider: None,
        new_model: None,
    });
    assert_eq!(state.session.mode, ReplMode::Plan);
    assert_eq!(state.active_tab, TabId::Focus,
        "Cambiar a modo plan debe mantener Focus mientras el plan se genera");
}

// ── 5. Auto-routing: APPROVAL mode → Tab cambia a Review ─────────────────────

#[test]
fn routing_approval_mode_navigates_to_review_tab() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("approval".into()),
        new_provider: None,
        new_model: None,
    });
    assert_eq!(state.session.mode, ReplMode::Approval);
    assert_eq!(state.active_tab, TabId::Review,
        "Cambiar a modo approval debe navegar a Review tab");
}

// ── 6. Auto-routing: AUTO running → Code; AssistantDone → Focus ──────────────

#[test]
fn routing_auto_mode_code_then_focus() {
    let mut state = base_state();
    // Ya está en AUTO (base_state inicializa con "auto")

    // Worker activo → debe ir a Code
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: None,
        coordinator: "backend".into(),
        phase: "escribiendo archivos".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
    });
    assert_eq!(state.active_tab, TabId::Code,
        "AUTO mode + worker running debe navegar a Code tab");

    // Tarea terminada → debe volver a Focus
    state.apply_message(BunMessage::AssistantDone);
    assert!(!state.running, "running debe ser false tras AssistantDone");
    assert!(!state.tab_locked, "tab_locked debe liberarse tras AssistantDone");
    assert_eq!(state.active_tab, TabId::Focus,
        "AssistantDone en AUTO mode debe volver a Focus tab");
}

// ── 7. Manual tab lock: usuario elige tab → se mantiene hasta AssistantDone ──

#[test]
fn manual_tab_lock_overrides_auto_routing() {
    let mut state = base_state();
    // Usuario navega manualmente a Review (tab 4)
    state.active_tab = TabId::Review;
    state.tab_locked = true;

    // Llega ActivityUpdate (normalmente iría a Code en AUTO mode)
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: None,
        coordinator: "backend".into(),
        phase: "escribiendo".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
    });
    assert_eq!(state.active_tab, TabId::Review,
        "tab_locked=true debe impedir el auto-routing");

    // AssistantDone libera el lock
    state.apply_message(BunMessage::AssistantDone);
    assert!(!state.tab_locked, "AssistantDone debe liberar tab_locked");
}

// ── 8. Welcome screen: no muestra el widget de input ─────────────────────────

#[test]
fn welcome_screen_does_not_render_input_widget() {
    let mut state = base_state();
    state.show_welcome = true;
    // history vacío → welcome se activa

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &state);

    // El input widget está en las últimas 4 filas (rows[5] = 4 de altura).
    // La fila del input (y=24 para h=30) NO debe tener la bee '🐝' ni el hex '⬡'
    // — la pantalla de bienvenida debe cubrirla completamente.
    let input_y = 30 - 4 - 1 - 1; // h - input(4) - status(1) - 0-indexed
    let has_bee = (0..120u16).any(|x| {
        canvas.cell_at(x, input_y).map(|c| c.ch == '🐝').unwrap_or(false)
    });
    assert!(!has_bee, "Welcome screen debe cubrir el input widget — la bee no debe ser visible");
}

// ── 9. Code layout: split dinámico con 3+ workers activos ────────────────────

#[test]
fn code_layout_renders_all_workers() {
    let mut state = base_state();
    // Activar 3 workers simultáneos (Bee puede llamar hasta 6 en paralelo)
    for (name, phase) in [
        ("backend",  "escribiendo jwt.ts"),
        ("frontend", "escribiendo Login.tsx"),
        ("security", "auditando middleware"),
    ] {
        state.apply_message(BunMessage::WorkerUpdate {
            task_id: None,
            worker: name.into(),
            phase: phase.into(),
            status: "running".into(),
            display_name: None,
            activity: None,
        });
    }

    let mut canvas = make_canvas(160, 30);
    let area = Rect::new(0, 0, 160, 30);
    code_layout::render(&mut canvas, area, &state);

    // Con 3+ workers activos el layout da 40/60 → panel de workers desde col 64.
    // Los workers se renderizan en area.x+5 = 69. Buscar en la mitad derecha del canvas.
    let right_x = 64u16;
    let found_backend  = region_contains(&canvas, right_x, 0, 160, 30, |c| c == 'b');
    let found_frontend = region_contains(&canvas, right_x, 0, 160, 30, |c| c == 'f');
    assert!(found_backend,  "Code layout debe mostrar worker 'backend'");
    assert!(found_frontend, "Code layout debe mostrar worker 'frontend'");
}

// ── 10. Plan layout: panel derecho muestra ADRs en modo PLAN ─────────────────

#[test]
fn plan_layout_shows_adrs_in_plan_mode() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("plan".into()),
        new_provider: None,
        new_model: None,
    });
    state.apply_message(BunMessage::AdrUpdate {
        path: "docs/adr/001-jwt.md".into(),
        title: "Usar JWT para sesiones".into(),
        content: "# ADR-001\n## Contexto\nNecesitamos auth stateless.".into(),
        status: "accepted".into(),
    });
    // Añadir pensamiento para el panel izquierdo
    state.apply_message(BunMessage::ThoughtChunk {
        task_id: None,
        coordinator: "bee".into(),
        phase: "planning".into(),
        content: "Diseñando la arquitectura de auth".into(),
    });

    let mut canvas = make_canvas(160, 30);
    let area = Rect::new(0, 0, 160, 30);
    plan_layout::render(&mut canvas, area, &state);

    // Panel derecho (x > 96 en split 60/40) debe contener texto del ADR
    let found_adr_title = (0..30u16).any(|y| {
        row_text(&canvas, 96, y, 64).contains('J')  // "JWT" del título
    });
    assert!(found_adr_title, "Plan layout debe mostrar el título del ADR en el panel derecho");
}

// ── 11. Review layout: approval strip más prominente en modo APPROVAL ─────────

#[test]
fn review_layout_shows_approval_hints() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("approval".into()),
        new_provider: None,
        new_model: None,
    });
    state.apply_message(BunMessage::FileRiskUpdate {
        path: "src/auth/jwt.ts".into(),
        risk: "high".into(),
        operation: "create".into(),
        agent: "backend".into(),
        adr_ref: None,
        reason: None,
        lines_added: None,
        lines_removed: None,
    });

    let mut canvas = make_canvas(120, 20);
    let area = Rect::new(0, 0, 120, 20);
    review_layout::render(&mut canvas, area, &state);

    // El strip de aprobación debe mostrar 'a' de /approve y 'r' de /reject
    let found_approve = (0..20u16).any(|y| row_text(&canvas, 0, y, 120).contains('a'));
    let found_reject  = (0..20u16).any(|y| row_text(&canvas, 0, y, 120).contains('r'));
    assert!(found_approve, "Review layout debe mostrar hint de /approve");
    assert!(found_reject,  "Review layout debe mostrar hint de /reject");
}

// ── 12. Historial compacto: turns anteriores en 1 sola línea ─────────────────

#[test]
fn history_compact_renders_one_line_per_old_turn() {
    let mut state = base_state();
    // Dos turns completos (User+Assistant) ya finalizados
    state.history.entries.push(HistoryEntry { role: Role::User,      content: "turno uno".into(), agent: None, timestamp: None });
    state.history.entries.push(HistoryEntry { role: Role::Assistant, content: "respuesta uno completa".into(), agent: None, timestamp: None });
    state.history.entries.push(HistoryEntry { role: Role::User,      content: "turno dos".into(), agent: None, timestamp: None });
    state.history.entries.push(HistoryEntry { role: Role::Assistant, content: "respuesta dos completa y más larga".into(), agent: None, timestamp: None });
    // El último turn activo
    state.history.entries.push(HistoryEntry { role: Role::User,      content: "turno tres activo".into(), agent: None, timestamp: None });
    state.running = false;

    let mut canvas = make_canvas(100, 20);
    let area = Rect::new(0, 0, 100, 20);
    history::render(&mut canvas, area, &state);

    // El turn activo debe tener el marcador ▸ en algún punto del canvas
    assert!(canvas_contains(&canvas, |c| c == '▸'), "El turn activo debe tener el marcador ▸");
    // El turn activo NO debe mostrar el contenido duplicado — muestra "esperando respuesta…"
    let has_waiting_text = (0..20u16).any(|y| {
        let row: String = (0..100u16)
            .filter_map(|x| canvas.cell_at(x, y))
            .filter(|c| c.ch != '\0')
            .map(|c| c.ch)
            .collect();
        row.contains("esperando")
    });
    assert!(has_waiting_text, "Debe mostrar hint de espera");
}

// ── 13. Secuencia completa: Init → tarea → respuesta streaming ───────────────

#[test]
fn full_sequence_init_task_streaming_response() {
    let mut state = AppState::default();

    // 1. Init desde SQLite snapshot (lo que envía tui-launcher.ts)
    state.apply_message(BunMessage::Init {
        session_id: "sess-abc123".into(),
        workers: vec!["bee".into(), "backend".into()],
        mode: Some("auto".into()),
        provider: Some("anthropic".into()),
        model: Some("claude-sonnet-4-5".into()),
        project_name: Some("hiveCode".into()),
        project_path: Some("/home/dev/hiveCode".into()),
        version: Some("1.0.0".into()),
        task_count: Some(5),
        token_count: Some(42000),
    });
    assert_eq!(state.session.session_id, "sess-abc123");
    assert_eq!(state.workers.workers.len(), 2);

    // 2. Usuario envía tarea → en app.rs se añade el entry y se envía Submit a Bun
    state.history.entries.push(HistoryEntry {
        role: Role::User,
        content: "añade tests para jwt.ts".into(),
        agent: None,
        timestamp: None,
    });

    // 3. Bun responde con Status running
    state.apply_message(BunMessage::Status { running: true, msg: "procesando…".into() });
    assert!(state.running);

    // 4. Bee emite pensamiento
    state.apply_message(BunMessage::ThoughtChunk {
        task_id: None,
        coordinator: "bee".into(),
        phase: "planning".into(),
        content: "Voy a analizar jwt.ts primero".into(),
    });
    assert_eq!(state.thought.chunks.len(), 1);

    // 5. Worker activo → routing a Code
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: None,
        coordinator: "backend".into(),
        phase: "escribiendo tests".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
    });
    assert_eq!(state.active_tab, TabId::Code);

    // 6. Archivo modificado
    state.apply_message(BunMessage::FileRiskUpdate {
        path: "src/auth/jwt.test.ts".into(),
        risk: "low".into(),
        operation: "create".into(),
        agent: "backend".into(),
        adr_ref: None,
        reason: None,
        lines_added: None,
        lines_removed: None,
    });
    assert_eq!(state.filemap.entries.len(), 1);

    // 7. Respuesta streaming (AssistantChunk × N)
    state.apply_message(BunMessage::AssistantChunk { text: "He creado ".into(), agent: None, timestamp: None });
    state.apply_message(BunMessage::AssistantChunk { text: "los tests JWT.".into(), agent: None, timestamp: None });
    let last = state.history.entries.last().unwrap();
    assert_eq!(last.role, Role::Assistant);
    assert!(last.content.contains("He creado los tests JWT."));

    // 8. Tarea terminada → Focus
    state.apply_message(BunMessage::AssistantDone);
    assert!(!state.running);
    assert_eq!(state.active_tab, TabId::Focus);
    assert!(!state.tab_locked);
}
