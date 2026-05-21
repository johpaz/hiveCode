use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, SECONDARY},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.draw_border(area, Style::new().fg(AMBER));
    canvas.print(
        area.x + 2,
        area.y,
        "hivetui",
        Style::new().fg(AMBER).bold(),
    );

    let right = format!(
        "{} · {} · {}",
        state.session.provider,
        state.session.model,
        state.session.mode.label()
    );
    canvas.print(area.x + 2, area.y + 1, &state.session.project_name, Style::new().fg(AMBER));

    let right_x = area
        .right()
        .saturating_sub(right.chars().count() as u16 + 2)
        .max(area.x + 2);
    canvas.print(right_x, area.y + 1, &right, Style::new().fg(SECONDARY));
}
