#[cfg(not(test))]
use std::io::{stdout, Write};

#[cfg(not(test))]
use base64::Engine as _;

#[cfg(not(test))]
use arboard::Clipboard;
use crossterm::{
    event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    terminal,
};

use crate::{
    ipc::TuiMessage,
    state::{AppState, HistoryEntry, InfoModalState, ModalFieldKind, ModalState, ReplMode, Role, TabId},
    widgets::{command_popup, history, tabbar},
};

pub fn handle_key_event(state: &mut AppState, key: KeyEvent) -> bool {
    if key.kind != KeyEventKind::Press {
        return false;
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return true;
    }

    // ── Modal de config activo ─────────────────────────────────────────────────
    if matches!(state.modal, ModalState::Config(_)) {
        // Ctrl+V o Ctrl+Shift+V → leer directamente del portapapeles del sistema
        let is_paste_key = key.modifiers.contains(KeyModifiers::CONTROL)
            && (key.code == KeyCode::Char('v') || key.code == KeyCode::Char('V'));
        if is_paste_key {
            paste_from_clipboard(state);
            return false;
        }
        handle_config_modal_key(state, key.code);
        return false;
    }

    // ── Modal de info activo ───────────────────────────────────────────────────
    if let ModalState::Info(info) = &mut state.modal {
        match key.code {
            KeyCode::Esc => {
                state.modal = ModalState::None;
                state.pending_ipc.push(TuiMessage::InfoModalClose);
            }
            KeyCode::Up   => { info.scroll = info.scroll.saturating_sub(1); }
            KeyCode::Down => { info.scroll += 1; }
            _ => {}
        }
        return false;
    }

    // ── Modal de aprobación del plan ───────────────────────────────────────────
    if let ModalState::PlanApproval(approval) = &mut state.modal {
        match key.code {
            KeyCode::Esc => {
                state.modal = ModalState::None;
                // Cancel = send "n" so pendingPlanTask sees it as rejection
                state.pending_ipc.push(TuiMessage::Submit { input: "n".to_string() });
            }
            KeyCode::Up => {
                approval.selected = approval.selected.saturating_sub(1);
                state.dirty.full = true;
            }
            KeyCode::Down => {
                approval.selected = (approval.selected + 1).min(3);
                state.dirty.full = true;
            }
            KeyCode::Enter => {
                let selected = approval.selected;
                state.modal = ModalState::None;
                let input = match selected {
                    0 => "/approve auto".to_string(),
                    1 => "/approve review".to_string(),
                    2 => "__plan_suggest__".to_string(), // signals: focus input for context
                    _ => "n".to_string(),
                };
                if input == "__plan_suggest__" {
                    // Don't send a message — just close modal and let user type
                } else {
                    state.pending_ipc.push(TuiMessage::Submit { input });
                }
                state.dirty.full = true;
            }
            _ => {}
        }
        return false;
    }

    // ── Popup de comandos / activo ─────────────────────────────────────────────
    if state.input.value().starts_with('/') && !state.history_nav_mode {
        match key.code {
            KeyCode::Esc => {
                state.input.clear();
                state.command_popup_selected = 0;
                return false;
            }
            KeyCode::Up => {
                state.command_popup_selected = state.command_popup_selected.saturating_sub(1);
                return false;
            }
            KeyCode::Down => {
                let max = command_popup::filtered(state.input.value()).len().saturating_sub(1);
                state.command_popup_selected = (state.command_popup_selected + 1).min(max);
                return false;
            }
            KeyCode::Tab => {
                // Autocompletar con el comando seleccionado
                let filtered = command_popup::filtered(state.input.value());
                if let Some(cmd) = filtered.get(state.command_popup_selected) {
                    state.input.set(cmd.cmd);
                }
                return false;
            }
            KeyCode::Enter => {
                // Autocomplete al item seleccionado del popup antes de ejecutar.
                // Esto permite que el usuario navegue con ↑↓ y pulse Enter directamente
                // sin necesidad de Tab previo.
                {
                    let filtered_items = command_popup::filtered(state.input.value());
                    if let Some(selected_cmd) = filtered_items.get(state.command_popup_selected) {
                        state.input.set(selected_cmd.cmd);
                    }
                }
                let raw = state.input.value().trim().to_string();
                let mut parts = raw.splitn(2, ' ');
                let cmd = parts.next().unwrap_or("");
                let arg = parts.next().unwrap_or("").trim();
                state.input.clear();
                state.command_popup_selected = 0;
                match cmd {
                    "/help" => {
                        state.modal = ModalState::Info(InfoModalState {
                            title: "Comandos disponibles".to_string(),
                            content: help_text(),
                            scroll: 0,
                        });
                        return false;
                    }
                    "/logs" if arg.is_empty() => {
                        state.logs.visible = !state.logs.visible;
                        return false;
                    }
                    "/clear" => {
                        state.history.entries.clear();
                        state.history.selected = None;
                        return false;
                    }
                    "/quit" | "/exit" => {
                        return true; // app.rs envía TuiMessage::Exit
                    }
                    "/mode" => {
                        let new_mode = if arg.is_empty() {
                            state.session.mode.next()
                        } else {
                            ReplMode::from(arg)
                        };
                        state.session.mode = new_mode;
                        state.dirty.session = true;
                        state.pending_ipc.push(TuiMessage::ModeChange {
                            mode: state.session.mode.as_str().to_string(),
                        });
                        return false;
                    }
                    "/timeline" => {
                        state.show_workers = !state.show_workers;
                        return false;
                    }
                    "/copy" => {
                        state.history_nav_mode = true;
                        if !state.history.entries.is_empty() {
                            state.history.selected =
                                Some(state.history.entries.len().saturating_sub(1));
                        }
                        return false;
                    }
                    "/layout" => {
                        if let Some(tab) = TabId::from_name(arg) {
                            state.active_tab = tab;
                        } else if let Ok(n) = arg.parse::<u8>() {
                            if let Some(tab) = TabId::from_num(n) {
                                state.active_tab = tab;
                            }
                        }
                        return false;
                    }
                    "/welcome" => {
                        state.show_welcome = true;
                        state.active_tab = TabId::Focus;
                        return false;
                    }
                    _ => {
                        // Todos los demás (/provider, /modelo, /github, /telegram…) → Bun.
                        // Poner el comando completo en el input y dejar caer al Enter principal.
                        state.input.set(&raw);
                    }
                }
            }
            KeyCode::Char(c) => {
                state.input.insert(c);
                state.command_popup_selected = 0;
                return false;
            }
            KeyCode::Backspace => {
                state.input.backspace();
                state.command_popup_selected = 0;
                return false;
            }
            _ => {}
        }
    }

    // Mientras welcome visible: 1-5 dismiss + cambiar tab; Esc solo dismiss
    if state.show_welcome && state.history.entries.is_empty() {
        if let (KeyModifiers::NONE, KeyCode::Char(n @ '1'..='5')) = (key.modifiers, key.code) {
            state.show_welcome = false;
            if let Some(tab) = TabId::from_num(n as u8 - b'0') {
                state.active_tab = tab;
            }
            return false;
        }
        if key.code == KeyCode::Esc {
            state.show_welcome = false;
            return false;
        }
    }

    match (key.modifiers, key.code) {
        // Teclas 1-5 cambian de tab (solo cuando no se está escribiendo)
        (KeyModifiers::NONE, KeyCode::Char(n @ '1'..='5')) if state.input.value().is_empty() && !state.history_nav_mode => {
            if let Some(tab) = TabId::from_num(n as u8 - b'0') {
                state.active_tab = tab;
                state.tab_locked = true;  // inhibe auto-routing hasta siguiente tarea
            }
        }
        (_, KeyCode::Esc) => {
            state.history_nav_mode = false;
            state.history_hscroll = 0;
        }
        (_, KeyCode::Home) if state.history_nav_mode => {
            if !state.history.entries.is_empty() {
                persist_hscroll_for_selected(state);
                state.history.selected = Some(0);
                state.history.scroll = 0;
                restore_hscroll_for_selected(state);
            }
        }
        (_, KeyCode::End) if state.history_nav_mode => {
            if !state.history.entries.is_empty() {
                persist_hscroll_for_selected(state);
                state.history.selected = Some(state.history.entries.len().saturating_sub(1));
                state.history.scroll = 0;
                restore_hscroll_for_selected(state);
            }
        }
        (_, KeyCode::Tab) => {
            state.history_nav_mode = !state.history_nav_mode;
            if !state.history_nav_mode {
                state.history_hscroll = 0;
            }
            if state.history_nav_mode && !state.history.entries.is_empty() {
                if state.history.selected.is_none() {
                    state.history.selected = Some(state.history.entries.len().saturating_sub(1));
                }
                restore_hscroll_for_selected(state);
            }
        }
        (_, KeyCode::BackTab) => {
            state.session.mode = state.session.mode.next();
            state.dirty.session = true;
            state.pending_ipc.push(TuiMessage::ModeChange {
                mode: state.session.mode.as_str().to_string(),
            });
        }
        (m, KeyCode::Left) if state.history_nav_mode && m.contains(KeyModifiers::SHIFT) => {
            state.history_hscroll = state.history_hscroll.saturating_sub(2);
            persist_hscroll_for_selected(state);
        }
        (m, KeyCode::Right) if state.history_nav_mode && m.contains(KeyModifiers::SHIFT) => {
            state.history_hscroll = state.history_hscroll.saturating_add(2).min(5000);
            persist_hscroll_for_selected(state);
        }
        (_, KeyCode::PageUp) if state.active_tab == TabId::Focus && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_sub(5);
        }
        (_, KeyCode::PageDown) if state.active_tab == TabId::Focus && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_add(5);
        }
        (_, KeyCode::PageUp) if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_sub(5);
        }
        (_, KeyCode::PageDown) if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_add(5);
        }
        (_, KeyCode::PageUp) => {
            move_history_selection(state, -5);
        }
        (_, KeyCode::PageDown) => {
            move_history_selection(state, 5);
        }
        (m, KeyCode::Char('l')) if m.contains(KeyModifiers::CONTROL) => {
            if state.history.entries.is_empty() {
                return false;
            }
            let idx = state
                .history
                .selected
                .unwrap_or_else(|| state.history.entries.len().saturating_sub(1));
            if let Some(entry) = state.history.entries.get(idx) {
                state.input.set(&entry.content);
            }
        }
        (m, KeyCode::Char('y')) if m.contains(KeyModifiers::CONTROL) => {
            copy_selected_entry_to_clipboard(state);
        }
        (m, KeyCode::Up) if m.contains(KeyModifiers::CONTROL) => {
            move_history_selection(state, -1);
        }
        (m, KeyCode::Down) if m.contains(KeyModifiers::CONTROL) => {
            move_history_selection(state, 1);
        }
        (m, KeyCode::Left) if m.contains(KeyModifiers::CONTROL) => state.input.move_word_left(),
        (m, KeyCode::Right) if m.contains(KeyModifiers::CONTROL) => state.input.move_word_right(),
        (_, KeyCode::Left) if !state.history_nav_mode => state.input.move_left(),
        (_, KeyCode::Right) if !state.history_nav_mode => state.input.move_right(),
        (_, KeyCode::Home) if !state.history_nav_mode => state.input.move_home(),
        (_, KeyCode::End) if !state.history_nav_mode => state.input.move_end(),
        (_, KeyCode::Backspace) if !state.history_nav_mode => state.input.backspace(),
        (_, KeyCode::Delete) if !state.history_nav_mode => state.input.delete_forward(),
        (_, KeyCode::Up) if !state.history_nav_mode => state.input.history_up(),
        (_, KeyCode::Down) if !state.history_nav_mode => state.input.history_down(),
        (_, KeyCode::Enter) => {
            // Salir de la pantalla de bienvenida con Enter (input vacío)
            if state.show_welcome && state.history.entries.is_empty() && state.input.value().is_empty() {
                state.show_welcome = false;
            } else if state.history_nav_mode {
                if let Some(idx) = state.history.selected {
                    if let Some(entry) = state.history.entries.get(idx) {
                        state.input.set(&entry.content);
                    }
                }
                state.history_nav_mode = false;
            } else {
                let submitted = state.input.submit();
                if !submitted.trim().is_empty() {
                    state.show_welcome = false; // entrar al chat al enviar el primer mensaje
                    if state.session.mode == ReplMode::Plan {
                        state.plan.current = None;
                        state.plan.scroll = 0;
                    }
                    state.history.entries.push(HistoryEntry {
                        role: Role::User,
                        content: submitted,
                        agent: None,
                        timestamp: None,
                    });
                    state.history.scroll = 0;
                    state.history.selected = Some(state.history.entries.len().saturating_sub(1));
                    restore_hscroll_for_selected(state);
                }
            }
        }
        // Scroll ADR en Review tab (↑↓ cuando input vacío y en Review)
        (_, KeyCode::Up) if state.active_tab == TabId::Review && state.input.value().is_empty() => {
            state.adrs.scroll = state.adrs.scroll.saturating_sub(1);
        }
        (_, KeyCode::Down) if state.active_tab == TabId::Review && state.input.value().is_empty() => {
            state.adrs.scroll += 1;
        }
        // Navegar entre ADRs en Review tab ([ y ])
        (_, KeyCode::Char('[')) if state.active_tab == TabId::Review => {
            if state.adrs.selected > 0 {
                state.adrs.selected -= 1;
                state.adrs.scroll = 0;
            }
        }
        (_, KeyCode::Char(']')) if state.active_tab == TabId::Review => {
            if !state.adrs.entries.is_empty() {
                state.adrs.selected = (state.adrs.selected + 1).min(state.adrs.entries.len().saturating_sub(1));
                state.adrs.scroll = 0;
            }
        }
        // Tipear un carácter siempre sale del modo nav y escribe en el input
        (_, KeyCode::Char(c)) => {
            state.history_nav_mode = false;
            state.history_hscroll = 0;
            state.input.insert(c);
        }
        _ => {}
    }

    false
}

