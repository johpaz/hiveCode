use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, SECONDARY},
};

pub struct Command {
    pub cmd: &'static str,
    pub desc: &'static str,
}

pub const COMMANDS: &[Command] = &[
    Command { cmd: "/help",        desc: "Mostrar atajos de teclado" },
    Command { cmd: "/exit",        desc: "Salir de hivecode" },
    Command { cmd: "/compact",     desc: "Compactar contexto de la sesión" },
    Command { cmd: "/stop",        desc: "Detener tarea en curso" },
    Command { cmd: "/session new", desc: "Iniciar nueva sesión" },
    Command { cmd: "/doctor",      desc: "Diagnóstico del sistema" },
    Command { cmd: "/version",     desc: "Versión de hivecode" },
];

/// Devuelve los comandos que coinciden con el prefijo actual del input.
pub fn filtered(input: &str) -> Vec<&'static Command> {
    let prefix = input.trim();
    COMMANDS
        .iter()
        .filter(|c| c.cmd.starts_with(prefix))
        .collect()
}

/// Renderiza el popup flotante sobre el área de input.
/// `popup_area` se calcula en el renderer como la zona justo encima del input.
pub fn render(canvas: &mut Canvas, popup_area: Rect, state: &AppState) {
    let input = state.input.value();
    if !input.starts_with('/') {
        return;
    }

    let items = filtered(input);
    if items.is_empty() {
        return;
    }

    // Calcular altura necesaria: borde + items
    let needed_h = (items.len() as u16 + 2).min(popup_area.h);
    let y_start = popup_area.bottom().saturating_sub(needed_h);

    let area = Rect {
        x: popup_area.x,
        y: y_start,
        w: popup_area.w,
        h: needed_h,
    };

    // Fondo del popup
    canvas.fill_rect(area, ' ', Style::new().fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print(area.x + 2, area.y, " comandos ", Style::new().fg(CYAN).bold());

    for (i, cmd) in items.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() {
            break;
        }
        let selected = state.command_popup_selected == i;
        let row_style = if selected {
            Style::new().fg(AMBER).bold()
        } else {
            Style::new().fg(SECONDARY)
        };
        let prefix = if selected { "▸ " } else { "  " };
        canvas.print(area.x + 1, y, prefix, row_style);
        canvas.print(area.x + 3, y, cmd.cmd, if selected { Style::new().fg(AMBER).bold() } else { Style::new().fg(GREEN) });

        let desc_x = area.x + 3 + cmd.cmd.len() as u16 + 2;
        if desc_x < area.right().saturating_sub(1) {
            canvas.print(desc_x, y, cmd.desc, Style::new().fg(DIM));
        }
    }
}
