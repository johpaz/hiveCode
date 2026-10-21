use crate::{
    state::{AppState, ModalState, PanelLayoutState, TabId},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, BG_MAIN, DIM},
    ui::{split_panes, truncate_cells, Axis, Constraint, HitAction, MouseRegion, SplitPane},
    widgets::{
        activity_toast, agent_card, checkpoint_bar, code_layout, command_popup, config_modal,
        conflict_bar,
        dashboard_layout, focus_layout, header, info_modal, input, logs_panel,
        plan_approval_modal, plan_layout, review_layout, settings_hub, statusbar, tabbar, tool_approval_modal,
        welcome,
    },
};
#[cfg(not(test))]
use crate::clipboard;

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

/// Por debajo de esto los layouts no caben: el chrome solo ya consume ~10 filas y
/// las columnas de Plan/Code/Review necesitan ancho para no quedar en jirones.
const MIN_COLS: u16 = 100;
const MIN_ROWS: u16 = 24;

pub fn layout_for_state(area: Rect, state: &AppState) -> ChromeAreas {
    let mut panels = state.panels.clone();
    if state.active_tab == TabId::Swarm && area.h < MIN_ROWS {
        panels.header_height = 1;
        panels.input_height = 2;
        panels.footer_height = 1;
    }
    let mut chrome = layout_areas(area, &panels);
    // Swarm already renders its checkpoint strip and actions inside the dashboard.
    if state.active_tab == TabId::Swarm && state.dashboard.resume.is_none() {
        chrome.content.h += chrome.checkpoint.h;
        chrome.checkpoint.y += chrome.checkpoint.h;
        chrome.checkpoint.h = 0;
    }
    chrome
}

pub fn render(canvas: &mut Canvas, state: &mut AppState) -> (u16, u16) {
    canvas.clear();
    let area = canvas.area();

    let compact_office = state.active_tab == TabId::Swarm && area.w >= 20 && area.h >= 10;
    if (area.w < MIN_COLS || area.h < MIN_ROWS) && !compact_office {
        state.hit_map.clear();
        render_too_small(canvas, area);
        return (0, 0);
    }

    register_hit_regions(state, area);

    let input_area = render_main(canvas, area, state);

    // Apply selection highlight after all content is rendered
    let content_area = content_area_for_popup(area, state);
    apply_selection_highlight(canvas, state, content_area);

    // La bienvenida se pinta encima de todo: ahí la copia se resuelve después de dibujarla.
    let welcome_active = state.show_welcome && state.history.entries.is_empty();
    if !welcome_active {
        run_pending_copy(canvas, state, content_area);
    }

    // Welcome fullscreen overlay — cubre todo (header, tabbar, contenido, input)
    if state.show_welcome && state.history.entries.is_empty() {
        welcome::render(canvas, area, state);
        // La ficha va ENCIMA del welcome: si el usuario la abre con `i` sin
        // haber escrito nada, espera una respuesta, no otra pantalla de bienvenida.
        if state.ficha_agent.is_some() {
            agent_card::render_overlay(canvas, area, state);
        }
        // Un modal abierto desde la bienvenida (F2, Ctrl+S) recibe las teclas: si no se dibuja,
        // la pantalla parece congelada y la siguiente tecla cierra algo que nadie ve.
        render_modal(canvas, area, state);
        run_pending_copy(canvas, state, content_area);
        return (0, 0);
    }

    // Popup de comandos: flota justo encima del input
    if state.input.value().starts_with('/')
        && !matches!(state.modal, ModalState::Config(_) | ModalState::Info(_) | ModalState::PlanApproval(_) | ModalState::ReviewConfirm(_) | ModalState::Settings(_) | ModalState::ToolApproval(_)) {
        let history_area = content_area_for_popup(area, state);
        command_popup::render(canvas, history_area, state);
    }

    // Modales: overlays sobre todo
    render_modal(canvas, area, state);

    // `/logs` — overlay sobre el área de contenido. Antes las entradas se
    // acumulaban en `state.logs` sin que ningún widget las leyera.
    if state.logs.visible {
        let areas = layout_for_state(area, state);
        logs_panel::render(canvas, areas.content, state);
    }

    // Ficha del especialista — overlay centrado. Responde "¿qué sabe hacer este
    // y qué puede pedirle?".
    if state.ficha_agent.is_some() {
        agent_card::render_overlay(canvas, area, state);
    }

    cursor_position(state, input_area)
}

/// Ejecuta la copia pedida por el controlador (necesita el canvas ya dibujado para leer el texto).
fn run_pending_copy(canvas: &Canvas, state: &mut AppState, content_area: Rect) {
    if state.pending_copy_request {
        if let Some(ref sel) = state.selection {
            let text = selected_text(canvas, sel, content_area);
            if !text.trim().is_empty() {
                #[cfg(not(test))]
                {
                    state.clipboard_notice = Some((match clipboard::copy_text(&text) {
                        Ok(()) => format!("✓ copiado ({} caracteres)", text.chars().count()),
                        Err(e) => format!("✗ no se pudo copiar: {e}"),
                    }, std::time::Instant::now()));
                }
            }
        }
        state.pending_copy_request = false;
    }
}

