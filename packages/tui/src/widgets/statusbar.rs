use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, GREEN, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if rect.h == 0 { return; }
    let y  = rect.y;
    let bg = Color::Indexed(235);
    canvas.fill_rect(rect, ' ', Style::new().bg(bg));

    let mode_label = format!(" {} ", state.mode.label());
    let mode_fg = match state.mode {
        crate::app::ReplMode::Plan     => AMBER,
        crate::app::ReplMode::Approval => Color::Rgb(252, 211, 77),
        crate::app::ReplMode::Auto     => GREEN,
    };
    canvas.print(rect.x, y, &mode_label, Style::new().fg(mode_fg).bold().bg(bg));

    let sep_x = rect.x + mode_label.chars().count() as u16 + 1;
    canvas.print(sep_x, y, "│", Style::new().fg(DIM).bg(bg));

    let msg_x   = sep_x + 2;
    let max_msg = rect.w.saturating_sub(msg_x - rect.x + 10) as usize;
    let msg     = if state.status_msg.len() > max_msg { &state.status_msg[..max_msg] } else { &state.status_msg };
    canvas.print(msg_x, y, msg, Style::new().fg(SECONDARY).bg(bg));

    let tok_str = format!(" {} tokens ", state.fmt_tokens());
    let tok_x   = rect.right().saturating_sub(tok_str.chars().count() as u16);
    canvas.print(tok_x, y, &tok_str, Style::new().fg(DIM).bg(bg));
}
