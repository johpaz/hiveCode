use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER_BRIGHT, AMBER_DIM, CYAN, RED, SECONDARY},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    let row = area.y;
    let mut x = area.x + 1;

    canvas.print(x, row, "⬡ CHECKPOINTS", Style::new().fg(AMBER_DIM).bold());
    x += 14;

    let cps = &state.checkpoints.entries;
    if cps.is_empty() {
        canvas.print(x, row, "  sin checkpoints", Style::new().fg(AMBER_DIM));
        return;
    }

    let selected = state.checkpoints.selected;
    let current_idx = cps.len().saturating_sub(1);

    for (i, cp) in cps.iter().enumerate() {
        let is_current = i == current_idx;
        let is_selected = selected == Some(i);

        let label = if is_current {
            format!(" [{}●]", cp.id)
        } else if is_selected {
            format!(" [{}◀]", cp.id)
        } else {
            format!(" [{}]", cp.id)
        };

        let style = if is_current {
            Style::new().fg(AMBER_BRIGHT).bold()
        } else if is_selected {
            Style::new().fg(CYAN)
        } else {
            Style::new().fg(SECONDARY)
        };

        let label_w = label.chars().count() as u16;
        if x + label_w >= area.right().saturating_sub(1) {
            break;
        }
        canvas.print(x, row, &label, style);
        x += label_w;
    }

    if selected.is_some() {
        let rb = " [↩ ROLLBACK]";
        let rb_x = area.right().saturating_sub(rb.chars().count() as u16 + 1);
        if rb_x > x {
            canvas.print(rb_x, row, rb, Style::new().fg(RED));
        }
    }
}
