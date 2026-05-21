#[cfg(not(test))]
use std::io::{stdout, Write};

#[cfg(not(test))]
use base64::Engine as _;
use crossterm::{
    event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    terminal,
};

use crate::{
    ipc::TuiMessage,
    state::{AppState, HistoryEntry, InfoModalState, ModalState, Role},
    widgets::{command_popup, history},
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
        handle_config_modal_key(state, key.code);
        return false;
    }

    // ── Modal de info activo ───────────────────────────────────────────────────
    if let ModalState::Info(info) = &mut state.modal {
        match key.code {
            KeyCode::Esc => { state.modal = ModalState::None; }
            KeyCode::Up   => { info.scroll = info.scroll.saturating_sub(1); }
            KeyCode::Down => { info.scroll += 1; }
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
                let input = state.input.value().trim().to_string();
                // Comandos locales que no van a Bun
                match input.as_str() {
                    "/help" => {
                        state.input.clear();
                        state.command_popup_selected = 0;
                        state.modal = ModalState::Info(InfoModalState {
                            title: "Comandos disponibles".to_string(),
                            content: help_text(),
                            scroll: 0,
                        });
                        return false;
                    }
                    "/logs" => {
                        state.input.clear();
                        state.command_popup_selected = 0;
                        state.logs.visible = !state.logs.visible;
                        return false;
                    }
                    "/clear" => {
                        state.input.clear();
                        state.command_popup_selected = 0;
                        state.history.entries.clear();
                        state.history.selected = None;
                        return false;
                    }
                    _ => {
                        // Resto de comandos (/mode, /provider, /timeline…) → Bun
                        state.command_popup_selected = 0;
                        // Caer al handler normal de Enter
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

    match (key.modifiers, key.code) {
        (_, KeyCode::Esc) => {
            state.history_nav_mode = false;
            state.history_hscroll = 0;
        }
        (_, KeyCode::Home) if state.history_nav_mode => {
            if !state.history.entries.is_empty() {
                persist_hscroll_for_selected(state);
                state.history.selected = Some(0);
                restore_hscroll_for_selected(state);
            }
        }
        (_, KeyCode::End) if state.history_nav_mode => {
            if !state.history.entries.is_empty() {
                persist_hscroll_for_selected(state);
                state.history.selected = Some(state.history.entries.len().saturating_sub(1));
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
        }
        (m, KeyCode::Left) if state.history_nav_mode && m.contains(KeyModifiers::SHIFT) => {
            state.history_hscroll = state.history_hscroll.saturating_sub(2);
            persist_hscroll_for_selected(state);
        }
        (m, KeyCode::Right) if state.history_nav_mode && m.contains(KeyModifiers::SHIFT) => {
            state.history_hscroll = state.history_hscroll.saturating_add(2).min(5000);
            persist_hscroll_for_selected(state);
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
            if state.history_nav_mode {
                if let Some(idx) = state.history.selected {
                    if let Some(entry) = state.history.entries.get(idx) {
                        state.input.set(&entry.content);
                    }
                }
                state.history_nav_mode = false;
            } else {
                let submitted = state.input.submit();
                if !submitted.trim().is_empty() {
                    state.history.entries.push(HistoryEntry {
                        role: Role::User,
                        content: submitted,
                    });
                    state.history.selected = Some(state.history.entries.len().saturating_sub(1));
                    restore_hscroll_for_selected(state);
                }
            }
        }
        (_, KeyCode::Char(c)) if !state.history_nav_mode => state.input.insert(c),
        _ => {}
    }

    false
}

pub fn handle_mouse_event(state: &mut AppState, mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            state.history_nav_mode = true;
            move_history_selection(state, -1);
        }
        MouseEventKind::ScrollDown => {
            state.history_nav_mode = true;
            move_history_selection(state, 1);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            let history_area = history_rect_from_size(terminal::size().ok());
            if let Some(area) = history_area {
                if let Some(entry_idx) = history::entry_at_y(state, area, mouse.row) {
                    persist_hscroll_for_selected(state);
                    state.history_nav_mode = true;
                    state.history.selected = Some(entry_idx);
                    restore_hscroll_for_selected(state);
                }
            }
        }
        MouseEventKind::Down(MouseButton::Right) => {
            let history_area = history_rect_from_size(terminal::size().ok());
            if let Some(area) = history_area {
                if let Some(entry_idx) = history::entry_at_y(state, area, mouse.row) {
                    persist_hscroll_for_selected(state);
                    state.history.selected = Some(entry_idx);
                    restore_hscroll_for_selected(state);
                    if let Some(entry) = state.history.entries.get(entry_idx) {
                        state.input.set(&entry.content);
                        state.history_nav_mode = false;
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
    let vertical = area.vsplit(&[3, 0, 4, 1]);
    vertical.get(1).copied()
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
    fn mouse_scroll_enables_nav_and_moves_selection() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(1);
        state.history_nav_mode = false;

        let up = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, up);
        assert!(state.history_nav_mode);
        assert_eq!(state.history.selected, Some(0));

        let down = MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, down);
        assert_eq!(state.history.selected, Some(1));
    }

    #[test]
    fn left_click_selects_history_entry() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(0);

        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 3,
            row: 6,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, click);

        assert!(state.history_nav_mode);
        assert_eq!(state.history.selected, Some(2));
    }

    #[test]
    fn right_click_loads_selected_entry_to_input_and_exits_nav() {
        let mut state = mk_state_with_entries(3);
        state.history.selected = Some(0);
        state.history_nav_mode = true;
        state.input.set("draft");

        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Right),
            column: 3,
            row: 6,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse_event(&mut state, click);

        assert_eq!(state.history.selected, Some(2));
        assert_eq!(state.input.value(), "entry-2");
        assert!(!state.history_nav_mode);
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
        KeyCode::Tab | KeyCode::Down => {
            state.modal_focused = (state.modal_focused + 1) % n;
        }
        KeyCode::BackTab | KeyCode::Up => {
            state.modal_focused = (state.modal_focused + n.saturating_sub(1)) % n;
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
            if let Some(val) = modal.values.get_mut(focused) {
                val.pop();
            }
        }
        KeyCode::Char(c) => {
            let focused = state.modal_focused;
            let ModalState::Config(modal) = &mut state.modal else { return; };
            if let Some(val) = modal.values.get_mut(focused) {
                val.push(c);
            }
        }
        _ => {}
    }
}

fn help_text() -> String {
    "\
Comandos de hivetui
═══════════════════

/help        Mostrar esta pantalla
/mode        Cambiar modo de operación (plan/aprobación/auto)
/provider    Configurar provider LLM y API key
/logs        Mostrar/ocultar panel de logs
/clear       Limpiar el historial de conversación
/timeline    Ver checkpoints y rollbacks

Atajos de teclado
═════════════════

Tab          Entrar/salir de modo navegación
Shift+←/→   Scroll horizontal en la entrada seleccionada
Ctrl+L       Cargar entrada seleccionada al input
Ctrl+Y       Copiar entrada seleccionada (OSC 52)
Ctrl+C       Salir
Esc          Cancelar / volver al input
↑↓           Navegar historial o popup de comandos
".to_string()
}
