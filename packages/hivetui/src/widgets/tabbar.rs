use crate::{
    state::{AppState, TabId},
    term::{
        Canvas, Rect, Style, AMBER_BRIGHT, AMBER_DIM, AMBER_SUBTLE, BG_PANEL, DIM, GREEN, RED,
        SECONDARY, WHITE, YELLOW,
    },
    ui::text::{cell_width, ellipsize_cells},
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
        let badge = badge_for(*id, state);
        let slot_w = tab_slot_width(label, badge.as_deref());

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
        let mut cursor = x + 2 + label.chars().count() as u16;
        canvas.print(cursor, y, &num_str, num_style);
        cursor += 3;

        if let Some(badge) = badge {
            canvas.print(cursor, y, " ", Style::new().bg(bg));
            cursor += 1;
            let badge_style = badge_style(*id, state).bg(bg);
            canvas.print(cursor, y, &badge, badge_style);
            cursor += badge.chars().count() as u16;
        }

        canvas.print(cursor, y, "  ", Style::new().bg(bg));

        x += slot_w;
    }

    let provider = if state.session.provider.trim().is_empty() {
        "sin provider"
    } else {
        state.session.provider.as_str()
    };
    let hint = format!(
        "{} · {} · {}",
        state.session.mode.label(),
        provider,
        state.harness.health_label(&state.session.provider, state.running)
    );
    let hint = ellipsize_cells(&hint, area.w.saturating_sub(2) as usize);
    let hint_x = area.right().saturating_sub(cell_width(&hint) as u16 + 2);
    if hint_x > x {
        canvas.print(hint_x, y, &hint, Style::new().fg(DIM));
    }
}

/// Retorna el TabId si el click en `col` cae sobre una pestaña.
pub fn tab_at_col(area: Rect, col: u16, state: &AppState) -> Option<TabId> {
    if col < area.x || col >= area.right() {
        return None;
    }
    let mut x = area.x + 1;
    for (id, label) in TABS {
        let start = x;
        let badge = badge_for(*id, state);
        let slot_w = tab_slot_width(label, badge.as_deref());
        x += slot_w;
        if col >= start && col < x {
            return Some(*id);
        }
    }
    None
}

pub fn tab_regions(area: Rect, state: &AppState) -> Vec<(TabId, Rect)> {
    let mut regions = Vec::with_capacity(TABS.len());
    let mut x = area.x + 1;
    for (id, label) in TABS {
        let badge = badge_for(*id, state);
        let slot_w = tab_slot_width(label, badge.as_deref());
        regions.push((*id, Rect::new(x, area.y, slot_w, 1)));
        x = x.saturating_add(slot_w);
    }
    regions
}

fn tab_slot_width(label: &str, badge: Option<&str>) -> u16 {
    let base = 1 + 1 + label.chars().count() as u16 + 3 + 2;
    match badge {
        Some(badge) => base + 1 + badge.chars().count() as u16,
        None => base,
    }
}

fn badge_for(tab: TabId, state: &AppState) -> Option<String> {
    match tab {
        TabId::Focus if state.running => Some("live".to_string()),
        TabId::Focus if !state.history.entries.is_empty() => {
            Some(state.history.entries.len().min(99).to_string())
        }
        TabId::Plan if state.harness.approval_pending => Some("approve".to_string()),
        TabId::Plan => state
            .plan
            .current
            .as_ref()
            .map(|plan| plan.status.clone())
            .filter(|status| !status.trim().is_empty()),
        TabId::Code if !state.diff.lines.is_empty() => {
            Some(format!("+{}-{}", state.diff.stats_added, state.diff.stats_removed))
        }
        TabId::Code if !state.filemap.entries.is_empty() => {
            Some(format!("{} files", state.filemap.entries.len().min(99)))
        }
        TabId::Review if !state.conflicts.entries.is_empty() => Some("conflict".to_string()),
        TabId::Review if state.harness.approval_pending => Some("pending".to_string()),
        TabId::Review if !state.checkpoints.entries.is_empty() => {
            Some(format!("cp{}", state.checkpoints.entries.len().min(99)))
        }
        TabId::Dashboard => {
            let running_workers = state
                .workers
                .workers
                .iter()
                .filter(|worker| matches!(worker.status, crate::state::WorkerStatus::Running))
                .count();
            if running_workers > 0 {
                Some(format!("{running_workers} run"))
            } else if !state.tasks.tasks.is_empty() {
                Some(format!("{} tasks", state.tasks.tasks.len().min(99)))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn badge_style(tab: TabId, state: &AppState) -> Style {
    match tab {
        TabId::Plan | TabId::Review if state.harness.approval_pending => Style::new().fg(YELLOW).bold(),
        TabId::Review if !state.conflicts.entries.is_empty() => Style::new().fg(RED).bold(),
        TabId::Focus if state.running => Style::new().fg(GREEN).bold(),
        TabId::Code if !state.diff.lines.is_empty() => Style::new().fg(WHITE).bold(),
        _ => Style::new().fg(AMBER_DIM),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ipc::DiffLine, term::Canvas};

    #[test]
    fn tabbar_renders_live_plan_and_diff_badges() {
        let mut state = AppState::default();
        state.running = true;
        state.harness.approval_pending = true;
        state.diff.stats_added = 12;
        state.diff.stats_removed = 3;
        state.diff.lines.push(DiffLine {
            kind: "add".to_string(),
            text: "line".to_string(),
            old_line_no: None,
            new_line_no: Some(1),
        });

        let mut canvas = Canvas::new(120, 1);
        render(&mut canvas, Rect::new(0, 0, 120, 1), &state);
        let row = canvas.to_text_rows().join("\n");

        assert!(row.contains("live"));
        assert!(row.contains("approve"));
        assert!(row.contains("+12-3"));
    }

    #[test]
    fn tab_hit_regions_use_badged_widths() {
        let mut state = AppState::default();
        state.harness.approval_pending = true;
        let regions = tab_regions(Rect::new(0, 0, 120, 1), &state);
        let plan_region = regions
            .iter()
            .find(|(tab, _)| *tab == TabId::Plan)
            .map(|(_, rect)| *rect)
            .expect("plan region");

        assert_eq!(tab_at_col(Rect::new(0, 0, 120, 1), plan_region.x, &state), Some(TabId::Plan));
        assert!(plan_region.w > "⬡ PLAN[2]  ".chars().count() as u16);
    }
}
