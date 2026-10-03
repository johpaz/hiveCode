use crate::{
    state::{AppState, LogEntry},
    term::{
        Canvas, Rect, Style, AMBER, AMBER_DIM, AMBER_SUBTLE, BG_PANEL, DIM, GREEN, RED, SECONDARY,
        YELLOW,
    },
    ui::text::ellipsize_cells,
};

/// Ancho de la columna de nivel. Deja el mensaje con el resto del panel.
const LEVEL_W: usize = 5;
const TIME_W: usize = 8;
const SOURCE_W: usize = 10;

/// `/logs` — las entradas que el backend mandó por `log_entry` y que hasta ahora
/// se acumulaban sin que ningún widget las leyera.
pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let y = area.y;
    let mut x = area.x + 1;

    canvas.print(x, y, "⬡ LOGS", Style::new().fg(AMBER).bold().bg(BG_PANEL));
    x += 7;

    let count = state.logs.entries.len();
    let badge = format!("{}/{}", count, state.logs.capacity);
    canvas.print(x, y, &badge, Style::new().fg(AMBER_DIM).bg(BG_PANEL));

    if area.h <= 1 {
        return;
    }

    if count == 0 {
        let msg = "sin entradas todavía — esperando activity del enjambre";
        let msg = ellipsize_cells(msg, area.w.saturating_sub(2) as usize);
        canvas.print(area.x + 1, area.y + 1, &msg, Style::new().fg(DIM));
        return;
    }

    // Cabecera de columnas: fija, para que las columnas no se re-alignen en cada scroll.
    let header_y = area.y + 1;
    canvas.fill_rect(
        Rect::new(area.x, header_y, area.w, 1),
        ' ',
        Style::new().bg(AMBER_SUBTLE),
    );
    canvas.print(
        area.x + 1,
        header_y,
        &format!("{:<TIME_W$}", "hora"),
        Style::new().fg(AMBER_DIM).bold().bg(AMBER_SUBTLE),
    );
    canvas.print(
        area.x + 1 + TIME_W as u16 + 1,
        header_y,
        &format!("{:<LEVEL_W$}", "nivel"),
        Style::new().fg(AMBER_DIM).bold().bg(AMBER_SUBTLE),
    );
    canvas.print(
        area.x + 1 + (TIME_W + LEVEL_W) as u16 + 2,
        header_y,
        &format!("{:<SOURCE_W$}", "origen"),
        Style::new().fg(AMBER_DIM).bold().bg(AMBER_SUBTLE),
    );
    canvas.print(
        area.x + 1 + (TIME_W + LEVEL_W + SOURCE_W) as u16 + 3,
        header_y,
        "mensaje",
        Style::new().fg(AMBER_DIM).bold().bg(AMBER_SUBTLE),
    );

    // Las más recientes al final: el dato interesante de un log es el final.
    let body_y = area.y + 2;
    let rows = area.h.saturating_sub(2) as usize;
    let start = count.saturating_sub(rows);
    for (i, entry) in state.logs.entries.iter().skip(start).enumerate() {
        render_row(
            canvas,
            Rect::new(area.x, body_y + i as u16, area.w, 1),
            entry,
            area.w,
        );
    }
}

fn render_row(canvas: &mut Canvas, row: Rect, entry: &LogEntry, width: u16) {
    let bg = Style::new().bg(BG_PANEL);
    let level_style = Style::new().fg(level_color(&entry.level)).bold().bg(BG_PANEL);
    let time_style = Style::new().fg(SECONDARY).bg(BG_PANEL);
    let source_style = Style::new().fg(AMBER_DIM).bg(BG_PANEL);

    let time = short_time(&entry.timestamp);
    canvas.print(row.x + 1, row.y, &format!("{time:<TIME_W$}"), time_style);
    canvas.print(
        row.x + 1 + TIME_W as u16 + 1,
        row.y,
        &format!("{:<LEVEL_W$}", short_level(&entry.level)),
        level_style,
    );
    canvas.print(
        row.x + 1 + (TIME_W + LEVEL_W) as u16 + 2,
        row.y,
        &format!("{:<SOURCE_W$}", entry.source),
        source_style,
    );

    let msg_x = row.x + 1 + (TIME_W + LEVEL_W + SOURCE_W) as u16 + 3;
    let avail = (width as usize).saturating_sub((msg_x - row.x) as usize + 1);
    canvas.print(
        msg_x,
        row.y,
        &ellipsize_cells(&entry.message, avail),
        Style::new().fg(SECONDARY).bg(BG_PANEL),
    );
    let _ = bg;
}

