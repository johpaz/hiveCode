use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, RED},
    ui::{terminal_primitives::fmt_tokens, text::cell_width, truncate_cells},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new());

    let mode = if state.history_nav_mode { "NAV" } else { "INPUT" };
    let mode_style = if state.history_nav_mode {
        Style::new().fg(GREEN).bold()
    } else {
        Style::new().fg(AMBER).bold()
    };

    canvas.hline(area.x, area.y, area.w, '─', Style::new().fg(DIM));
    canvas.print(area.x + 1, area.y, "modo:", Style::new().fg(DIM));
    canvas.print(area.x + 7, area.y, mode, mode_style);

    let left_w = 13;

    // Prioridad: confirmación destructiva > sugerencia de layout > razón de
    // transición > mensaje de Bun > atajos según el contexto de teclado real.
    let suggestion = state.pending_layout_suggestion();
    let typing = !state.input.value().is_empty();

    let (right_content, style) = if state.dashboard.halt_confirm {
        (
            "⚠ detener el enjambre · Enter confirma · Esc cancela".to_string(),
            Style::new().fg(RED).bold(),
        )
    } else if state.dashboard.rollback_confirm_checkpoint.is_some() {
        (
            "⚠ rollback · Enter confirma · Esc cancela".to_string(),
            Style::new().fg(RED).bold(),
        )
    } else if let Some(tab) = suggestion {
        let why = state
            .routing
            .transition_reason
            .as_deref()
            .unwrap_or("hay actividad nueva");
        (
            format!("→ {} [{}] · {}", tab.label(), tab.num(), why),
            Style::new().fg(AMBER).bold(),
        )
    } else if let Some(reason) = state.routing.transition_reason.as_deref() {
        (reason.to_string(), Style::new().fg(AMBER).bold())
    } else if !state.status_msg.is_empty() {
        let prefix = if state.running { "⟳ " } else { "" };
        (
            format!("{prefix}{}", state.status_msg),
            if state.running { Style::new().fg(CYAN) } else { Style::new().fg(DIM) },
        )
    } else if typing {
        // Con texto en el input las flechas y las letras son edición, no atajos.
        (
            "Enter enviar  ←/→ cursor  Ctrl+←/→ palabra  Esc limpiar  Ctrl+C salir".to_string(),
            Style::new().fg(DIM),
        )
    } else if state.history_nav_mode {
        (
            "↑/↓ entrada  Shift+←/→ scroll  Ctrl+L cargar  Ctrl+Y copiar  Tab salir".to_string(),
            Style::new().fg(DIM),
        )
    } else {
        (
            "1-5 vistas  Tab nav  Shift+Tab modo  ←/→ checkpoint  Ctrl+C salir".to_string(),
            Style::new().fg(DIM),
        )
    };
    // ── Indicador del oráculo, pegado al extremo derecho ──────────────────
    // El mensaje de Bun y las confirmaciones destructivas tienen prioridad: el
    // chip recorta su propio texto para dejarles sitio, y si aun así no cabe,
    // se omite. `off` no se dibuja nunca — un oráculo que el usuario no
    // activó no merece ocupar una celda.
    let avail = area.w.saturating_sub(left_w + 1) as usize;
    let chip = jev_chip(state).or_else(|| jev_short(state));
    let chip_w = chip.as_ref().map(|(t, _)| cell_width(t)).unwrap_or(0);

    let reserved = chip_w + if chip_w > 0 { 2 } else { 0 };
    let content_w = avail.saturating_sub(reserved);
    let shown = truncate_cells(&right_content, content_w);
    canvas.print(area.x + left_w, area.y, &shown, style);

    if let Some((text, chip_style)) = chip {
        let x = area.x + area.w.saturating_sub(cell_width(&text) as u16 + 1);
        if x > area.x + left_w + shown.chars().count() as u16 {
            canvas.print(x, area.y, &text, chip_style);
        }
    }
}

/// `● oráculo · 12 dec · ahorró 48.2k`, o `None` si no está configurado.
fn jev_chip(state: &AppState) -> Option<(String, Style)> {
    let availability = state.jev.availability;
    if !availability.is_configured() {
        return None;
    }
    let glyph = availability.glyph();
    let Some(summary) = state.jev.statusbar_summary() else {
        return None;
    };
    Some((
        format!("{glyph} {summary}"),
        Style::new().fg(availability.color()),
    ))
}

/// Variante corta para terminales estrechos: sin el conteo de decisiones.
fn jev_short(state: &AppState) -> Option<(String, Style)> {
    let availability = state.jev.availability;
    if !availability.is_configured() || state.jev.totals.saved_tokens == 0 {
        return None;
    }
    Some((
        format!(
            "{} {}",
            availability.glyph(),
            fmt_tokens(state.jev.totals.saved_tokens)
        ),
        Style::new().fg(availability.color()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{JevAvailability, JevTotals};
    use crate::term::Canvas;

    fn bar(canvas: &mut Canvas, w: u16, state: &AppState) -> String {
        let area = Rect::new(0, 0, w, 1);
        render(canvas, area, state);
        canvas.to_text_rows().remove(0)
    }

    fn ready_state() -> AppState {
        let mut state = AppState::default();
        state.jev.set_availability(
            JevAvailability::Ready,
            None,
            Some(1),
            JevTotals { decisions: 12, saved_tokens: 48_200, cost_usd: 0.02 },
        );
        state
    }

    #[test]
    fn an_unconfigured_oracle_costs_nothing_on_screen() {
        // `off` es el estado por defecto: si apareciera, cada usuario sin
        // OpenRouter tendría un chip que no le sirve.
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &AppState::default());

        assert!(row.contains("modo:"));
        assert!(!row.contains("oráculo"));
    }

    #[test]
    fn a_ready_oracle_shows_its_working_savings() {
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &ready_state());

        assert!(row.contains("● oráculo"), "{row}");
        assert!(row.contains("12 dec"), "{row}");
        assert!(row.contains("ahorró"), "{row}");
    }

    #[test]
    fn a_cooling_oracle_warns_instead_of_disappearing() {
        let mut state = ready_state();
        state.jev.set_availability(
            JevAvailability::Fallback,
            Some("HTTP 429".to_string()),
            None,
            JevTotals { decisions: 3, saved_tokens: 900, cost_usd: 0.001 },
        );
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &state);

        assert!(row.contains("enfriando"), "{row}");
    }

    #[test]
    fn a_destructive_confirmation_keeps_its_room() {
        // La prioridad del statusbar no se negocia: si hay un halt pendiente,
        // el chip del oráculo tiene que ceder.
        let mut state = ready_state();
        state.dashboard.halt_confirm = true;
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &state);

        assert!(row.contains("detener el enjambre"), "{row}");
    }

    #[test]
    fn a_narrow_terminal_degrades_to_the_short_chip() {
        let mut canvas = Canvas::new(46, 1);
        let row = bar(&mut canvas, 46, &ready_state());

        // Algo del oráculo sobrevive, pero sin desbordar la fila.
        assert!(row.chars().count() <= 46, "{row}");
    }

    #[test]
    fn rendering_never_panics_on_a_tiny_area() {
        for w in 0..40u16 {
            let mut canvas = Canvas::new(w.max(1), 1);
            let _ = bar(&mut canvas, w, &ready_state());
        }
    }
}
