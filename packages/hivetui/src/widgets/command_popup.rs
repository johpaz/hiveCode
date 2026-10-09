use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, SECONDARY, BG_ELEVATED},
    ui::{HitAction, MouseRegion},
};

pub struct Command {
    pub cmd: &'static str,
    pub desc: &'static str,
}

pub const COMMANDS: &[Command] = &[
    Command { cmd: "/help",            desc: "Mostrar atajos de teclado" },
    Command { cmd: "/exit",            desc: "Salir de hivecode" },
    Command { cmd: "/compact",         desc: "Compactar contexto de la sesión" },
    Command { cmd: "/stop",            desc: "Detener tarea en curso" },
    Command { cmd: "/session",         desc: "Gestionar sesiones" },
    Command { cmd: "/session list",    desc: "Ver sesiones recientes" },
    Command { cmd: "/session resume",  desc: "Reanudar sesión por id" },
    Command { cmd: "/session new",     desc: "Cerrar la sesión actual y empezar una nueva" },
    Command { cmd: "/session status",  desc: "Ver sesión activa" },
    Command { cmd: "/doctor",          desc: "Diagnóstico del sistema" },
    Command { cmd: "/version",         desc: "Versión de hivecode" },
];

pub struct PopupCommand<'a> {
    pub cmd: &'a str,
    pub desc: &'a str,
}

/// Local TUI actions plus the backend's complete command catalog.
pub fn filtered(state: &AppState) -> Vec<PopupCommand<'_>> {
    let prefix = state.input.value().trim();
    let mut commands = Vec::new();
    for command in COMMANDS.iter().filter(|_| state.command_menu.is_empty()) {
        if command.cmd.starts_with(prefix) {
            commands.push(PopupCommand { cmd: command.cmd, desc: command.desc });
        }
    }
    for command in &state.command_menu {
        if command.cmd.starts_with(prefix) && !commands.iter().any(|item| item.cmd == command.cmd) {
            commands.push(PopupCommand { cmd: &command.cmd, desc: &command.desc });
        }
    }
    commands
}

/// Visible in every layout, scrolls with selection, and leaves input uncovered.
pub fn render(canvas: &mut Canvas, popup_area: Rect, state: &mut AppState) {
    if !state.input.value().starts_with('/') || popup_area.h < 3 { return; }
    let items = filtered(state);
    if items.is_empty() { return; }
    let needed_h = (items.len() as u16 + 2).min(popup_area.h);
    let area = Rect { x: popup_area.x, y: popup_area.bottom().saturating_sub(needed_h), w: popup_area.w, h: needed_h };
    let visible = area.h.saturating_sub(2) as usize;
    let selected = state.command_popup_selected.min(items.len().saturating_sub(1));
    let offset = selected.saturating_sub(visible.saturating_sub(1));
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED).fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print(area.x + 2, area.y, " comandos · ↑↓ elegir · Tab completar · Enter ejecutar ", Style::new().fg(CYAN).bold());
    let mut hits = Vec::new();
    for (i, cmd) in items.iter().enumerate().skip(offset).take(visible) {
        let y = area.y + 1 + (i - offset) as u16;
        let selected = selected == i;
        let style = if selected { Style::new().fg(AMBER).bold() } else { Style::new().fg(SECONDARY) };
        canvas.print(area.x + 1, y, if selected { "▸ " } else { "  " }, style);
        canvas.print(area.x + 3, y, cmd.cmd, if selected { style } else { Style::new().fg(GREEN) });
        let desc_x = area.x + 3 + cmd.cmd.len() as u16 + 2;
        if desc_x < area.right().saturating_sub(1) { canvas.print(desc_x, y, cmd.desc, Style::new().fg(DIM)); }
        hits.push(MouseRegion::new(format!("command:{i}"),
            Rect { x: area.x + 1, y, w: area.w.saturating_sub(2), h: 1 }, 40,
            HitAction::Command(cmd.cmd.to_string())));
    }
    for hit in hits { state.hit_map.push(hit); }
}