pub fn handle_mouse_event(state: &mut AppState, mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::ScrollUp if state.active_tab == TabId::Focus && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Focus && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_add(3);
        }
        MouseEventKind::ScrollUp if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_add(3);
        }
        MouseEventKind::ScrollUp => {
            state.history_nav_mode = true;
            move_history_selection(state, -1);
        }
        MouseEventKind::ScrollDown => {
            state.history_nav_mode = true;
            move_history_selection(state, 1);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            // Click en la fila del tabbar (fila 2 — header ocupa 2 filas)
            if mouse.row == 2 {
                if let Some((w, _h)) = terminal::size().ok() {
                    let tabbar_area = crate::term::Rect::new(0, 2, w, 1);
                    if let Some(tab) = tabbar::tab_at_col(tabbar_area, mouse.column) {
                        state.active_tab = tab;
                        if tab != TabId::Focus {
                            state.history_nav_mode = false;
                            state.history_hscroll = 0;
                        }
                        state.show_welcome = false;
                        return;
                    }
                }
            }
            let history_area = history_rect_from_size(terminal::size().ok());
            if state.active_tab == TabId::Focus {
                if let Some(area) = history_area {
                    if let Some(entry_idx) = history::entry_at_y(state, area, mouse.row) {
                        persist_hscroll_for_selected(state);
                        state.history_nav_mode = true;
                        state.history.selected = Some(entry_idx);
                        state.history.scroll = 0;
                        restore_hscroll_for_selected(state);
                    }
                }
            }
        }
        MouseEventKind::Down(MouseButton::Right) => {
            let history_area = history_rect_from_size(terminal::size().ok());
            if state.active_tab == TabId::Focus {
                if let Some(area) = history_area {
                    if let Some(entry_idx) = history::entry_at_y(state, area, mouse.row) {
                        persist_hscroll_for_selected(state);
                        state.history.selected = Some(entry_idx);
                        state.history.scroll = 0;
                        restore_hscroll_for_selected(state);
                        if let Some(entry) = state.history.entries.get(entry_idx) {
                            state.input.set(&entry.content);
                            state.history_nav_mode = false;
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn history_rect_from_size(size: Option<(u16, u16)>) -> Option<crate::term::Rect> {
    #[cfg(test)]
    let (w, h) = size.unwrap_or((80, 24));

    #[cfg(not(test))]
    let (w, h) = size?;

    let area = crate::term::Rect::new(0, 0, w, h);
    // Layout: header(2) + tabbar(1) + content(fill) + checkpoint(1) + conflict(1) + input(4) + statusbar(1)
    let vertical = area.vsplit(&[2, 1, 0, 1, 1, 4, 1]);
    vertical.get(2).copied()
}

fn move_history_selection(state: &mut AppState, delta: isize) {
    if state.history.entries.is_empty() {
        return;
    }

    let len = state.history.entries.len();
    let current = state
        .history
        .selected
        .unwrap_or_else(|| len.saturating_sub(1));
    persist_hscroll_for_selected(state);

    let next = if delta.is_negative() {
        current.saturating_sub(delta.unsigned_abs())
    } else {
        current.saturating_add(delta as usize).min(len.saturating_sub(1))
    };

    state.history.selected = Some(next);
    state.history.scroll = 0;
    restore_hscroll_for_selected(state);
}

fn persist_hscroll_for_selected(state: &mut AppState) {
    if let Some(selected) = state.history.selected {
        state
            .history_hscroll_per_entry
            .insert(selected, state.history_hscroll);
    }
}

fn restore_hscroll_for_selected(state: &mut AppState) {
    if let Some(selected) = state.history.selected {
        state.history_hscroll = state
            .history_hscroll_per_entry
            .get(&selected)
            .copied()
            .unwrap_or(0);
    } else {
        state.history_hscroll = 0;
    }
}

fn copy_selected_entry_to_clipboard(state: &AppState) {
    if state.history.entries.is_empty() {
        return;
    }

    let idx = state
        .history
        .selected
        .unwrap_or_else(|| state.history.entries.len().saturating_sub(1));
    let Some(entry) = state.history.entries.get(idx) else {
        return;
    };

    #[cfg(test)]
    {
        let _ = entry;
        return;
    }

    #[cfg(not(test))]
    let encoded = base64::engine::general_purpose::STANDARD.encode(entry.content.as_bytes());
    #[cfg(not(test))]
    {
        let osc52 = format!("\x1b]52;c;{}\x07", encoded);
        let mut out = stdout();
        let _ = out.write_all(osc52.as_bytes());
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_state_with_entries(n: usize) -> AppState {
        let mut state = AppState::default();
        state.history.entries = (0..n)
            .map(|i| HistoryEntry {
                role: Role::User,
                content: format!("entry-{i}"),
                agent: None,
                timestamp: None,
            })
            .collect();
        state
    }

    #[test]
    fn hscroll_persists_per_selected_entry() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(1);
        state.history_hscroll = 12;
        persist_hscroll_for_selected(&mut state);

        state.history.selected = Some(2);
        state.history_hscroll = 3;
        persist_hscroll_for_selected(&mut state);

        state.history.selected = Some(1);
        restore_hscroll_for_selected(&mut state);
        assert_eq!(state.history_hscroll, 12);

        state.history.selected = Some(2);
        restore_hscroll_for_selected(&mut state);
        assert_eq!(state.history_hscroll, 3);
    }

    #[test]
    fn move_selection_restores_target_hscroll() {
        let mut state = mk_state_with_entries(4);
        state.history.selected = Some(1);
        state.history_hscroll = 9;
        persist_hscroll_for_selected(&mut state);

        state.history.selected = Some(2);
        state.history_hscroll = 2;
        persist_hscroll_for_selected(&mut state);

        state.history.selected = Some(1);
        state.history_hscroll = 9;
        move_history_selection(&mut state, 1);
        assert_eq!(state.history.selected, Some(2));
        assert_eq!(state.history_hscroll, 2);
    }

    #[test]
    fn move_selection_clamps_bounds() {
        let mut state = mk_state_with_entries(2);
        state.history.selected = Some(0);
        move_history_selection(&mut state, -10);
        assert_eq!(state.history.selected, Some(0));

        move_history_selection(&mut state, 10);
        assert_eq!(state.history.selected, Some(1));
    }

    #[test]
    fn tab_toggles_history_nav_mode() {
        let mut state = mk_state_with_entries(1);
        state.history_nav_mode = false;

        let key = KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE);
        let should_quit = handle_key_event(&mut state, key);
        assert!(!should_quit);
        assert!(state.history_nav_mode);

        let key = KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE);
        let _ = handle_key_event(&mut state, key);
        assert!(!state.history_nav_mode);
    }

    #[test]
    fn esc_exits_history_nav_mode() {
        let mut state = mk_state_with_entries(2);
        state.history_nav_mode = true;
        state.history_hscroll = 11;

        let key = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        let should_quit = handle_key_event(&mut state, key);
        assert!(!should_quit);
        assert!(!state.history_nav_mode);
        assert_eq!(state.history_hscroll, 0);
    }

    #[test]
    fn ctrl_l_copies_selected_entry_to_input() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(2);
        state.input.set("draft");

        let key = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
        let should_quit = handle_key_event(&mut state, key);
        assert!(!should_quit);
        assert_eq!(state.input.value(), "entry-2");
    }

    #[test]
    fn ctrl_y_does_not_modify_state_when_selection_exists() {
        let mut state = mk_state_with_entries(2);
        state.history.selected = Some(1);
        state.history_hscroll = 4;
        state.history_nav_mode = true;
        let before_input = state.input.value().to_string();

        let key = KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL);
        let should_quit = handle_key_event(&mut state, key);
        assert!(!should_quit);
        assert_eq!(state.history.selected, Some(1));
        assert_eq!(state.history_hscroll, 4);
        assert!(state.history_nav_mode);
        assert_eq!(state.input.value(), before_input);
    }

    #[test]
    fn mouse_scroll_moves_focus_response_by_default() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(1);
        state.history_nav_mode = false;

        let down = MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, down);
        assert!(!state.history_nav_mode);
        assert_eq!(state.history.scroll, 3);

        let up = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, up);
        assert_eq!(state.history.scroll, 0);
    }

    #[test]
    fn mouse_scroll_moves_selected_entry_in_history_nav_mode() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(1);
        state.history_nav_mode = true;

        let up = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, up);
        assert_eq!(state.history.selected, Some(0));
    }

    #[test]
    fn plan_scroll_uses_wheel_without_entering_history_navigation() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Plan;

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });

        assert_eq!(state.plan.scroll, 3);
        assert!(!state.history_nav_mode);
    }

    #[test]
    fn plan_scroll_remains_available_after_history_navigation() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Plan;
        state.history_nav_mode = true;
        state.history.selected = Some(1);

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(state.plan.scroll, 3);
        assert_eq!(state.history.selected, Some(1));

        let key = KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE);
        let _ = handle_key_event(&mut state, key);
        assert_eq!(state.plan.scroll, 8);
    }

}

