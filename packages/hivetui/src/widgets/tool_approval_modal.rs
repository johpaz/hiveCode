use crate::{
    state::{AppState, ModalState},
    term::{Canvas, Rect, Style, AMBER, BG_ELEVATED, DIM, GREEN, RED, SECONDARY, WHITE},
    ui::text::{wrap_cells, Overflow},
};

/// Líneas del modal que no son detalle: título, cabecera, separador, pista.
const CHROME_ROWS: u16 = 7;

/// Divide el detalle de los argumentos en las líneas que caben en el modal.
pub fn detail_lines(detail: &str, width: usize) -> Vec<String> {
    detail
        .lines()
        .flat_map(|line| wrap_cells(line, width, Overflow::Wrap))
        .collect()
}

pub fn render(canvas: &mut Canvas, full_area: Rect, state: &AppState) {
    let ModalState::ToolApproval(modal) = &state.modal else {
        return;
    };

    let modal_w = (full_area.w.saturating_sub(8)).min(88).max(50);
    let inner_w = modal_w.saturating_sub(4) as usize;
    let lines = detail_lines(if modal.detail.is_empty() { &modal.summary } else { &modal.detail }, inner_w);
    // Se ajusta al contenido; sólo se desplaza cuando no cabe.
    // Una puerta del harness trae un plan entero: puede usar casi toda la pantalla.
    let cap = if modal.is_gate() { u16::MAX } else { 22 };
    let max_h = (full_area.h.saturating_sub(4)).min(cap).max(CHROME_ROWS + 3);
    let modal_h = (CHROME_ROWS + lines.len() as u16).clamp(CHROME_ROWS + 1, max_h);
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;
    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.draw_border(area, Style::new().fg(AMBER));
    let title = if modal.title.is_empty() { "AUTORIZAR HERRAMIENTA" } else { modal.title.as_str() };
    canvas.print_centered(area.x, area.y, area.w, &format!(" ⬡ {title} "), Style::new().fg(AMBER).bold());

    canvas.print(area.x + 2, area.y + 2, &modal.agent, Style::new().fg(SECONDARY));
    let agent_w = modal.agent.chars().count() as u16;
    let verb = if modal.is_gate() { "propone" } else { "quiere ejecutar" };
    let verb_w = verb.chars().count() as u16;
    canvas.print(area.x + 3 + agent_w, area.y + 2, verb, Style::new().fg(DIM));
    canvas.print(
        area.x + 4 + agent_w + verb_w,
        area.y + 2,
        &modal.tool,
        Style::new().fg(WHITE).bold(),
    );

    let visible = (modal_h - CHROME_ROWS) as usize;
    let max_scroll = lines.len().saturating_sub(visible);
    let scroll = modal.scroll.min(max_scroll);
    for (i, line) in lines.iter().skip(scroll).take(visible).enumerate() {
        canvas.print(area.x + 2, area.y + 4 + i as u16, line, Style::new().fg(SECONDARY));
    }
    if lines.len() > visible {
        let marker = format!("{}/{}", scroll + 1, max_scroll + 1);
        canvas.print(area.right().saturating_sub(marker.len() as u16 + 2), area.y + 3, &marker, Style::new().fg(DIM));
    }

    let hint_y = area.bottom().saturating_sub(1);
    let (yes, no) = if modal.is_gate() {
        ("↩/y aprobar", "Esc/n cancelar")
    } else {
        ("↩/y autorizar", "Esc/n rechazar")
    };
    let yes_w = yes.chars().count() as u16;
    let no_w = no.chars().count() as u16;
    canvas.print(area.x + 2, hint_y, yes, Style::new().fg(GREEN));
    canvas.print(area.x + 3 + yes_w, hint_y, "·", Style::new().fg(DIM));
    canvas.print(area.x + 5 + yes_w, hint_y, no, Style::new().fg(RED));
    if lines.len() > visible {
        canvas.print(area.x + 6 + yes_w + no_w, hint_y, "·", Style::new().fg(DIM));
        canvas.print(area.x + 8 + yes_w + no_w, hint_y, "↑↓/PgUp/PgDn desplazar", Style::new().fg(DIM));
    }
}
