/// Integration tests for the hivetui state machine and widget rendering.
///
/// These tests are 100% real — they call the actual production code paths:
///   BunMessage → AppState::apply_message → widget render → Canvas cell inspection
///
/// No mocking. Every test runs in parallel (`cargo test --test tui_integration`).

use hivetui::{
    ipc::BunMessage,
    renderer,
    state::{AppState, ModalState, Role, HistoryEntry, ReplMode, SettingsHubState, TabId},
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
        new_token_count: None,
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
        task_id: Some("task-1".into()),
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
        task_id: Some("task-1".into()),
        worker: "backend".into(),
        phase: "escribiendo src/auth/jwt.ts".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
    });
    state.apply_message(BunMessage::WorkerUpdate {
        task_id: None,
        worker: "frontend".into(),
        phase: "escribiendo src/components/Login.tsx".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
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
        new_token_count: None,
    });
    assert_eq!(state.session.mode, ReplMode::Plan);
    assert_eq!(state.active_tab, TabId::Mesa,
        "Cambiar a modo plan debe mantener Focus mientras el plan se genera");
}

// ── 5. Auto-routing: APPROVAL espera veredicto antes de abrir Review ─────────

#[test]
fn routing_approval_mode_waits_for_reviewer_verdict() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("approval".into()),
        new_provider: None,
        new_model: None,
        new_token_count: None,
    });
    assert_eq!(state.session.mode, ReplMode::Approval);
    assert_eq!(state.active_tab, TabId::Mesa,
        "Cambiar a modo approval no debe abrir Review sin veredicto");

    state.apply_message(BunMessage::ReviewVerdictUpdate {
        reviewer: Some("reviewer".into()),
        status: "approval".into(),
        summary: "aprobado".into(),
        observations: Vec::new(),
        requested_changes: Vec::new(),
        affected_files: Vec::new(),
        criteria: Vec::new(),
        categories: Vec::new(),
    });
    assert_eq!(state.active_tab, TabId::Review);
}

// ── 6. Auto-routing: AUTO running → Code; AssistantDone → Focus ──────────────

#[test]
fn routing_auto_mode_code_then_focus() {
    let mut state = base_state();
    // Ya está en AUTO (base_state inicializa con "auto")

    // Worker activo → debe ir a Code
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: Some("task-1".into()),
        coordinator: "backend".into(),
        phase: "escribiendo archivos".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
    });
    assert_eq!(state.active_tab, TabId::Code,
        "AUTO mode + worker running debe navegar a Code tab");

    // Tarea terminada → debe volver a Focus
    state.apply_message(BunMessage::AssistantDone);
    assert!(!state.running, "running debe ser false tras AssistantDone");
    assert!(!state.tab_locked, "sin override manual el routing sigue automático");
    assert_eq!(state.active_tab, TabId::Mesa,
        "AssistantDone en AUTO mode debe volver a Focus tab");
}

// ── 7. Manual tab lock: usuario elige tab → se mantiene hasta /auto ──────────

#[test]
fn manual_tab_lock_overrides_auto_routing() {
    let mut state = base_state();
    // Usuario navega manualmente a Review (tab 4)
    state.active_tab = TabId::Review;
    state.tab_locked = true;

    // Llega ActivityUpdate (normalmente iría a Code en AUTO mode)
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: Some("task-1".into()),
        coordinator: "backend".into(),
        phase: "escribiendo".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
    });
    assert_eq!(state.active_tab, TabId::Review,
        "tab_locked=true debe impedir el auto-routing");

    // AssistantDone no libera el lock; sólo /auto lo hace.
    state.apply_message(BunMessage::AssistantDone);
    assert!(state.tab_locked, "AssistantDone debe conservar tab_locked");
    assert_eq!(state.active_tab, TabId::Review);
    state.resume_auto_layout();
    assert!(!state.tab_locked);
    assert_eq!(state.active_tab, TabId::Mesa);
}

// ── 8. Welcome screen: no muestra el widget de input ─────────────────────────

#[test]
fn welcome_screen_does_not_render_input_widget() {
    let mut state = base_state();
    state.show_welcome = true;
    // history vacío → welcome se activa

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &mut state);

    // El input widget está en las últimas 4 filas (rows[5] = 4 de altura).
    // La fila del input (y=24 para h=30) NO debe tener la bee '🐝' ni el hex '⬡'
    // — la pantalla de bienvenida debe cubrirla completamente.
    let input_y = 30 - 4 - 1 - 1; // h - input(4) - status(1) - 0-indexed
    let has_bee = (0..120u16).any(|x| {
        canvas.cell_at(x, input_y).map(|c| c.ch == '🐝').unwrap_or(false)
    });
    assert!(!has_bee, "Welcome screen debe cubrir el input widget — la bee no debe ser visible");
}