// ── Clipboard paste (Ctrl+V directo al portapapeles del sistema) ─────────────

#[cfg(not(test))]
fn paste_from_clipboard(state: &mut AppState) {
    if let Ok(mut cb) = Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            handle_paste_event(state, text);
        }
    }
}

#[cfg(test)]
fn paste_from_clipboard(_state: &mut AppState) {}

// ── Paste event (bracketed paste o Ctrl+V desde terminal) ────────────────────

pub fn handle_paste_event(state: &mut AppState, text: String) {
    // Si hay un modal de config abierto, pega en el campo de texto/secreto enfocado
    if let ModalState::Config(modal) = &mut state.modal {
        let focused = state.modal_focused;
        if modal.fields.get(focused).map(|f| f.kind != ModalFieldKind::Select).unwrap_or(false) {
            if let Some(val) = modal.values.get_mut(focused) {
                // Filtra saltos de línea y caracteres de control para campos de texto/secreto
                let clean: String = text.chars().filter(|c| !c.is_control() || *c == ' ').collect();
                val.push_str(&clean);
            }
        }
        return;
    }

    // Sin modal → pega en el input principal carácter a carácter
    for c in text.chars() {
        if c == '\n' || c == '\r' {
            continue; // no submittear al pegar
        }
        state.input.insert(c);
    }
}

