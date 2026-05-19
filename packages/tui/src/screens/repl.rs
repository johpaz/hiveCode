use ratatui::{
    layout::{Constraint, Direction, Layout},
    Frame,
};

use crate::app::AppState;
use crate::widgets::{command_popup, config_modal, header, history, info_modal, input, log_panel, mascot, phase_timeline, statusbar, welcome};

pub fn draw(frame: &mut Frame, state: &mut AppState) {
    let area = frame.area();

    if state.history.is_empty() {
        // ── Welcome state: content + input box + statusbar ────────────────
        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Fill(1),      // welcome content
                Constraint::Length(5),    // input box (more spacious)
                Constraint::Length(1),    // statusbar
            ])
            .split(area);

        welcome::draw(frame, state, root[0]);
        input::draw(frame, state, root[1]);
        statusbar::draw(frame, state, root[2]);

        // Mascot (drawn before popup so popup appears on top)
        mascot::draw(frame, state, area);
        // Suggestion popup as overlay (drawn after mascot)
        command_popup::draw(frame, state, area);
        // Config modal (on top of everything)
        config_modal::draw(frame, state);
        // Info modal (read-only display, on top of everything)
        info_modal::draw(frame, state);
    } else {
        // ── Active session: header + history + input + statusbar ──────────
        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3), // header
                Constraint::Fill(1),   // history
                Constraint::Length(5), // input (more spacious)
                Constraint::Length(1), // statusbar
            ])
            .split(area);

        let header_area  = root[0];
        let body_area    = root[1];
        let input_area   = root[2];
        let status_area  = root[3];

        header::draw(frame, state, header_area);

        let body_constraints = if state.show_timeline {
            vec![Constraint::Length(16), Constraint::Fill(1)]
        } else {
            vec![Constraint::Fill(1)]
        };
        let body_parts = Layout::default()
            .direction(Direction::Vertical)
            .constraints(body_constraints)
            .split(body_area);

        let history_area = if state.show_timeline { body_parts[1] } else { body_parts[0] };

        if state.show_timeline {
            phase_timeline::draw(frame, state, body_parts[0]);
        }

        if state.show_logs {
            let h = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
                .split(history_area);
            history::draw(frame, state, h[0]);
            log_panel::draw(frame, state, h[1]);
        } else {
            history::draw(frame, state, history_area);
        }

        input::draw(frame, state, input_area);
        statusbar::draw(frame, state, status_area);

        // Mascot (drawn before popup so popup appears on top)
        mascot::draw(frame, state, area);
        // Suggestion popup as overlay (drawn after mascot)
        command_popup::draw(frame, state, area);

        // Config modal (on top of everything)
        config_modal::draw(frame, state);
        // Info modal (read-only display, on top of everything)
        info_modal::draw(frame, state);
    }
}
