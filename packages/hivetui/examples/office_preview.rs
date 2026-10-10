//! Export an illustrative scene using the production renderer:
//! cargo run --example office_preview > /tmp/hivecode-office.svg
use hivetui::{
    renderer,
    state::{AppState, BeeState, TabId, ToolCall, Worker, WorkerStatus},
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
        &[
            "BEE",
            "Builder",
            "Planner",
            "Quality Gate",
            "Scout",
            "Spider",
        ]
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
            ("BEE", "plan", BeeState::Thinking),
            ("Builder", "fs_write", BeeState::Writing),
            ("Quality Gate", "code_test", BeeState::Executing),
            ("Scout", "fs_read", BeeState::Reading),
            ("Spider", "web_search", BeeState::Searching),
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
        state.swarm.start_call(ToolCall {
            call_id: role.into(),
            agent: role.into(),
            tool: tool.into(),
            args_summary: String::new(),
            bee_state: activity,
            started_at: 1,
            settled: false,
            ok: None,
            duration_ms: None,
        });
    }
    let mut canvas = Canvas::new(160, 40);
    renderer::render(&mut canvas, &mut state);
    let ticks = std::env::var("HIVE_OFFICE_PREVIEW_TICKS")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(180);
    for frame in 0..ticks {
        state.anim_tick = (frame % 8) as u8;
        office::tick(&mut state);
    }
    renderer::render(&mut canvas, &mut state);
    let (cw, ch) = (8, 16);
    println!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640"><rect width="100%" height="100%" fill="#0d0b07"/><g font-family="DejaVu Sans Mono,monospace" font-size="13">"##
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