// ── Modal de configuración ────────────────────────────────────────────────────

fn handle_config_modal_key(state: &mut AppState, code: KeyCode) {
    let ModalState::Config(modal) = &mut state.modal else {
        return;
    };
    let n = modal.fields.len();
    if n == 0 {
        return;
    }

    match code {
        KeyCode::Esc => {
            let command = modal.command.clone();
            state.modal = ModalState::None;
            state.pending_ipc.push(TuiMessage::ModalCancel { command });
        }
        // Tab/BackTab siempre cambian de campo
        KeyCode::Tab => {
            state.modal_focused = (state.modal_focused + 1) % n;
        }
        KeyCode::BackTab => {
            state.modal_focused = (state.modal_focused + n.saturating_sub(1)) % n;
        }
        // ↑↓ navegan opciones en Select; en Text/Secret cambian de campo
        KeyCode::Up => {
            let focused = state.modal_focused;
            if is_select_field(state, focused) {
                cycle_select(state, focused, -1);
            } else {
                state.modal_focused = (state.modal_focused + n.saturating_sub(1)) % n;
            }
        }
        KeyCode::Down => {
            let focused = state.modal_focused;
            if is_select_field(state, focused) {
                cycle_select(state, focused, 1);
            } else {
                state.modal_focused = (state.modal_focused + 1) % n;
            }
        }
        // ◄/► también funcionan en Select (alias de ↑↓)
        KeyCode::Left => {
            let focused = state.modal_focused;
            cycle_select(state, focused, -1);
        }
        KeyCode::Right => {
            let focused = state.modal_focused;
            cycle_select(state, focused, 1);
        }
        KeyCode::Enter => {
            // Validar campos requeridos
            let ModalState::Config(modal) = &state.modal else { return; };
            let ok = modal.fields.iter().enumerate().all(|(i, f)| {
                !f.required || !modal.values.get(i).map(String::is_empty).unwrap_or(true)
            });
            if ok {
                let ModalState::Config(modal) = &mut state.modal else { return; };
                let command = modal.command.clone();
                let values: std::collections::HashMap<String, String> = modal.fields.iter()
                    .enumerate()
                    .map(|(i, f)| (f.key.clone(), modal.values.get(i).cloned().unwrap_or_default()))
                    .collect();
                state.modal = ModalState::None;
                state.pending_ipc.push(TuiMessage::ModalSubmit { command, values });
            }
        }
        KeyCode::Backspace => {
            let focused = state.modal_focused;
            let ModalState::Config(modal) = &mut state.modal else { return; };
            // Solo campos de texto/secreto — Select usa ◄/►
            if modal.fields.get(focused).map(|f| f.kind != ModalFieldKind::Select).unwrap_or(false) {
                if let Some(val) = modal.values.get_mut(focused) {
                    val.pop();
                }
            }
        }
        KeyCode::Char(c) => {
            let focused = state.modal_focused;
            let ModalState::Config(modal) = &mut state.modal else { return; };
            // Solo campos de texto/secreto — Select usa ◄/►
            if modal.fields.get(focused).map(|f| f.kind != ModalFieldKind::Select).unwrap_or(false) {
                if let Some(val) = modal.values.get_mut(focused) {
                    val.push(c);
                }
            }
        }
        _ => {}
    }
}