/// Mensaje explícito en vez de dibujar un layout ilegible. Dice el tamaño actual y
/// el mínimo, para que el usuario sepa cuánto le falta.
fn render_too_small(canvas: &mut Canvas, area: Rect) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_MAIN));
    if area.h == 0 || area.w == 0 {
        return;
    }
    let lines = [
        ("⬡ hiveCode", Style::new().fg(AMBER_BRIGHT).bold().bg(BG_MAIN)),
        ("", Style::new().bg(BG_MAIN)),
        ("terminal demasiado pequeña", Style::new().fg(AMBER).bg(BG_MAIN)),
    ];
    let detail = format!("{}x{} · mínimo {}x{}", area.w, area.h, MIN_COLS, MIN_ROWS);
    let start_y = area.y + area.h.saturating_sub(4) / 2;

    for (idx, (text, style)) in lines.iter().enumerate() {
        let y = start_y + idx as u16;
        if y >= area.bottom() || text.is_empty() {
            continue;
        }
        canvas.print_centered(area.x, y, area.w, &truncate_cells(text, area.w as usize), *style);
    }
    let y = start_y + lines.len() as u16;
    if y < area.bottom() {
        canvas.print_centered(
            area.x,
            y,
            area.w,
            &truncate_cells(&detail, area.w as usize),
            Style::new().fg(DIM).bg(BG_MAIN),
        );
    }
}

fn render_main(canvas: &mut Canvas, area: Rect, state: &AppState) -> Rect {
    let areas = layout_for_state(area, state);

    canvas.with_clip(areas.header, |canvas| header::render(canvas, areas.header, state));
    canvas.with_clip(areas.tabbar, |canvas| tabbar::render(canvas, areas.tabbar, state));

    canvas.with_clip(areas.content, |canvas| match state.active_tab {
        TabId::Mesa     => render_focus(canvas, areas.content, state),
        TabId::Plan      => plan_layout::render(canvas, areas.content, state),
        TabId::Code      => code_layout::render(canvas, areas.content, state),
        TabId::Review    => review_layout::render(canvas, areas.content, state),
        TabId::Swarm     => dashboard_layout::render(canvas, areas.content, state),
    });

    canvas.with_clip(areas.checkpoint, |canvas| checkpoint_bar::render(canvas, areas.checkpoint, state));
    canvas.with_clip(areas.conflict, |canvas| conflict_bar::render(canvas, areas.conflict, state));

    // Activity toast flotante justo encima del input mientras responde
    if state.running {
        let toast_h = 2u16;
        let toast_y = areas.input.y.saturating_sub(toast_h);
        if toast_y < area.bottom() && toast_y < areas.input.y {
            let toast_w = (areas.input.w * 4 / 5).max(20).min(areas.input.w);
            let toast_x = areas.input.x + (areas.input.w.saturating_sub(toast_w)) / 2;
            let toast_area = Rect::new(toast_x, toast_y, toast_w, toast_h);
            canvas.with_clip(toast_area, |canvas| activity_toast::render(canvas, toast_area, state));
        }
    }

    canvas.with_clip(areas.input, |canvas| input::render(canvas, areas.input, state));
    canvas.with_clip(areas.status, |canvas| statusbar::render(canvas, areas.status, state));

    areas.input
}

/// Dibuja el modal activo, si lo hay, encima de lo que haya debajo.
fn render_modal(canvas: &mut Canvas, area: Rect, state: &mut AppState) {
    match &state.modal {
        ModalState::Config(_)    => config_modal::render(canvas, area, state),
        ModalState::Info(_)      => info_modal::render(canvas, area, state),
        ModalState::Settings(_)  => settings_hub::render(canvas, area, state, true),
        // PlanApproval se integra como strip dentro de plan_layout cuando estamos en Plan tab.
        // Para otros tabs se muestra como overlay centrado (caso raro pero posible).
        ModalState::PlanApproval(_) if state.active_tab == TabId::Plan => {}
        ModalState::PlanApproval(_) => plan_approval_modal::render(canvas, area, state),
        ModalState::ReviewConfirm(_) => {}
        ModalState::ToolApproval(_) => tool_approval_modal::render(canvas, area, state),
        ModalState::None         => {}
    }
}

fn register_hit_regions(state: &mut AppState, area: Rect) {
    state.hit_map.clear();
    let areas = layout_for_state(area, state);

    register_chrome_regions(state, areas);
    if state.active_tab == TabId::Swarm {
        dashboard_layout::register_office_hits(state, areas.content);
    }

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
        TabId::Review => {
            let main_split = SplitPane::new(
                Axis::Horizontal,
                vec![
                    Constraint::Percent(state.panels.review_main_percent),
                    Constraint::Fill(1),
                ],
            );
            let (cols, handles) = split_panes(content_area, &main_split);
            if let Some(handle) = handles.first().copied() {
                state.hit_map.push(MouseRegion::new(
                    "split:review:main",
                    handle,
                    20,
                    HitAction::ResizeSplit { id: "review:main".to_string() },
                ));
            }

            if let Some(right) = cols.get(1).copied() {
                let right_split = SplitPane::new(
                    Axis::Vertical,
                    vec![
                        Constraint::Percent(state.panels.review_right_percent),
                        Constraint::Fill(1),
                    ],
                );
                let (_, handles) = split_panes(right, &right_split);
                if let Some(handle) = handles.first().copied() {
                    state.hit_map.push(MouseRegion::new(
                        "split:review:right",
                        handle,
                        20,
                        HitAction::ResizeSplit { id: "review:right".to_string() },
                    ));
                }
            }
        }
        _ => {}
    }
}

