use crate::{
    state::{AppState, ModalState, PanelLayoutState, TabId},
    term::{Canvas, Rect},
    ui::{split_panes, Axis, Constraint, HitAction, MouseRegion, SplitPane},
    widgets::{
        checkpoint_bar, code_layout, command_popup, config_modal, conflict_bar,
        dashboard_layout, header, history, info_modal, input, plan_approval_modal, plan_layout,
        review_layout, statusbar, tabbar, welcome,
    },
};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChromeAreas {
    pub header: Rect,
    pub tabbar: Rect,
    pub content: Rect,
    pub checkpoint: Rect,
    pub conflict: Rect,
    pub input: Rect,
    pub status: Rect,
}

pub fn layout_areas(area: Rect, panels: &PanelLayoutState) -> ChromeAreas {
    let header_h = panels.header_height.clamp(1, 5);
    let input_h = panels.input_height.clamp(2, 10);
    let footer_h = panels.footer_height.clamp(1, 3);
    let tabbar_h = 1;
    let checkpoint_h = 1;
    let conflict_h = 1;
    let fixed = header_h
        .saturating_add(tabbar_h)
        .saturating_add(checkpoint_h)
        .saturating_add(conflict_h)
        .saturating_add(input_h)
        .saturating_add(footer_h);
    let content_h = area.h.saturating_sub(fixed);

    let mut y = area.y;
    let mut take = |height: u16| {
        let available = area.bottom().saturating_sub(y);
        let height = height.min(available);
        let rect = Rect::new(area.x, y, area.w, height);
        y = y.saturating_add(height);
        rect
    };

    let header = take(header_h);
    let tabbar = take(tabbar_h);
    let content = take(content_h);
    let checkpoint = take(checkpoint_h);
    let conflict = take(conflict_h);
    let input = take(input_h);
    let status = take(footer_h);

    ChromeAreas {
        header,
        tabbar,
        content,
        checkpoint,
        conflict,
        input,
        status,
    }
}

pub fn render(canvas: &mut Canvas, state: &mut AppState) -> (u16, u16) {
    canvas.clear();
    let area = canvas.area();
    register_hit_regions(state, area);

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
    let areas = layout_areas(area, &state.panels);

    canvas.with_clip(areas.header, |canvas| header::render(canvas, areas.header, state));
    canvas.with_clip(areas.tabbar, |canvas| tabbar::render(canvas, areas.tabbar, state));

    canvas.with_clip(areas.content, |canvas| match state.active_tab {
        TabId::Focus     => render_focus(canvas, areas.content, state),
        TabId::Plan      => plan_layout::render(canvas, areas.content, state),
        TabId::Code      => code_layout::render(canvas, areas.content, state),
        TabId::Review    => review_layout::render(canvas, areas.content, state),
        TabId::Dashboard => dashboard_layout::render(canvas, areas.content, state),
    });

    canvas.with_clip(areas.checkpoint, |canvas| checkpoint_bar::render(canvas, areas.checkpoint, state));
    canvas.with_clip(areas.conflict, |canvas| conflict_bar::render(canvas, areas.conflict, state));
    canvas.with_clip(areas.input, |canvas| input::render(canvas, areas.input, state));
    canvas.with_clip(areas.status, |canvas| statusbar::render(canvas, areas.status, state));

    areas.input
}

fn register_hit_regions(state: &mut AppState, area: Rect) {
    state.hit_map.clear();
    let areas = layout_areas(area, &state.panels);

    register_chrome_regions(state, areas);

    for (tab, rect) in tabbar::tab_regions(areas.tabbar, state) {
        state.hit_map.push(MouseRegion::new(
            format!("tab:{}", tab.label().to_ascii_lowercase()),
            rect,
            10,
            HitAction::ActivateTab(tab.label().to_ascii_lowercase()),
        ));
    }

    state.hit_map.push(MouseRegion::new(
        format!("scroll:{}", state.active_tab.label().to_ascii_lowercase()),
        areas.content,
        0,
        HitAction::Scroll {
            target: state.active_tab.label().to_ascii_lowercase(),
        },
    ));

    register_split_regions(state, areas.content);
}