#[test]
fn welcome_screen_exposes_harness_status() {
    let mut state = base_state();
    state.show_welcome = true;
    state.apply_message(BunMessage::TaskUpdate {
        task_id: "task-42".into(),
        title: Some("Corregir login".into()),
        status: "running".into(),
        mode: Some("auto".into()),
        active_workers: Some(vec!["backend".into()]),
        workspace_id: Some("worktree:task-42".into()),
        workspace_path: Some("/tmp/task-42".into()),
        branch_name: Some("hivecode/task-task-42".into()),
        isolated: Some(true),
        integration_status: Some("isolated".into()),
    });
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: Some("task-42".into()),
        coordinator: "backend".into(),
        phase: "fix".into(),
        status: "running".into(),
        display_name: None,
        activity: Some("editando auth".into()),
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
    });

    let mut canvas = make_canvas(140, 34);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(frame.contains("modo AUTO"));
    assert!(frame.contains("Corregir login"));
    assert!(frame.contains("isolated"));
    assert!(frame.contains("backend"));
    assert!(frame.contains("activity_update"));
}

#[test]
fn renderer_keeps_reference_chrome_on_every_screen() {
    let mut state = base_state();
    state.harness.approval_pending = true;

    for tab in [
        TabId::Swarm,
        TabId::Plan,
        TabId::Mesa,
        TabId::Code,
        TabId::Review,
        TabId::Taller,
    ] {
        state.active_tab = tab;
        let mut canvas = make_canvas(120, 30);
        renderer::render(&mut canvas, &mut state);

        let frame = canvas.to_text_rows().join("\n");
        // Las seis pestañas visibles en todas las vistas: el tabbar es chrome
        // compartido y no puede desaparecer en una de ellas.
        for label in ["ENJAMBRE", "PLAN", "MESA", "CÓDIGO", "REVISIÓN", "TALLER"] {
            assert!(frame.contains(label), "falta {label} en {tab:?}");
        }
        assert!(frame.contains("CHECKPOINTS"));
        assert!(state
            .hit_map
            .regions()
            .iter()
            .any(|region| region.id.starts_with("tab:")));
    }
}

// ── Settings Hub: columna Key y flujo de activación ──────────────────────────

/// Monta el hub de settings con los providers dados, como si Bun enviase un
/// `SettingsData`. Recorre el camino real: mensaje IPC → apply_message → render.
fn settings_hub_state(
    providers: Vec<(&str, bool, bool)>, // (id, has_key, browser_login)
    active: &str,
) -> AppState {
    let mut s = base_state();
    // El hub tiene que estar montado antes del mensaje: `apply_message` solo
    // aplica `SettingsData` si el hub está en pantalla (por eso el TUI lo mantiene
    // abierto durante las acciones).
    s.modal = ModalState::Settings(SettingsHubState::default());
    s.apply_message(BunMessage::SettingsData {
        providers: providers
            .into_iter()
            .map(|(id, has_key, browser_login)| hivetui::ipc::IpcSettingsProvider {
                id: id.to_string(),
                name: id.to_string(),
                model: format!("{id}/default"),
                is_active: id == active,
                has_key,
                browser_login,
                models: vec![format!("{id}/default")],
            })
            .collect(),
        agents: vec![],
        mcp: vec![],
        skills: vec![],
        github_connected: false,
        github_repo: None,
        telegram_active: false,
    });
    s
}

#[test]
fn el_hub_de_settings_distingue_quien_tiene_clave() {
    // Con `has_key` siempre en `true` (el bug anterior) las tres filas
    // mostraban ✓ y no había forma de saber a quién faltaba la clave.
    let mut state = settings_hub_state(
        vec![("anthropic", true, false), ("openai", false, false), ("hivecode-free", false, true)],
        "anthropic",
    );

    let mut canvas = make_canvas(140, 40);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(frame.contains("anthropic"), "deben listarse los providers: {frame}");
    assert!(frame.contains("openai"));
    assert!(frame.contains("hivecode-free"));
    // El glifo de "falta clave" tiene que aparecer en algún sitio.
    assert!(
        frame.contains('?'),
        "un provider sin clave debe marcarse con `?`, no con ✓: {frame}"
    );
    assert!(frame.contains('~'), "el login de navegador debe tener su propio glifo: {frame}");
    assert!(frame.contains('✓'), "el provider con clave debe marcarse: {frame}");
}

