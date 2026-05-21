use crate::{
    state::{AppState, ModalState},
    term::{Canvas, Rect},
    widgets::{
        command_popup, config_modal, header, history, info_modal, input, mascot, statusbar,
        thought_stream, welcome, workers_panel,
    },
};

pub fn render(canvas: &mut Canvas, state: &AppState) -> (u16, u16) {
    canvas.clear();
    let area = canvas.area();
    let has_workers = !state.workers.workers.is_empty();

    let input_area = if has_workers {
        render_dashboard(canvas, area, state)
    } else {
        render_simple(canvas, area, state)
    };

    mascot::render(canvas, area, state);

    // Popup de comandos: flota justo encima del input
    if state.input.value().starts_with('/') && !matches!(state.modal, ModalState::Config(_) | ModalState::Info(_)) {
        // El popup flota sobre el panel de historia (columna izquierda en dashboard)
        let history_area = if has_workers {
            area.hsplit(&[0, area.w * 40 / 100])[0].vsplit(&[3, 0, 4, 1])[1]
        } else {
            area.vsplit(&[3, 0, 4, 1])[1]
        };
        command_popup::render(canvas, history_area, state);
    }

    // Modales: overlays sobre todo
    match &state.modal {
        ModalState::Config(_) => config_modal::render(canvas, area, state),
        ModalState::Info(_)   => info_modal::render(canvas, area, state),
        ModalState::None      => {}
    }

    cursor_position(state, input_area)
}

fn render_simple(canvas: &mut Canvas, area: Rect, state: &AppState) -> Rect {
    let vertical = area.vsplit(&[3, 0, 4, 1]);
    header::render(canvas, vertical[0], state);
    if state.history.entries.is_empty() {
        welcome::render(canvas, vertical[1], state);
    } else {
        history::render(canvas, vertical[1], state);
    }
    input::render(canvas, vertical[2], state);
    statusbar::render(canvas, vertical[3], state);
    vertical[2]
}

fn render_dashboard(canvas: &mut Canvas, area: Rect, state: &AppState) -> Rect {
    let right_w = (area.w * 40 / 100).max(20).min(50);
    let columns = area.hsplit(&[0, right_w]);
    let left = columns[0];
    let right = columns[1];

    // Columna izquierda: header + historia/welcome + input + statusbar
    let vertical_left = left.vsplit(&[3, 0, 4, 1]);
    header::render(canvas, vertical_left[0], state);
    if state.history.entries.is_empty() {
        welcome::render(canvas, vertical_left[1], state);
    } else {
        history::render(canvas, vertical_left[1], state);
    }
    input::render(canvas, vertical_left[2], state);
    statusbar::render(canvas, vertical_left[3], state);

    // Columna derecha: workers (50%) + thought stream (50%)
    let right_panels = right.vsplit(&[0, 0]);
    workers_panel::render(canvas, right_panels[0], state);
    thought_stream::render(canvas, right_panels[1], state);

    vertical_left[2]
}

fn cursor_position(state: &AppState, input_area: Rect) -> (u16, u16) {
    let visible = state.input.visible_segment(input_area.w.saturating_sub(6) as usize);
    let cursor_offset = visible.cursor_column;
    let x = input_area
        .x
        .saturating_add(4)
        .saturating_add(cursor_offset as u16)
        .min(input_area.right().saturating_sub(2));
    (x, input_area.y + 1)
}
