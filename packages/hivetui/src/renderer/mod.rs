use crate::{
    state::{AppState, ModalState, TabId},
    term::{Canvas, Rect},
    widgets::{
        checkpoint_bar, code_layout, command_popup, config_modal, conflict_bar,
        dashboard_layout, header, history, info_modal, input, plan_approval_modal, plan_layout,
        review_layout, statusbar, tabbar, welcome,
    },
};

pub fn render(canvas: &mut Canvas, state: &AppState) -> (u16, u16) {
    canvas.clear();
    let area = canvas.area();

    let input_area = render_main(canvas, area, state);

    // Welcome fullscreen overlay — cubre todo (header, tabbar, contenido, input)
    if state.show_welcome && state.history.entries.is_empty() {
        welcome::render(canvas, area, state);
        return (0, 0);
    }

    // Popup de comandos: flota justo encima del input
    if state.input.value().starts_with('/') && !matches!(state.modal, ModalState::Config(_) | ModalState::Info(_) | ModalState::PlanApproval(_)) {
        let history_area = content_area_for_popup(area, state);
        command_popup::render(canvas, history_area, state);
    }

    // Modales: overlays sobre todo
    match &state.modal {
        ModalState::Config(_)       => config_modal::render(canvas, area, state),
        ModalState::Info(_)         => info_modal::render(canvas, area, state),
        ModalState::PlanApproval(_) => plan_approval_modal::render(canvas, area, state),
        ModalState::None            => {}
    }

    cursor_position(state, input_area)
}

fn render_main(canvas: &mut Canvas, area: Rect, state: &AppState) -> Rect {
    // Layout: [header 2] + [tabbar 1] + [content fill] + [checkpoint 1] + [conflict 1] + [input 4] + [statusbar 1]
    let rows = area.vsplit(&[2, 1, 0, 1, 1, 4, 1]);
    let header_area     = rows[0];
    let tabbar_area     = rows[1];
    let content_area    = rows[2];
    let checkpoint_area = rows[3];
    let conflict_area   = rows[4];
    let input_row       = rows[5];
    let status_area     = rows[6];

    canvas.with_clip(header_area, |canvas| header::render(canvas, header_area, state));
    canvas.with_clip(tabbar_area, |canvas| tabbar::render(canvas, tabbar_area, state));

    canvas.with_clip(content_area, |canvas| match state.active_tab {
        TabId::Focus     => render_focus(canvas, content_area, state),
        TabId::Plan      => plan_layout::render(canvas, content_area, state),
        TabId::Code      => code_layout::render(canvas, content_area, state),
        TabId::Review    => review_layout::render(canvas, content_area, state),
        TabId::Dashboard => dashboard_layout::render(canvas, content_area, state),
    });

    canvas.with_clip(checkpoint_area, |canvas| checkpoint_bar::render(canvas, checkpoint_area, state));
    canvas.with_clip(conflict_area, |canvas| conflict_bar::render(canvas, conflict_area, state));
    canvas.with_clip(input_row, |canvas| input::render(canvas, input_row, state));
    canvas.with_clip(status_area, |canvas| statusbar::render(canvas, status_area, state));

    input_row
}

fn render_focus(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // Welcome se maneja como overlay en render() — aquí siempre history
    history::render(canvas, area, state);
}

fn content_area_for_popup(area: Rect, _state: &AppState) -> Rect {
    let rows = area.vsplit(&[2, 1, 0, 1, 1, 4, 1]);
    rows[2]
}

fn cursor_position(state: &AppState, input_area: Rect) -> (u16, u16) {
    let mode_badge_w = match &state.session.mode {
        crate::state::ReplMode::Plan     => 6u16,
        crate::state::ReplMode::Approval => 10,
        crate::state::ReplMode::Auto     => 6,
    };
    let available = input_area.w.saturating_sub(5 + mode_badge_w + 4) as usize;
    let visible = state.input.visible_segment(available);
    let cursor_offset = visible.cursor_column;
    let x = input_area
        .x
        .saturating_add(5)
        .saturating_add(cursor_offset as u16)
        .min(input_area.right().saturating_sub(mode_badge_w + 4));
    (x, input_area.y + 1)
}