fn is_select_field(state: &AppState, field_idx: usize) -> bool {
    let ModalState::Config(modal) = &state.modal else { return false; };
    modal.fields.get(field_idx).map(|f| f.kind == ModalFieldKind::Select).unwrap_or(false)
}

/// Avanza (delta=1) o retrocede (delta=-1) la selección de un campo Select.
/// Actualiza `cursors[field_idx]` como scroll offset para mantener el item visible.
fn cycle_select(state: &mut AppState, field_idx: usize, delta: isize) {
    use crate::widgets::config_modal::MAX_VISIBLE_OPTIONS;
    let ModalState::Config(modal) = &mut state.modal else { return; };
    let Some(field) = modal.fields.get(field_idx) else { return; };
    if field.kind != ModalFieldKind::Select { return; }
    let Some(opts) = field.options.clone() else { return; };
    if opts.is_empty() { return; }

    let current = modal.values.get(field_idx).cloned().unwrap_or_default();
    let cur_idx = opts.iter().position(|o| *o == current).unwrap_or(0);
    let next_idx = if delta < 0 {
        if cur_idx == 0 { opts.len() - 1 } else { cur_idx - 1 }
    } else {
        (cur_idx + 1) % opts.len()
    };

    if let Some(val) = modal.values.get_mut(field_idx) {
        *val = opts[next_idx].clone();
    }

    // Ajustar scroll para mantener el item seleccionado visible
    let scroll = modal.cursors.get(field_idx).copied().unwrap_or(0);
    let new_scroll = if next_idx < scroll {
        next_idx
    } else if next_idx >= scroll + MAX_VISIBLE_OPTIONS {
        next_idx + 1 - MAX_VISIBLE_OPTIONS
    } else {
        scroll
    };
    if let Some(s) = modal.cursors.get_mut(field_idx) {
        *s = new_scroll;
    }
}

