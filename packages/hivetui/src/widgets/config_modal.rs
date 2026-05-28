use crate::{
    state::{AppState, ModalFieldKind, ModalState},
    term::{Canvas, Rect, Style, AMBER, AMBER_DIM, CYAN, DIM, GREEN, SECONDARY},
};

pub const MAX_VISIBLE_OPTIONS: usize = 6;

/// Número de filas que ocupa un campo en el modal.
pub fn field_height(kind: ModalFieldKind, options_len: usize) -> u16 {
    match kind {
        // label + separator + opciones visibles
        ModalFieldKind::Select => 2 + options_len.min(MAX_VISIBLE_OPTIONS) as u16,
        // label + separator + input
        _ => 3,
    }
}

/// Renderiza el modal de configuración centrado en pantalla.
pub fn render(canvas: &mut Canvas, full_area: Rect, state: &AppState) {
    let ModalState::Config(modal) = &state.modal else {
        return;
    };

    let modal_w = (full_area.w.saturating_sub(8)).min(70).max(40);

    // Altura dinámica según tipo de cada campo
    let fields_h: u16 = modal.fields.iter()
        .map(|f| field_height(f.kind, f.options.as_ref().map(|o| o.len()).unwrap_or(0)))
        .sum();
    let modal_h = (fields_h + 4).min(full_area.h.saturating_sub(4));
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;

    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    canvas.fill_rect(area, ' ', Style::new().fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print_centered(area.x, area.y, area.w, &format!(" {} ", modal.title), Style::new().fg(CYAN).bold());

    let mut row_y = area.y + 1;

    for (i, field) in modal.fields.iter().enumerate() {
        if row_y + 1 >= area.bottom() {
            break;
        }
        let focused = state.modal_focused == i;
        let label_style = if focused { Style::new().fg(AMBER).bold() } else { Style::new().fg(SECONDARY) };
        let border_style = if focused { Style::new().fg(AMBER) } else { Style::new().fg(DIM) };
        let field_w = modal_w.saturating_sub(4);
        let field_x = area.x + 2;

        canvas.print(field_x, row_y, &field.label, label_style);
        row_y += 1;
        canvas.hline(field_x, row_y, field_w, '─', border_style);
        row_y += 1;

        match field.kind {
            ModalFieldKind::Select => {
                let opts = field.options.as_deref().unwrap_or(&[]);
                let value = modal.values.get(i).map(String::as_str).unwrap_or("");
                let sel_idx = opts.iter().position(|o| o == value).unwrap_or(0);
                // scroll offset stored in cursors[i]
                let scroll = modal.cursors.get(i).copied().unwrap_or(0);
                let visible = opts.len().min(MAX_VISIBLE_OPTIONS);

                for v in 0..visible {
                    if row_y >= area.bottom().saturating_sub(1) { break; }
                    let opt_idx = scroll + v;
                    if opt_idx >= opts.len() { break; }

                    let is_sel = opt_idx == sel_idx;
                    let (prefix, text_style) = if is_sel && focused {
                        ("▸ ", Style::new().fg(AMBER).bold())
                    } else if is_sel {
                        ("▸ ", Style::new().fg(GREEN))
                    } else {
                        ("  ", Style::new().fg(DIM))
                    };

                    canvas.print(field_x, row_y, prefix, text_style);
                    let max_w = field_w.saturating_sub(4) as usize;
                    let shown: String = opts[opt_idx].chars().take(max_w).collect();
                    canvas.print(field_x + 2, row_y, &shown, text_style);

                    // Indicadores de scroll
                    let indicator_x = field_x + field_w.saturating_sub(2);
                    if v == 0 && scroll > 0 {
                        canvas.print(indicator_x, row_y, "↑", Style::new().fg(AMBER_DIM));
                    } else if v == visible - 1 && scroll + visible < opts.len() {
                        canvas.print(indicator_x, row_y, "↓", Style::new().fg(AMBER_DIM));
                    }

                    row_y += 1;
                }
            }
            ModalFieldKind::Secret => {
                if row_y < area.bottom().saturating_sub(1) {
                    let value = modal.values.get(i).map(String::as_str).unwrap_or("");
                    let char_count = value.chars().count();
                    let visible_w = field_w.saturating_sub(2) as usize;
                    // Always work in character counts — "•" is 3 bytes so byte arithmetic panics
                    let show_count = char_count.min(visible_w);
                    let shown = "•".repeat(show_count);
                    canvas.print(field_x, row_y, &shown, Style::new().fg(GREEN));
                    if focused {
                        let cx = (field_x + show_count as u16).min(field_x + field_w - 1);
                        canvas.print(cx, row_y, "▌", Style::new().fg(AMBER));
                    }
                    row_y += 1;
                }
            }
            ModalFieldKind::Text => {
                if row_y < area.bottom().saturating_sub(1) {
                    let value = modal.values.get(i).map(String::as_str).unwrap_or("");
                    let visible_w = field_w.saturating_sub(2) as usize;
                    // Use char indices to avoid splitting multi-byte characters
                    let char_count = value.chars().count();
                    let skip = char_count.saturating_sub(visible_w);
                    let start_byte = value.char_indices().nth(skip).map(|(b, _)| b).unwrap_or(0);
                    let shown = &value[start_byte..];
                    canvas.print(field_x, row_y, shown, Style::new().fg(GREEN));
                    if focused {
                        let cx = (field_x + shown.chars().count() as u16).min(field_x + field_w - 1);
                        canvas.print(cx, row_y, "▌", Style::new().fg(AMBER));
                    }
                    row_y += 1;
                }
            }
        }
    }

    // Hint según campo enfocado
    let has_select = modal.fields.get(state.modal_focused)
        .map(|f| f.kind == ModalFieldKind::Select)
        .unwrap_or(false);
    let hint = if has_select {
        "↑↓ seleccionar  Tab siguiente  Enter guardar  Esc cancelar"
    } else {
        "Tab siguiente  Enter guardar  Esc cancelar"
    };
    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, hint_y, hint, Style::new().fg(DIM));
}