fn register_chrome_regions(state: &mut AppState, areas: ChromeAreas) {
    if areas.header.h > 0 {
        state.hit_map.push(MouseRegion::new(
            "chrome:header",
            Rect::new(areas.header.x, areas.header.bottom().saturating_sub(1), areas.header.w, 1),
            15,
            HitAction::ResizeSplit { id: "chrome:header".to_string() },
        ));
    }
    if areas.input.h > 0 {
        state.hit_map.push(MouseRegion::new(
            "chrome:input",
            Rect::new(areas.input.x, areas.input.y, areas.input.w, 1),
            15,
            HitAction::ResizeSplit { id: "chrome:input".to_string() },
        ));
    }
    if areas.status.h > 0 {
        state.hit_map.push(MouseRegion::new(
            "chrome:footer",
            Rect::new(areas.status.x, areas.status.y, areas.status.w, 1),
            15,
            HitAction::ResizeSplit { id: "chrome:footer".to_string() },
        ));
    }
}

fn register_split_regions(state: &mut AppState, content_area: Rect) {
    match state.active_tab {
        TabId::Code => {
            let main_split = SplitPane::new(
                Axis::Horizontal,
                vec![
                    Constraint::Percent(state.panels.code_main_percent),
                    Constraint::Fill(1),
                ],
            );
            let (cols, handles) = split_panes(content_area, &main_split);
            if let Some(handle) = handles.first().copied() {
                state.hit_map.push(MouseRegion::new(
                    "split:code:main",
                    handle,
                    20,
                    HitAction::ResizeSplit { id: "code:main".to_string() },
                ));
            }

            if let Some(right) = cols.get(1).copied().filter(|area| area.h > 10) {
                let workers_h = right.h * state.panels.code_workers_percent / 100;
                let workers_split = SplitPane::new(
                    Axis::Vertical,
                    vec![Constraint::Fixed(workers_h), Constraint::Fill(1)],
                );
                let (_, handles) = split_panes(right, &workers_split);
                if let Some(handle) = handles.first().copied() {
                    state.hit_map.push(MouseRegion::new(
                        "split:code:workers",
                        handle,
                        20,
                        HitAction::ResizeSplit { id: "code:workers".to_string() },
                    ));
                }
            }
        }
        TabId::Plan => {
            let main_split = SplitPane::new(
                Axis::Horizontal,
                vec![
                    Constraint::Percent(state.panels.plan_main_percent),
                    Constraint::Fill(1),
                ],
            );
            let (cols, handles) = split_panes(content_area, &main_split);
            if let Some(handle) = handles.first().copied() {
                state.hit_map.push(MouseRegion::new(
                    "split:plan:main",
                    handle,
                    20,
                    HitAction::ResizeSplit { id: "plan:main".to_string() },
                ));
            }

            if let Some(right) = cols.get(1).copied() {
                let right_split = SplitPane::new(
                    Axis::Vertical,
                    vec![
                        Constraint::Percent(state.panels.plan_right_percent),
                        Constraint::Fill(1),
                    ],
                );
                let (_, handles) = split_panes(right, &right_split);
                if let Some(handle) = handles.first().copied() {
                    state.hit_map.push(MouseRegion::new(
                        "split:plan:right",
                        handle,
                        20,
                        HitAction::ResizeSplit { id: "plan:right".to_string() },
                    ));
                }
            }
        }
        _ => {}
    }
}

fn render_focus(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // Welcome se maneja como overlay en render() — aquí siempre history
    history::render(canvas, area, state);
}

fn content_area_for_popup(area: Rect, _state: &AppState) -> Rect {
    layout_areas(area, &_state.panels).content
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
