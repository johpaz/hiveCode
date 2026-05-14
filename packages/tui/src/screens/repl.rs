use ratatui::{
    layout::{Constraint, Direction, Layout},
    Frame,
};

use crate::app::AppState;
use crate::widgets::{command_popup, header, history, input, statusbar, welcome};

pub fn draw(frame: &mut Frame, state: &AppState) {
    let area = frame.area();

    if state.history.is_empty() {
        // ── Welcome state: full screen for welcome widget ─────────────────
        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Fill(1),   // welcome (includes inline input)
                Constraint::Length(1), // statusbar
            ])
            .split(area);

        welcome::draw(frame, state, root[0]);
        statusbar::draw(frame, state, root[1]);

        // Suggestion popup anchored to bottom of welcome area
        command_popup::draw(frame, state, root[0]);
    } else {
        // ── Active session: header + history + input + statusbar ──────────
        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3), // header
                Constraint::Fill(1),   // history
                Constraint::Length(3), // input
                Constraint::Length(1), // statusbar
            ])
            .split(area);

        let header_area  = root[0];
        let body_area    = root[1];
        let input_area   = root[2];
        let status_area  = root[3];

        let footer_area = ratatui::layout::Rect {
            x:      input_area.x,
            y:      input_area.y,
            width:  input_area.width,
            height: input_area.height + status_area.height,
        };

        header::draw(frame, state, header_area);
        history::draw(frame, state, body_area);
        input::draw(frame, state, input_area);
        statusbar::draw(frame, state, status_area);
        command_popup::draw(frame, state, footer_area);
    }
}
