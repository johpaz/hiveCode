use crate::{
    state::{AppState, ReplMode, TabId},
    term::{
        Canvas, Color, Rect, Style, AMBER_BRIGHT, BG_CONFLICT, BG_PANEL, BLUE, GREEN, RED,
        SECONDARY, YELLOW,
    },
    ui::{cell_width, fmt_tokens, truncate_cells},
    widgets::checkpoint_bar,
};

pub fn render_header(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let left = format!("⬡ hiveCode · {}", state.session.project_name);
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(&left, area.w.saturating_sub(3) as usize),
        Style::new().fg(AMBER_BRIGHT).bold().bg(BG_PANEL),
    );

    let mode = if state.dashboard.halt.active {
        "HALT".to_string()
    } else if state.tab_locked {
        format!("{} ✎", state.session.mode.label())
    } else {
        state.session.mode.label().to_string()
    };
    let mode_color = if state.dashboard.halt.active {
        RED
    } else {
        mode_color(state.session.mode)
    };
    let mode_x = area.x + area.w.saturating_sub(cell_width(&mode) as u16) / 2;
    canvas.print(mode_x, area.y, &mode, Style::new().fg(mode_color).bold().bg(BG_PANEL));

    let elapsed = state
        .dashboard
        .metrics
        .elapsed_secs
        .map(format_elapsed)
        .unwrap_or_else(|| {
            if state.clock.is_empty() {
                "--:--".to_string()
            } else {
                state.clock.clone()
            }
        });
    let cost = if state.cost.is_empty() { "$0.00" } else { state.cost.as_str() };
    let right = format!("tok {}  {cost}  {elapsed}", fmt_tokens(state.session.token_count));
    let right_x = area.right().saturating_sub(cell_width(&right) as u16 + 1);
    if right_x > area.x + 1 {
        canvas.print(right_x, area.y, &right, Style::new().fg(SECONDARY).bg(BG_PANEL));
    }
}

pub fn render_footer(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    checkpoint_bar::render(canvas, Rect::new(area.x, area.y, area.w, 1), state);
    if area.h > 1 {
        render_control_line(canvas, Rect::new(area.x, area.y + 1, area.w, 1), state);
    }
}

fn render_control_line(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if let Some(confirm) = &state.dashboard.rollback_confirm_checkpoint {
        let msg = format!("CONFIRMAR ROLLBACK {confirm} · Enter confirma · Esc cancela");
        canvas.fill_rect(area, ' ', Style::new().bg(BG_CONFLICT));
        canvas.print(
            area.x + 1,
            area.y,
            &truncate_cells(&msg, area.w.saturating_sub(2) as usize),
            Style::new().fg(RED).bold().bg(BG_CONFLICT),
        );
        return;
    }

    if let Some(conflict) = state.conflicts.entries.first() {
        let msg = format!(
            "[CONFLICT] {} ↔ {} · {} · {}",
            conflict.agent_a, conflict.agent_b, conflict.path, conflict.reason
        );
        canvas.fill_rect(area, ' ', Style::new().bg(BG_CONFLICT));
        canvas.print(
            area.x + 1,
            area.y,
            &truncate_cells(&msg, area.w.saturating_sub(2) as usize),
            Style::new().fg(RED).bold().bg(BG_CONFLICT),
        );
        return;
    }

    let controls = if state.dashboard.halt.active {
        "HALT activo · selecciona checkpoint con ←/→ · Enter rollback"
    } else {
        match state.active_tab {
            TabId::Focus => match state.session.mode {
                ReplMode::Auto => "Focus · escribe tarea o /comando · Shift+Tab approval · ←/→ checkpoint",
                ReplMode::Approval => "Focus · /approve /reject /rollback · ←/→ checkpoint",
                ReplMode::Plan => "Focus · /think /auto · Enter envía · ←/→ checkpoint",
            },
            TabId::Plan => "Plan · Enter ejecutar · m modificar · n regenerar/cancelar · ←/→ checkpoint",
            TabId::Code => "Code · worker enfocado · a aprobar worker · r rehacer · ←/→ checkpoint",
            TabId::Review => match state.session.mode {
                ReplMode::Auto => "Review · decisión automática de Bee en curso · ←/→ checkpoint",
                ReplMode::Approval => "Review · a confirmar · r rechazar · m resolver observaciones · ←/→ checkpoint",
                ReplMode::Plan => "Review · veredicto preparado · ←/→ checkpoint",
            },
            TabId::Dashboard => "",
        }
    };
    let style = if state.dashboard.halt.active {
        Style::new().fg(RED).bold().bg(BG_PANEL)
    } else {
        Style::new().fg(SECONDARY).bg(BG_PANEL)
    };
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(controls, area.w.saturating_sub(2) as usize),
        style,
    );
}

fn mode_color(mode: ReplMode) -> Color {
    match mode {
        ReplMode::Auto => GREEN,
        ReplMode::Approval => YELLOW,
        ReplMode::Plan => BLUE,
    }
}

fn format_elapsed(seconds: u64) -> String {
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}