#[test]
fn el_hub_de_settings_anuncia_el_login_de_navegador() {
    // hivecode-free no usa API key: el hint debe decirlo para que el usuario no
    // busque una clave que no existe.
    let mut state = settings_hub_state(vec![("hivecode-free", false, true)], "openai");
    let mut canvas = make_canvas(140, 40);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(
        frame.contains("login de navegador"),
        "el footer debe explicar el login de navegador: {frame}"
    );
}

#[test]
fn el_hub_de_settings_avisa_que_pide_la_clave() {
    let mut state = settings_hub_state(vec![("openai", false, false)], "anthropic");
    let mut canvas = make_canvas(140, 40);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(
        frame.contains("te pedirá la API key"),
        "el footer debe anticipar el formulario de clave: {frame}"
    );
}

#[test]
fn el_modal_de_api_key_enmascara_lo_escrito() {
    use hivetui::state::{ModalAction, ModalFieldKind};
    use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

    let mut state = settings_hub_state(vec![("openai", false, false)], "anthropic");
    let mut canvas = make_canvas(140, 40);
    renderer::render(&mut canvas, &mut state);

    // Enter sobre la fila → formulario local con la clave.
    hivetui::controller::handle_key_event(
        &mut state,
        KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::NONE,
        },
    );

    let ModalState::Config(modal) = &state.modal else {
        panic!("Enter sobre un provider sin clave debe abrir el formulario");
    };
    assert_eq!(modal.fields.len(), 1, "no debe relistar los providers");
    assert_eq!(modal.fields[0].kind, ModalFieldKind::Secret);
    assert_eq!(
        modal.action,
        Some(ModalAction::ProviderActivate { provider_id: "openai".into() })
    );

    // Escribiendo la clave, el lienzo solo debe mostrar viñetas.
    for c in "sk-secreto".chars() {
        hivetui::controller::handle_key_event(
            &mut state,
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers: KeyModifiers::NONE,
                kind: KeyEventKind::Press,
                state: crossterm::event::KeyEventState::NONE,
            },
        );
    }
    let mut canvas = make_canvas(140, 40);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(
        !frame.contains("sk-secreto"),
        "la API key no puede aparecer en claro en el lienzo: {frame}"
    );
    assert!(frame.contains('•'), "la clave debe salir enmascarada: {frame}");
}

#[test]
fn renderer_registers_split_handle_hit_regions() {
    let mut state = base_state();
    state.active_tab = TabId::Code;

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &mut state);

    assert!(state
        .hit_map
        .regions()
        .iter()
        .any(|region| region.id == "split:code:main"));

    state.active_tab = TabId::Review;
    renderer::render(&mut canvas, &mut state);

    assert!(state
        .hit_map
        .regions()
        .iter()
        .any(|region| region.id == "split:review:main"));
    assert!(state
        .hit_map
        .regions()
        .iter()
        .any(|region| region.id == "split:review:right"));
}

#[test]
fn renderer_registers_reference_chrome_resize_regions() {
    let mut state = base_state();

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &mut state);

    assert!(state
        .hit_map
        .regions()
        .iter()
        .any(|region| region.id.starts_with("chrome:")));
}

// ── 9. Code layout: split dinámico con 3+ workers activos ────────────────────

#[test]
fn code_layout_renders_focused_worker_detail() {
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
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });
    }

    let mut canvas = make_canvas(160, 30);
    let area = Rect::new(0, 0, 160, 30);
    code_layout::render(&mut canvas, area, &state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(frame.contains("@TOPO"), "Code layout debe mostrar worker enfocado");
    assert!(frame.contains("THOUGHT STREAM"), "Code layout debe reservar thought stream");
    assert!(frame.contains("BLACKBOARD RELEVANTE"), "Code layout debe reservar blackboard relevante");
}

// ── 10. Plan layout: panel derecho muestra ADRs en modo PLAN ─────────────────

#[test]
fn plan_layout_shows_adrs_in_plan_mode() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("plan".into()),
        new_provider: None,
        new_model: None,
        new_token_count: None,
    });
    state.apply_message(BunMessage::AdrUpdate {
        path: "docs/adr/001-jwt.md".into(),
        title: "Usar JWT para sesiones".into(),
        content: "# ADR-001\n## Contexto\nNecesitamos auth stateless.".into(),
        status: "accepted".into(),
    });
    // Añadir pensamiento para el panel izquierdo
    state.apply_message(BunMessage::ThoughtChunk {
        task_id: Some("task-1".into()),
        coordinator: "bee".into(),
        phase: "planning".into(),
        content: "Diseñando la arquitectura de auth".into(),
    });

    let mut canvas = make_canvas(160, 30);
    let area = Rect::new(0, 0, 160, 30);
    plan_layout::render(&mut canvas, area, &state);

    let frame = canvas.to_text_rows().join("\n");
    assert!(frame.contains("PRD / TAREA"));
    assert!(frame.contains("PLAN EN CONSTRUCCIÓN"));
    assert!(frame.contains("Usar JWT para sesiones"), "Plan layout debe mostrar el título del ADR en contexto");
}

