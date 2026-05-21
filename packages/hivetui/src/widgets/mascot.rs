use crate::{
    state::{AppState, ReplMode},
    term::{Canvas, Style, GREEN, SECONDARY},
};

pub fn render(canvas: &mut Canvas, area: crate::term::Rect, state: &AppState) {
    let face = match state.session.mode {
        ReplMode::Plan => "\\(^•^)/",
        ReplMode::Approval => "(?•?)",
        ReplMode::Auto => "(•ᴗ•)",
    };

    let y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, y, face, Style::new().fg(GREEN).bold());
    canvas.print(area.x + 10, y, "hive", Style::new().fg(SECONDARY));
}
