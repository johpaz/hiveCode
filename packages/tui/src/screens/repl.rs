use ratatui::{
    layout::{Constraint, Direction, Layout},
    Frame,
};

use crate::app::AppState;
use crate::widgets::{command_popup, header, history, input, mascot, statusbar, welcome};

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

        // Suggestion popup anchored above the input box
        let popup_anchor = ratatui::layout::Rect {
            x: root[1].x,
            y: root[0].y,
            width: root[1].width,
            height: root[0].height + root[1].height,
        };
        command_popup::draw(frame, state, popup_anchor);

        // Mascot in bottom-right corner (drawn last, on top)
        mascot::draw(frame, state, area);
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

        let footer_area = ratatui::layout::Rect {
            x: input_area.x,
            y: input_area.y,
            width: input_area.width,
            height: input_area.height + status_area.height,
        };

        header::draw(frame, state, header_area);
        history::draw(frame, state, body_area);
        input::draw(frame, state, input_area);
        statusbar::draw(frame, state, status_area);
        command_popup::draw(frame, state, footer_area);

        // Mascot in bottom-right corner
        mascot::draw(frame, state, area);
    }
}