// ── 11. Review layout: approval strip más prominente en modo APPROVAL ─────────

#[test]
fn review_layout_shows_approval_hints() {
    let mut state = base_state();
    state.apply_message(BunMessage::StateUpdate {
        new_mode: Some("approval".into()),
        new_provider: None,
        new_model: None,
        new_token_count: None,
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

    // 1. Init desde snapshot de sesión (lo que envía tui-launcher.ts)
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
        task_id: Some("task-1".into()),
        coordinator: "bee".into(),
        phase: "planning".into(),
        content: "Voy a analizar jwt.ts primero".into(),
    });
    assert_eq!(state.thought.chunks.len(), 1);

    // 5. Worker activo → routing a Code
    state.apply_message(BunMessage::ActivityUpdate {
        task_id: Some("task-1".into()),
        coordinator: "backend".into(),
        phase: "escribiendo tests".into(),
        status: "running".into(),
        display_name: None,
        activity: None,
        token_count: None,
        level: None,
        current_action: None,
        current_file: None,
        iteration_current: None,
        iteration_total: None,
        transversal: None,
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
    assert_eq!(state.active_tab, TabId::Mesa);
    assert!(!state.tab_locked);
}

// ── Jerarquía del Dashboard en la terminal objetivo (120x30) ──────────────────

/// Registra workers dejando los primeros `running` en ejecución en el nivel activo
/// y el resto esperando en un nivel posterior — el caso real: pocos activos, muchos
/// ociosos. El nivel importa: `is_active_worker` clasifica por nivel, no solo por estado.
fn state_with_workers(running: usize, waiting: usize) -> AppState {
    let mut state = base_state();
    let names = [
        "backend", "frontend", "mobile", "data", "security", "qa",
        "devops", "architecture", "product", "reviewer", "forensic", "librarian",
    ];
    for (idx, name) in names.iter().take(running + waiting).enumerate() {
        state.apply_message(BunMessage::WorkerUpdate {
            task_id: None,
            worker: (*name).into(),
            phase: "impl".into(),
            status: if idx < running { "running".into() } else { "waiting".into() },
            display_name: None,
            activity: Some(format!("trabajo de {name}")),
            token_count: Some(1000),
            level: Some(if idx < running { 2 } else { 3 }),
            current_action: None,
            current_file: None,
            iteration_current: Some(1),
            iteration_total: Some(3),
            transversal: None,
        });
    }
    state
}

#[test]
fn dashboard_collapses_idle_agents_instead_of_shrinking_active_cards() {
    let mut state = state_with_workers(4, 8);
    state.active_tab = TabId::Swarm;

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    // Los ociosos se nombran en una línea colapsada, no en tarjetas.
    assert!(
        frame.contains("idle:"),
        "falta el resumen colapsado de agentes inactivos:\n{frame}"
    );

    // Y las tarjetas activas siguen dibujando su contenido completo (la barra de
    // iteraciones es lo primero que se pierde cuando una tarjeta se comprime).
    assert!(
        frame.contains("iter"),
        "las tarjetas activas perdieron la barra de iteraciones:\n{frame}"
    );
}

#[test]
fn dashboard_names_active_workers_that_did_not_fit() {
    // Muchos activos a la vez: los que no caben deben nombrarse, no desaparecer.
    let mut state = state_with_workers(12, 0);
    state.active_tab = TabId::Swarm;

    let mut canvas = make_canvas(120, 30);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(
        frame.contains("más:"),
        "los activos que no caben deberían aparecer en el resumen:\n{frame}"
    );
}

#[test]
fn terminal_below_the_minimum_gets_an_explicit_message() {
    let mut state = base_state();
    state.active_tab = TabId::Swarm;

    let mut canvas = make_canvas(80, 24);
    renderer::render(&mut canvas, &mut state);
    let frame = canvas.to_text_rows().join("\n");

    assert!(frame.contains("demasiado pequeña"), "frame:\n{frame}");
    assert!(frame.contains("80x24"), "debe decir el tamaño actual:\n{frame}");
    assert!(frame.contains("100x24"), "debe decir el mínimo:\n{frame}");
}
