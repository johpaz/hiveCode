use crate::{
    state::{AppState, TabId},
    term::{Canvas, Rect, Style, AMBER_BRIGHT, AMBER_DIM, AMBER_SUBTLE, BG_PANEL, DIM, SECONDARY},
};

const TABS: &[(TabId, &str)] = &[
    (TabId::Focus,     "FOCUS"),
    (TabId::Plan,      "PLAN"),
    (TabId::Code,      "CODE"),
    (TabId::Review,    "REVIEW"),
    (TabId::Dashboard, "DASHBOARD"),
];

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let y = area.y;
    let mut x = area.x + 1;

    for (idx, (id, label)) in TABS.iter().enumerate() {
        let is_active = state.active_tab == *id;
        let num = idx + 1;
        // slot: "⬡ LABEL[N]  " — ⬡(1) + sp(1) + label + [N](3) + 2 padding
        let slot_w = 1 + 1 + label.chars().count() as u16 + 3 + 2;

        if is_active {
            canvas.fill_rect(Rect::new(x, y, slot_w, 1), ' ', Style::new().bg(AMBER_SUBTLE));
        }

        let bg = if is_active { AMBER_SUBTLE } else { BG_PANEL };

        // ⬡
        let hex_style = if is_active {
            Style::new().fg(AMBER_BRIGHT).bg(bg)
        } else {
            Style::new().fg(DIM).bg(bg)
        };
        canvas.print(x, y, "⬡", hex_style);

        // space
        canvas.print(x + 1, y, " ", Style::new().bg(bg));

        // LABEL
        let label_style = if is_active {
            Style::new().fg(AMBER_BRIGHT).bold().bg(bg)
        } else {
            Style::new().fg(SECONDARY).bg(bg)
        };
        canvas.print(x + 2, y, label, label_style);

        // [N]
        let num_str = format!("[{num}]");
        let num_style = if is_active {
            Style::new().fg(AMBER_DIM).bg(bg)
        } else {
            Style::new().fg(DIM).bg(bg)
        };
        canvas.print(x + 2 + label.chars().count() as u16, y, &num_str, num_style);

        // trailing padding (2 spaces)
        canvas.print(x + 2 + label.chars().count() as u16 + 3, y, "  ", Style::new().bg(bg));

        x += slot_w;
    }

    // hint derecha: formato del diseño
    let hint = "/layout focus | plan | code | review | dashboard";
    let hint_x = area.right().saturating_sub(hint.chars().count() as u16 + 2);
    if hint_x > x {
        canvas.print(hint_x, y, hint, Style::new().fg(DIM));
    }
}

/// Retorna el TabId si el click en `col` cae sobre una pestaña.
pub fn tab_at_col(area: Rect, col: u16) -> Option<TabId> {
    if col < area.x || col >= area.right() {
        return None;
    }
    let mut x = area.x + 1;
    for (id, label) in TABS {
        let start = x;
        let slot_w = 1 + 1 + label.chars().count() as u16 + 3 + 2;
        x += slot_w;
        if col >= start && col < x {
            return Some(*id);
        }
    }
    None
}