fn help_text() -> String {
    "\
Comandos de hivetui
═══════════════════

Locales (TUI)
─────────────
/help        Mostrar esta pantalla
/quit /exit  Salir de hivetui
/clear       Limpiar el historial de conversación
/logs        Mostrar/ocultar panel de logs
/timeline    Mostrar/ocultar panel de workers
/copy        Activar modo navegación/copia del historial

Modo de ejecución
─────────────────
/mode                    Ciclar modo (plan → aprobación → auto)
/mode plan|aprobación|auto  Fijar modo directamente
/mode get                Mostrar modo actual
/mode history            Historial de cambios de modo

Provider y Modelo
─────────────────
/provider list|add|set|test|status
/modelo list|set|add|delete|info

Integraciones
─────────────
/github connect|status|whoami|disconnect|set-repo
/telegram connect|edit|disconnect|status

Herramientas del sistema
────────────────────────
/mcp list|add|enable|disable|test
/skill list|enable|disable|info|add

Tareas y Ejecución
──────────────────
/task list|status|cancel|rollback
/run <tarea>   Ejecutar tarea en modo actual
/plan <tarea>  Planificar sin ejecutar
/stop          Detener tarea en curso

Búsqueda y Aprendizaje
──────────────────────
/narrative show|search|export
/ace status|playbook list|playbook reset|reflector run

Notas y Sistema
───────────────
/note add|list|delete
/logs list|follow
/doctor   Diagnóstico del sistema
/version  Versión de hivecode
/env      Variables de entorno seguras
/session new
/compact  Compactar contexto
/status   Estado de la sesión

Vistas (tabs)
═════════════
1 / /layout focus      Vista principal de chat
2 / /layout plan       Razonamiento + mapa de archivos
3 / /layout code       Cambios en código + workers
4 / /layout review     Revisión + aprobación
5 / /layout dashboard  Panel de todos los workers
/welcome               Volver a la pantalla de bienvenida

Atajos de teclado
═════════════════

1-5          Cambiar de tab directamente
Tab          Entrar/salir de modo navegación
Shift+←/→   Scroll horizontal en la entrada seleccionada
Ctrl+L       Cargar entrada seleccionada al input
Ctrl+Y       Copiar entrada seleccionada (OSC 52)
Ctrl+C       Salir
Esc          Cancelar / volver al input
↑↓           Navegar historial o popup de comandos
".to_string()
}