fn render_focus(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // Welcome se maneja como overlay en render() — aquí siempre history
    focus_layout::render(canvas, area, state);
}

/// The rows and columns a selection covers, kept inside the pane where the drag began.
///
/// Returns `(y, x0, x1)` per row. The first row starts at the anchor's column, the last ends at the
/// pointer's, the rows between take the whole pane width.
fn selection_spans(canvas: &Canvas, sel: &crate::state::Selection, content: Rect) -> Vec<(u16, u16, u16)> {
    if content.w == 0 || content.h == 0 {
        return Vec::new();
    }
    let max_x = content.right().saturating_sub(1);
    let (left, right) = canvas.pane_columns(sel.anchor.0, sel.anchor.1, content.x, max_x);
    let clamp = |x: u16| x.clamp(left, right);
    let (a, b) = ((clamp(sel.anchor.0), sel.anchor.1), (clamp(sel.cursor.0), sel.cursor.1));
    let ((start_x, start_y), (end_x, end_y)) = if a.1 < b.1 || (a.1 == b.1 && a.0 <= b.0) { (a, b) } else { (b, a) };
    let mut spans = Vec::new();
    for y in start_y..=end_y {
        if y >= canvas.h { break; }
        let x0 = if y == start_y { start_x } else { left };
        let x1 = if y == end_y { end_x } else { right };
        spans.push((y, x0, x1));
    }
    spans
}

fn apply_selection_highlight(canvas: &mut Canvas, state: &AppState, content: Rect) {
    let Some(ref sel) = state.selection else { return; };
    for (y, x0, x1) in selection_spans(canvas, sel, content) {
        for x in x0..=x1 {
            if let Some(cell) = canvas.cell_mut(x, y) {
                if cell.ch != '\0' {
                    cell.style.bg = crossterm::style::Color::DarkGrey;
                }
            }
        }
    }
}

/// What the selection says, as plain text, one line per row.
fn selected_text(canvas: &Canvas, sel: &crate::state::Selection, content: Rect) -> String {
    selection_spans(canvas, sel, content)
        .into_iter()
        .map(|(y, x0, x1)| canvas.row_text(y, x0, x1))
        .collect::<Vec<_>>()
        .join("\n")
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


#[cfg(test)]
mod selection_tests {
    use super::*;
    use crate::state::Selection;
    use crate::term::Style;

    /// Two panes side by side, a `│` between them, each with its own text on the same rows.
    fn two_panes() -> (Canvas, Rect) {
        let mut canvas = Canvas::new(40, 4);
        for y in 0..4u16 {
            canvas.print(0, y, &format!("izq-linea-{y}"), Style::new());
            canvas.print(20, y, "│", Style::new());
            canvas.print(22, y, &format!("der-linea-{y}"), Style::new());
        }
        (canvas, Rect::new(0, 0, 40, 4))
    }

    fn sel(a: (u16, u16), c: (u16, u16)) -> Selection {
        Selection { anchor: a, cursor: c, active: false }
    }

    #[test]
    fn a_selection_in_the_left_pane_never_takes_the_right_pane() {
        let (canvas, content) = two_panes();
        // Drag from the start of row 0 to far into the right pane on row 2.
        let text = selected_text(&canvas, &sel((0, 0), (35, 2)), content);
        assert_eq!(text, "izq-linea-0\nizq-linea-1\nizq-linea-2");
        assert!(!text.contains("der-"));
    }

    #[test]
    fn a_selection_in_the_right_pane_never_takes_the_left_pane() {
        let (canvas, content) = two_panes();
        let text = selected_text(&canvas, &sel((22, 1), (0, 3)), content);
        assert!(text.contains("der-linea-"), "{text}");
        assert!(!text.contains("izq-"), "{text}");
        assert!(!text.contains('│'), "the divider is not part of the text: {text}");
    }

    #[test]
    fn a_selection_within_one_row_is_the_exact_slice() {
        let (canvas, content) = two_panes();
        assert_eq!(selected_text(&canvas, &sel((4, 1), (8, 1)), content), "linea");
    }

    #[test]
    fn without_a_divider_the_pane_is_the_whole_content() {
        let mut canvas = Canvas::new(30, 2);
        canvas.print(0, 0, "una linea", Style::new());
        canvas.print(0, 1, "otra linea", Style::new());
        assert_eq!(selected_text(&canvas, &sel((0, 0), (9, 1)), Rect::new(0, 0, 30, 2)), "una linea\notra linea");
    }
}