/// `2026-10-03T22:32:35.651Z` → `22:32:35`. Cualquier otro formato pasa entero.
fn short_time(timestamp: &str) -> String {
    if let Some(t) = timestamp.split('T').nth(1) {
        let head: String = t.chars().take(8).collect();
        if head.contains(':') {
            return head;
        }
    }
    timestamp.to_string()
}

fn short_level(level: &str) -> &str {
    match level.to_ascii_lowercase().as_str() {
        "error" | "err" => "ERROR",
        "warn" | "warning" => "WARN",
        "info" => "INFO",
        "debug" => "DEBUG",
        _ => "",
    }
}

fn level_color(level: &str) -> crate::term::Color {
    match level.to_ascii_lowercase().as_str() {
        "error" | "err" => RED,
        "warn" | "warning" => YELLOW,
        "debug" => DIM,
        _ => GREEN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::LogState;

    fn state_with(entries: Vec<LogEntry>) -> AppState {
        let mut state = AppState::default();
        state.logs = LogState { entries, visible: true, capacity: 200 };
        state
    }

    fn entry(level: &str, source: &str, message: &str) -> LogEntry {
        LogEntry {
            timestamp: "2026-10-03T22:32:35.651Z".to_string(),
            level: level.to_string(),
            source: source.to_string(),
            message: message.to_string(),
        }
    }

    #[test]
    fn shows_an_empty_state_instead_of_a_blank_panel() {
        let mut canvas = Canvas::new(100, 10);
        render(&mut canvas, Rect::new(0, 0, 100, 10), &AppState::default());

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("LOGS"));
        assert!(frame.contains("sin entradas"));
    }

    #[test]
    fn renders_columns_and_strips_the_iso_timestamp_to_a_clock() {
        let state = state_with(vec![entry("warn", "coordinator", "worktree tomado")]);
        let mut canvas = Canvas::new(110, 10);
        render(&mut canvas, Rect::new(0, 0, 110, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("22:32:35"), "la hora debe quedar legible");
        assert!(!frame.contains("2026-10-03"), "no debe quedar el ISO completo");
        assert!(frame.contains("WARN"));
        assert!(frame.contains("coordinator"));
        assert!(frame.contains("worktree tomado"));
    }

    #[test]
    fn the_newest_entry_is_always_on_screen() {
        // El dato interesante de un log es el final: si la lista excede el panel,
        // lo reciente no puede quedar fuera de la vista.
        let entries: Vec<LogEntry> = (0..50)
            .map(|i| entry("info", "swarm", &format!("evento-{i}")))
            .collect();
        let state = state_with(entries);
        let mut canvas = Canvas::new(110, 8);
        render(&mut canvas, Rect::new(0, 0, 110, 8), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("evento-49"), "la entrada más reciente debe verse");
        assert!(!frame.contains("evento-0"), "las viejas ceden el sitio");
    }

    #[test]
    fn a_long_message_is_ellipsized_instead_of_wrapping_into_other_rows() {
        let state = state_with(vec![entry("info", "swarm", &"x".repeat(500))]);
        let mut canvas = Canvas::new(100, 6);
        render(&mut canvas, Rect::new(0, 0, 100, 6), &state);

        let frame = canvas.to_text_rows().join("\n");
        // Una sola fila de mensaje: el segundo "x" no debe caer en la fila siguiente.
        let x_rows = frame.lines().filter(|l| l.contains('x')).count();
        assert_eq!(x_rows, 1, "el mensaje largo se recorta en una sola línea");
    }

    #[test]
    fn unknown_levels_do_not_panic() {
        let state = state_with(vec![entry("TRACE", "", "")]);
        let mut canvas = Canvas::new(60, 5);
        render(&mut canvas, Rect::new(0, 0, 60, 5), &state);

        assert!(canvas.to_text_rows().join("\n").contains("LOGS"));
    }
}