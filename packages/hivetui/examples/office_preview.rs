//! Export an illustrative scene using the production renderer:
//! cargo run --example office_preview > /tmp/hivecode-office.svg
use hivetui::{
    ipc::BunMessage,
    renderer,
    state::{AppState, BeeState, TabId, Worker, WorkerStatus},
    term::{Canvas, Color},
    widgets::office,
};

fn rgb(color: Color, fallback: &str) -> String {
    match color {
        Color::Rgb { r, g, b } => format!("#{r:02x}{g:02x}{b:02x}"),
        _ => fallback.to_string(),
    }
}

fn main() {
    let mut state = AppState::default();
    state.show_welcome = false;
    state.active_tab = TabId::Swarm;
    state.tab_locked = true;
    state.session.project_name = "Colmena · vista de diseño".into();
    let full_cast = std::env::var("HIVE_OFFICE_PREVIEW_FULL").is_ok();
    let roles: &[&str] = if full_cast {
        &[
            "bee",
            "architecture",
            "backend",
            "frontend",
            "data_scientist",
            "security",
            "test",
            "devops",
            "quality",
            "forensic",
            "librarian",
            "spider",
        ]
    } else {
        &["bee", "planner", "scout", "builder", "verifier", "spider"]
    };
    for &role in roles {
        let mut worker = Worker::new(role);
        worker.status = WorkerStatus::Waiting;
        worker.current_action = Some("Preparando el siguiente paso del proyecto".into());
        state.workers.workers.push(worker);
    }
    let calls = if full_cast {
        vec![
            ("bee", "plan", BeeState::Thinking),
            ("backend", "fs_write", BeeState::Writing),
            ("frontend", "fs_write", BeeState::Writing),
            ("test", "code_test", BeeState::Executing),
            ("librarian", "fs_read", BeeState::Reading),
        ]
    } else {
        vec![
            ("bee", "task_delegate", BeeState::Executing),
            ("builder", "fs_write", BeeState::Writing),
            ("verifier", "code_test", BeeState::Executing),
            ("scout", "fs_read", BeeState::Reading),
            ("spider", "web_search", BeeState::Searching),
        ]
    };
    for (role, tool, activity) in calls
        .into_iter()
        .filter(|_| std::env::var("HIVE_OFFICE_PREVIEW_IDLE").is_err())
    {
        state
            .workers
            .workers
            .iter_mut()
            .find(|worker| worker.name == role)
            .unwrap()
            .status = WorkerStatus::Running;
        let at = chrono::Utc::now().timestamp_millis() as u64;
        state.apply_message(BunMessage::ToolCall {
            call_id: role.into(),
            agent: role.into(),
            tool: tool.into(),
            args_summary: "src/auth.ts".into(),
            bee_state: match activity {
                BeeState::Writing => "writing",
                BeeState::Reading => "reading",
                BeeState::Executing => "executing",
                BeeState::Searching => "searching",
                _ => "thinking",
            }
            .into(),
            task_id: None,
            at: at.saturating_sub(3200),
        });
        if role != "bee" {
            state.apply_message(BunMessage::SwarmCollaboration {
                event_id: role.into(),
                delegation_id: role.into(),
                task_id: None,
                session_id: None,
                from: "bee".into(),
                to: role.into(),
                kind: "delegation".into(),
                summary: "Implementar autenticación".into(),
                at,
            });
        }
    }
    if std::env::var("HIVE_COLONY_PREVIEW_MIXED").is_ok() && !full_cast {
        let at = chrono::Utc::now().timestamp_millis() as u64;
        for (agent, tool) in [("spider", "web_search"), ("verifier", "code_test")] {
            state.apply_message(BunMessage::ToolDone {
                agent: agent.into(),
                tool: tool.into(),
                call_id: agent.into(),
                ok: true,
                duration_ms: 3200,
                result_summary: "Comprobación completada".into(),
                task_id: None,
                at,
            });
        }
        state.apply_message(BunMessage::ThoughtChunk {
            task_id: None,
            coordinator: "planner".into(),
            phase: "thinking".into(),
            content: "Reviso las dependencias antes de distribuir el trabajo.".into(),
        });
        state.apply_message(BunMessage::NarrativeChunk {
            task_id: None,
            coordinator: "spider".into(),
            phase: "narrative".into(),
            content: "Encontré las referencias; preparo la entrega.".into(),
            content_type: None,
            stream_id: None,
            replay: false,
        });
        state.apply_message(BunMessage::Esperando {
            task_id: None,
            agent: "verifier".into(),
            esperando_a: vec!["builder".into()],
            razon: "dependencia".into(),
            at,
        });
    }
    state.anim_tick = std::env::var("HIVE_COLONY_PREVIEW_FRAME")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if let Ok(agent) = std::env::var("HIVE_COLONY_PREVIEW_AGENT") {
        office::select(&mut state, agent);
    }
    let cols = std::env::var("HIVE_COLONY_PREVIEW_COLS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(160);
    let rows = std::env::var("HIVE_COLONY_PREVIEW_ROWS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(40);
    let mut canvas = Canvas::new(cols, rows);
    renderer::render(&mut canvas, &mut state);
    let (cw, ch) = (8, 16);
    let (width, height) = (canvas.w as usize * cw, canvas.h as usize * ch);
    println!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="#0d0b07"/><g font-family="DejaVu Sans Mono,monospace" font-size="13">"##
    );
    for y in 0..canvas.h {
        for x in 0..canvas.w {
            let cell = canvas.cell_at(x, y).unwrap();
            let bg = rgb(cell.style.bg, "#0d0b07");
            let fg = rgb(cell.style.fg, "#e8dcc8");
            let (px, py) = (x as usize * cw, y as usize * ch);
            println!(r#"<rect x="{px}" y="{py}" width="{cw}" height="{ch}" fill="{bg}"/>"#);
            if matches!(cell.ch, '▀' | '▄' | '█') {
                let sy = py + if cell.ch == '▄' { ch / 2 } else { 0 };
                let height = if cell.ch == '█' { ch } else { ch / 2 };
                println!(r#"<rect x="{px}" y="{sy}" width="{cw}" height="{height}" fill="{fg}"/>"#);
            } else if cell.ch != ' ' && cell.ch != '\0' {
                let glyph = cell
                    .ch
                    .to_string()
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                println!(
                    r#"<text x="{px}" y="{}" fill="{fg}">{glyph}</text>"#,
                    py + 13
                );
            }
        }
    }
    println!("</g></svg>");
}
