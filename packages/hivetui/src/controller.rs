#[cfg(not(test))]
use arboard::Clipboard;
#[cfg(not(test))]
use crate::clipboard;
use crossterm::{
    event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    terminal,
};

use crate::{
    ipc::TuiMessage,
    state::{AppState, ConfigModalState, HistoryEntry, InfoModalState, ModalAction, ModalField,
            ModalFieldKind, ModalState, ModelRows, ReplMode, ReviewAction, ReviewConfirmState,
            Role, Selection, SettingsHubState, SettingsTab, TabId},
    renderer::layout_areas,
    term::Rect,
    ui::{split_panes, Axis, Constraint, HitAction, SplitPane},
    widgets::{command_popup, dashboard_layout, history, tabbar, taller_layout},
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

    // ── Settings Hub activo ───────────────────────────────────────────────────
    if let ModalState::Settings(hub) = &mut state.modal {
        match key.code {
            KeyCode::Esc => {
                state.modal = ModalState::None;
            }
            KeyCode::Tab => {
                hub.active_tab = hub.active_tab.next();
                hub.selected_row = 0;
                hub.scroll_offset = 0;
            }
            KeyCode::BackTab => {
                hub.active_tab = hub.active_tab.prev();
                hub.selected_row = 0;
                hub.scroll_offset = 0;
            }
            KeyCode::Up => {
                hub.selected_row = hub.selected_row.saturating_sub(1);
            }
            KeyCode::Down => {
                let max = match hub.active_tab {
                    SettingsTab::Providers => hub.providers.len(),
                    SettingsTab::Models    => hub.model_row_count(),
                    SettingsTab::Agents    => hub.agents.len(),
                    SettingsTab::Mcp       => hub.mcp.len(),
                    SettingsTab::Skills    => hub.skills.len(),
                    _                      => 0,
                }.saturating_sub(1);
                hub.selected_row = (hub.selected_row + 1).min(max);
            }
            KeyCode::Char('p') | KeyCode::Char('P') if hub.active_tab == SettingsTab::Models => {
                // Cambiar de provider sin salir del tab: los modelos dependen del
                // provider activo, así que hay que volver a la lista de providers.
                hub.active_tab = SettingsTab::Providers;
                hub.selected_row = hub
                    .active_provider()
                    .and_then(|p| hub.providers.iter().position(|q| q.id == p.id))
                    .unwrap_or(0);
                hub.scroll_offset = 0;
            }
            KeyCode::Char('a') | KeyCode::Char('A') => {
                let cmd = match hub.active_tab {
                    SettingsTab::Providers => "/provider add",
                    SettingsTab::Models    => "/modelo add",
                    SettingsTab::Agents    => "/agent list",
                    SettingsTab::Mcp       => "/mcp add",
                    SettingsTab::Skills    => "/skill add",
                    SettingsTab::Github    => "/github connect",
                    SettingsTab::Telegram  => "/telegram connect",
                };
                keep_hub_loading(state);
                state.pending_ipc.push(TuiMessage::Submit { input: cmd.to_string() });
                state.pending_ipc.push(TuiMessage::RequestSettings);
            }
            KeyCode::Char('d') | KeyCode::Char('D') => {
                // Delete del item seleccionado — envía el comando de remove al tab activo
                let cmd = match hub.active_tab {
                    SettingsTab::Providers => {
                        hub.providers.get(hub.selected_row)
                            .map(|p| format!("/provider remove {}", p.id))
                    }
                    SettingsTab::Mcp => {
                        hub.mcp.get(hub.selected_row)
                            .map(|m| format!("/mcp remove {}", m.id))
                    }
                    _ => None,
                };
                if let Some(c) = cmd {
                    keep_hub_loading(state);
                    state.pending_ipc.push(TuiMessage::Submit { input: c });
                    state.pending_ipc.push(TuiMessage::RequestSettings);
                }
            }
            KeyCode::Char(' ') => {
                // Space: toggle enable/disable para skills y mcp
                let cmd = match hub.active_tab {
                    SettingsTab::Skills => {
                        hub.skills.get(hub.selected_row).map(|s| {
                            if s.active { format!("/skill disable {}", s.name) }
                            else        { format!("/skill enable {}",  s.name) }
                        })
                    }
                    SettingsTab::Mcp => {
                        hub.mcp.get(hub.selected_row).map(|m| {
                            if m.enabled { format!("/mcp disable {}", m.id) }
                            else         { format!("/mcp enable {}",  m.id) }
                        })
                    }
                    _ => None,
                };
                if let Some(c) = cmd {
                    keep_hub_loading(state);
                    state.pending_ipc.push(TuiMessage::Submit { input: c });
                    state.pending_ipc.push(TuiMessage::RequestSettings);
                }
            }
            KeyCode::Enter => {
                // En Providers, Enter NO vuelve a mandar `/provider set`: Bun ignoraba
                // el id y reabría el desplegable con TODOS los providers, obligando a
                // elegir dos veces el mismo. Aquí se resuelve en la TUI.
                if hub.active_tab == SettingsTab::Providers {
                    let selected = hub.provider_at(hub.selected_row).map(|p| ProviderTarget {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        needs_key: p.needs_key(),
                        browser_login: p.browser_login,
                    });
                    if let Some(target) = selected {
                        activate_provider(state, &target);
                    }
                    return false;
                }
                let cmd = match hub.active_tab {
                    // Cambiar el modelo. Con provider activo las filas son sus modelos, así que
                    // Enter aplica el modelo elegido. Sin provider activo las filas
                    // son providers y Enter elige el provider (modelo después).
                    SettingsTab::Models => match hub.model_rows() {
                        ModelRows::Models { provider_id, models } => models
                            .get(hub.selected_row)
                            .map(|m| format!("/modelo set {provider_id} {m}")),
                        ModelRows::NeedProvider { providers } => providers
                            .get(hub.selected_row)
                            .map(|p| format!("/provider set {}", p.id)),
                    },
                    SettingsTab::Agents => {
                        hub.agents.get(hub.selected_row)
                            .map(|a| format!("/agent configure {}", a.id))
                    }
                    SettingsTab::Mcp => {
                        hub.mcp.get(hub.selected_row)
                            .map(|m| format!("/mcp inspect {}", m.id))
                    }
                    SettingsTab::Github    => Some("/github status".to_string()),
                    SettingsTab::Telegram  => Some("/telegram status".to_string()),
                    _ => None,
                };
                if let Some(c) = cmd {
                    keep_hub_loading(state);
                    state.pending_ipc.push(TuiMessage::Submit { input: c });
                    state.pending_ipc.push(TuiMessage::RequestSettings);
                }
            }
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
            // Strip horizontal: ←→ navegan las opciones
            KeyCode::Left | KeyCode::Up => {
                approval.selected = approval.selected.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::Down => {
                approval.selected = (approval.selected + 1).min(3);
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
            }
            _ => {}
        }
        return false;
    }

    // ── Confirmación de Review en dos pasos ───────────────────────────────────
    if let ModalState::ReviewConfirm(confirm) = &state.modal {
        let action = confirm.action;
        match key.code {
            KeyCode::Esc => {
                state.modal = ModalState::None;
            }
            KeyCode::Enter => {
                state.modal = ModalState::None;
                state.pending_ipc.push(TuiMessage::Submit {
                    input: action.command().to_string(),
                });
            }
            _ => {}
        }
        return false;
    }

    // Los atajos de layout usan letras desnudas (h/a/r/m) y flechas, así que solo
    // pueden reclamar la tecla cuando el usuario no está escribiendo. Sin esto,
    // teclear "hola" en modo Auto envía /halt.
    let typing = accepts_text(state);

    // Atajo global: `i` abre la ficha del especialista enfocado. No vive en el
    // handler de ENJAMBRE porque la pregunta "¿qué puede hacer este?" aplica
    // desde cualquier vista, y con el auto-routing el usuario no elige en qué
    // pestaña está.
    if key.code == KeyCode::Char('i') && !typing && matches!(state.modal, ModalState::None) {
        // Con la ficha ya abierta, `i` avanza al siguiente: reabrir el primero
        // cada vez es lo contrario de lo que uno espera al pulsar dos veces.
        if state.ficha_agent.is_some() {
            move_ficha_selection(state, 1);
            return false;
        }
        let target = state
            .focused_worker
            .as_deref()
            .and_then(|name| state.roster.resolve(name))
            .map(|a| a.id.clone())
            .or_else(|| state.roster.agents().first().map(|a| a.id.clone()));
        match target {
            Some(id) => {
                state.ficha_agent = Some(id);
                return false;
            }
            None => {
                state.status_msg = "aún no hay roster del enjambre".to_string();
                return false;
            }
        }
    }

    if state.active_tab == TabId::Swarm
        && handle_dashboard_key(state, key.code, key.modifiers, typing)
    {
        return false;
    }

    if state.active_tab != TabId::Swarm
        && handle_immersive_layout_key(state, key.code, key.modifiers, typing)
    {
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
                    // `/habilidades` abre el catálogo. Con un argumento, abre
                    // además la ficha de ese agente para que cada skill diga si
                    // él puede usarla.
                    "/habilidades" | "/skills" => {
                        state.active_tab = TabId::Taller;
                        state.taller_section = taller_layout::Section::Habilidades;
                        state.taller_scroll = 0;
                        state.tab_locked = true;
                        state.ficha_agent = (!arg.is_empty())
                            .then(|| state.roster.resolve(arg).map(|a| a.id.clone()))
                            .flatten();
                        return false;
                    }
                    // `/ficha <agente>` abre la ficha directa.
                    "/ficha" => {
                        let target = if arg.is_empty() {
                            state.focused_worker.clone()
                        } else {
                            state.roster.resolve(arg).map(|a| a.id.clone())
                        };
                        match target.and_then(|id| {
                            state.roster.resolve(&id).map(|_| id)
                        }) {
                            Some(id) => {
                                state.ficha_agent = Some(id);
                                state.active_tab = TabId::Swarm;
                                state.tab_locked = true;
                            }
                            None => {
                                state.status_msg = format!("no encontré el agente «{arg}»");
                            }
                        }
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
                        // Cambiar de vista a mano rompe el auto-routing: el
                        // usuario acaba de decir dónde quiere estar.
                        state.tab_locked = true;
                        state.taller_scroll = 0;
                        return false;
                    }
                    "/welcome" => {
                        state.show_welcome = true;
                        state.active_tab = TabId::Mesa;
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

    if state.active_tab == TabId::Review
        && state.session.mode == ReplMode::Approval
        && state.input.value().is_empty()
        && !state.history_nav_mode
    {
        // Enter es seguro (no es un carácter de texto). Las letras van tras Alt:
        // con el input vacío, una 'a' desnuda es el primer carácter de "arregla".
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let action = match key.code {
            KeyCode::Enter => Some(ReviewAction::Approve),
            KeyCode::Char('a') | KeyCode::Char('A') if alt => Some(ReviewAction::Approve),
            KeyCode::Char('r') | KeyCode::Char('R') if alt => Some(ReviewAction::Reject),
            KeyCode::Char('m') | KeyCode::Char('M') if alt => Some(ReviewAction::Modify),
            _ => None,
        };
        if let Some(action) = action {
            state.modal = ModalState::ReviewConfirm(ReviewConfirmState { action });
            return false;
        }
    }

    match (key.modifiers, key.code) {
        // F2 o Ctrl+Shift+S → abre el hub de settings
        (KeyModifiers::NONE, KeyCode::F(2))
        | (KeyModifiers::CONTROL | KeyModifiers::SHIFT, KeyCode::Char('s'))
        | (KeyModifiers::CONTROL | KeyModifiers::SHIFT, KeyCode::Char('S')) => {
            state.modal = ModalState::Settings(SettingsHubState {
                loading: true,
                ..Default::default()
            });
            state.pending_ipc.push(TuiMessage::RequestSettings);
        }
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
            state.selection = None;
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
        (_, KeyCode::PageUp) if state.active_tab == TabId::Mesa && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_sub(5);
        }
        (_, KeyCode::PageDown) if state.active_tab == TabId::Mesa && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_add(5);
        }
        (_, KeyCode::PageUp) if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_sub(5);
        }
        (_, KeyCode::PageDown) if state.active_tab == TabId::Plan => {
            state.plan.scroll = state.plan.scroll.saturating_add(5);
        }
        (_, KeyCode::PageUp) if state.active_tab == TabId::Swarm => {
            state.dashboard_scroll = state.dashboard_scroll.saturating_sub(8);
        }
        (_, KeyCode::PageDown) if state.active_tab == TabId::Swarm => {
            state.dashboard_scroll = state.dashboard_scroll.saturating_add(8);
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
        (m, KeyCode::Char('c')) if m.contains(KeyModifiers::CONTROL) && m.contains(KeyModifiers::SHIFT) => {
            state.pending_copy_request = true;
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
        (_, KeyCode::Up) if state.active_tab == TabId::Code && state.input.value().is_empty() => {
            state.diff.scroll = state.diff.scroll.saturating_sub(1);
        }
        (_, KeyCode::Down) if state.active_tab == TabId::Code && state.input.value().is_empty() => {
            state.diff.scroll += 1;
        }
        (_, KeyCode::Up) if state.active_tab == TabId::Review && state.input.value().is_empty() => {
            state.adrs.scroll = state.adrs.scroll.saturating_sub(1);
        }
        (_, KeyCode::Down) if state.active_tab == TabId::Review && state.input.value().is_empty() => {
            state.adrs.scroll += 1;
        }
        (_, KeyCode::Up) if state.active_tab == TabId::Plan && state.input.value().is_empty() => {
            state.plan.scroll = state.plan.scroll.saturating_sub(1);
        }
        (_, KeyCode::Down) if state.active_tab == TabId::Plan && state.input.value().is_empty() => {
            state.plan.scroll += 1;
        }
        (_, KeyCode::Up) if state.active_tab == TabId::Swarm && state.input.value().is_empty() => {
            state.dashboard_scroll = state.dashboard_scroll.saturating_sub(1);
        }
        (_, KeyCode::Down) if state.active_tab == TabId::Swarm && state.input.value().is_empty() => {
            state.dashboard_scroll += 1;
        }
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
                    if submitted.trim().eq_ignore_ascii_case("/auto") {
                        state.resume_auto_layout();
                    }
                    state.show_welcome = false; // entrar al chat al enviar el primer mensaje
                    if state.session.mode == ReplMode::Plan {
                        state.plan.current = None;
                        state.plan.scroll = 0;
                        state.filemap.scroll = 0;
                        state.adrs.scroll = 0;
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

/// Lo que la TUI ya sabe del provider elegido en la fila `selected_row`.
/// Se copia a valores propios para poder soltar el préstamo del hub y montar
/// encima otro modal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderTarget {
    id: String,
    name: String,
    needs_key: bool,
    browser_login: bool,
}

/// Deja el hub de settings montado, en estado "cargando".
///
/// Antes estas accioneshacían `state.modal = ModalState::None`, y como
/// `SettingsData` solo se aplica si el hub está montado (`AppState::apply_message`),
/// el refresco se descartaba: había que volver a pulsar F2 para ver el resultado.
fn keep_hub_loading(state: &mut AppState) {
    if let ModalState::Settings(hub) = &mut state.modal {
        hub.loading = true;
    }
}

/// Activa el provider elegido en el tab Providers.
///
/// - Sin clave y sin login de navegador → modal **local** con un único campo
///   secreto. La clave viaja en `ProviderActivate`, así que Bun ya no necesita
///   reabrir su propio desplegable de providers.
/// - Con clave guardada, o con login de navegador → se activa directo.
fn activate_provider(state: &mut AppState, target: &ProviderTarget) {
    let hub = match &state.modal {
        ModalState::Settings(hub) => Some(hub.clone()),
        _ => None,
    };

    // El login de navegador (PKCE) no usa API key: preguntar por ella sería
    // un formulario imposible de completar. Bun suspende la TUI y abre el browser.
    if !target.browser_login && target.needs_key {
        state.modal_focused = 0;
        state.modal = ModalState::Config(ConfigModalState {
            command: "provider_activate".to_string(),
            title: format!("API key · {}", target.name),
            fields: vec![ModalField {
                key: "api_key".to_string(),
                label: format!("Clave de {}", target.name),
                kind: ModalFieldKind::Secret,
                required: true,
                ..Default::default()
            }],
            values: vec![String::new()],
            cursors: vec![0],
            focused: 0,
            errors: vec![false],
            action: Some(ModalAction::ProviderActivate { provider_id: target.id.clone() }),
            return_to: hub,
        });
        return;
    }

    if let Some(mut hub) = hub {
        hub.loading = true;
        state.modal = ModalState::Settings(hub);
    } else {
        state.modal = ModalState::None;
    }
    state.pending_ipc.push(TuiMessage::ProviderActivate {
        provider_id: target.id.clone(),
        api_key: None,
    });
}

/// Cierra un modal local y devuelve al usuario al hub de settings.
fn close_to_settings_hub(state: &mut AppState, loading: bool) {
    let ModalState::Config(modal) = &state.modal else {
        state.modal = ModalState::None;
        return;
    };
    match modal.return_to.clone() {
        Some(mut hub) => {
            hub.loading = loading;
            state.modal = ModalState::Settings(hub);
        }
        // Un modal de Bun no tiene hub al que volver: se cierra del todo.
        None => state.modal = ModalState::None,
    }
}

fn handle_dashboard_key(
    state: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    typing: bool,
) -> bool {
    // Esc cancela confirmaciones pendientes aunque haya texto escrito: abandonar una
    // acción destructiva nunca debe requerir vaciar el input primero.
    if code == KeyCode::Esc && has_pending_confirm(state) {
        clear_pending_confirm(state);
        state.selection = None;
        return true;
    }
    if typing {
        return false;
    }
    let alt = modifiers.contains(KeyModifiers::ALT);
    match code {
        KeyCode::Esc => {
            clear_pending_confirm(state);
            state.selection = None;
            true
        }
        KeyCode::Left => {
            move_checkpoint_selection(state, -1);
            true
        }
        KeyCode::Right => {
            move_checkpoint_selection(state, 1);
            true
        }
        KeyCode::Enter => {
            // Una ficha abierta tiene prioridad: `Enter` la cierra en vez de
            // disparar el rollback de un checkpoint que el usuario no está
            // mirando.
            if state.ficha_agent.is_some() {
                state.ficha_agent = None;
                return true;
            }
            if state.dashboard.halt_confirm {
                state.dashboard.halt_confirm = false;
                state.pending_ipc.push(TuiMessage::Submit { input: "/halt".to_string() });
                return true;
            }
            // Una tarea interrumpida es la acción más urgente del panel, y solo
            // se alcanza aquí con el input vacío: escribiendo, Enter sigue
            // enviando el mensaje.
            if state.dashboard.resume.is_some() && !state.dashboard.halt.active {
                confirm_or_send_task_resume(state);
                return true;
            }
            if state.session.mode == ReplMode::Plan
                && state.checkpoints.selected.is_none()
                && !state.dashboard.halt.active
            {
                state.pending_ipc.push(TuiMessage::Submit { input: "/approve auto".to_string() });
                return true;
            }
            confirm_or_send_dashboard_rollback(state);
            true
        }
        // Alt+a/r/m y Alt+h: las letras desnudas son el primer carácter de un mensaje.
        KeyCode::Char('a') | KeyCode::Char('A')
            if alt && state.session.mode == ReplMode::Approval && !state.dashboard.halt.active =>
        {
            state.modal = ModalState::ReviewConfirm(ReviewConfirmState { action: ReviewAction::Approve });
            true
        }
        KeyCode::Char('r') | KeyCode::Char('R')
            if alt && state.session.mode == ReplMode::Approval && !state.dashboard.halt.active =>
        {
            state.modal = ModalState::ReviewConfirm(ReviewConfirmState { action: ReviewAction::Reject });
            true
        }
        KeyCode::Char('m') | KeyCode::Char('M')
            if alt && state.session.mode == ReplMode::Approval && !state.dashboard.halt.active =>
        {
            state.modal = ModalState::ReviewConfirm(ReviewConfirmState { action: ReviewAction::Modify });
            true
        }
        KeyCode::Char('h') | KeyCode::Char('H') if alt && state.session.mode == ReplMode::Auto => {
            request_halt(state);
            true
        }
        KeyCode::BackTab if modifiers.is_empty() => false,
        _ => false,
    }
}

fn handle_immersive_layout_key(
    state: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    typing: bool,
) -> bool {
    let alt = modifiers.contains(KeyModifiers::ALT);
    if !modifiers.is_empty() && !alt {
        return false;
    }
    // Igual que en Dashboard: Esc cancela confirmaciones aunque se esté escribiendo.
    if code == KeyCode::Esc && has_pending_confirm(state) {
        clear_pending_confirm(state);
        return true;
    }
    if typing {
        return false;
    }
    match code {
        // ── Ficha del especialista ───────────────────────────────────────────
        // `Esc` la cierra. Va antes que la navegación de checkpoints porque
        // una ficha abierta convierte las flechas en "otro agente".
        KeyCode::Esc if state.ficha_agent.is_some() => {
            state.ficha_agent = None;
            true
        }
        KeyCode::Left | KeyCode::Right if state.ficha_agent.is_some() => {
            move_ficha_selection(state, if code == KeyCode::Right { 1 } else { -1 });
            true
        }
        // `f` alterna el filtro por agente del stream de MESA. Con cinco
        // agentes hablando a la vez, ver el de uno es la diferencia entre
        // entender el enjambre y leer ruido.
        KeyCode::Char('f') if !state.ficha_agent.is_some() => {
            let candidato = state
                .focused_worker
                .clone()
                .or_else(|| state.thought.visibles().last().map(|e| e.agent().to_string()));
            if let Some(agent) = candidato {
                state.thought.alternar_filtro(&agent);
                let msg = match &state.thought.filtro {
                    Some(a) => format!("stream filtrado por {a} · f para todos"),
                    None => "stream de todos los agentes".to_string(),
                };
                state.status_msg = msg;
            }
            true
        }
        KeyCode::Char('s') if state.ficha_agent.is_some() => {
            // Saltar a las habilidades de este agente, filtradas por lo que
            // puede usar.
            state.active_tab = TabId::Taller;
            state.taller_section = taller_layout::Section::Habilidades;
            state.taller_scroll = 0;
            true
        }
        // ── TALLER: `←/→` cambian de sección, `↑/↓` hacen scroll ──────────
        // Antes de ser un tab, esto eran las flechas de los checkpoints. Ahora la
        // sección se recorre dentro de su propia vista, que es lo que el usuario
        // espera al ver seis pestañas en el tabbar.
        KeyCode::Left | KeyCode::Right if state.active_tab == TabId::Taller => {
            state.taller_section = if code == KeyCode::Right {
                state.taller_section.next()
            } else {
                state.taller_section.prev()
            };
            state.taller_scroll = 0;
            true
        }
        KeyCode::Up | KeyCode::Down if state.active_tab == TabId::Taller => {
            let delta: isize = if code == KeyCode::Down { 1 } else { -1 };
            // El tope lo pone el número de filas de la sección: más allá, el
            // scroll no movería nada y el usuario creería que la tecla falló.
            let total = taller_layout::section_rows(state) as isize;
            let next = state.taller_scroll as isize + delta;
            state.taller_scroll = next.clamp(0, (total - 1).max(0)) as usize;
            true
        }
        KeyCode::Left => {
            move_checkpoint_selection(state, -1);
            true
        }
        KeyCode::Right => {
            move_checkpoint_selection(state, 1);
            true
        }
        KeyCode::Enter if state.dashboard.halt_confirm => {
            state.dashboard.halt_confirm = false;
            state.pending_ipc.push(TuiMessage::Submit { input: "/halt".to_string() });
            true
        }
        KeyCode::Enter if state.checkpoints.selected.is_some() => {
            confirm_or_send_dashboard_rollback(state);
            true
        }
        KeyCode::Enter if state.active_tab == TabId::Plan && state.session.mode == ReplMode::Plan => {
            state.pending_ipc.push(TuiMessage::Submit { input: "/approve auto".to_string() });
            true
        }
        KeyCode::Char('h') | KeyCode::Char('H') if alt && state.session.mode == ReplMode::Auto => {
            request_halt(state);
            true
        }
        _ => false,
    }
}

/// Cambia el especialista abierto en la ficha, en el orden del roster.
///
/// Recorre solo los que son operables: abrir la ficha de un agente bloqueado por
/// un MCP apagado tiene sentido (dice por qué), pero saltarse el resto de la
/// lista al navegar sería confuso.
fn move_ficha_selection(state: &mut AppState, delta: isize) {
    let roster = state.roster.agents();
    if roster.is_empty() {
        state.ficha_agent = None;
        return;
    }
    let current = state
        .ficha_agent
        .as_deref()
        .and_then(|id| roster.iter().position(|a| a.id.as_str() == id));
    let next = match current {
        Some(i) => (i as isize + delta).rem_euclid(roster.len() as isize),
        None => 0,
    } as usize;
    state.ficha_agent = Some(roster[next].id.clone());
}

/// El usuario está componiendo texto (hay contenido en el input) o navegando el
/// historial. En ambos casos las teclas pertenecen al input, no a los atajos de layout.
fn accepts_text(state: &AppState) -> bool {
    !state.input.value().is_empty() || state.history_nav_mode
}

fn has_pending_confirm(state: &AppState) -> bool {
    state.dashboard.rollback_confirm_checkpoint.is_some()
        || state.dashboard.halt_confirm
        || state.dashboard.resume_confirm
}

fn clear_pending_confirm(state: &mut AppState) {
    state.dashboard.rollback_confirm_checkpoint = None;
    state.dashboard.halt_confirm = false;
    state.dashboard.resume_confirm = false;
}

/// Primera pulsación arma el resume, la segunda lo envía.
///
/// El badge `▶ RESUME` existe desde la reconciliación de arranque, pero no tenía
/// ninguna acción detrás: la tarea se quedaba pausada para siempre aunque la TUI
/// la ofreciera. Un halt armado gana: detener el enjambre es más urgente.
fn confirm_or_send_task_resume(state: &mut AppState) {
    let Some(resume) = state.dashboard.resume.clone() else {
        return;
    };
    if state.dashboard.resume_confirm {
        state.dashboard.resume_confirm = false;
        // El aviso se consumió. Si el resume falla, Bun vuelve a emitir
        // `resume_available` y el badge reaparece.
        state.dashboard.resume = None;
        state.pending_ipc.push(TuiMessage::TaskResume { task_id: resume.task_id });
    } else {
        state.dashboard.resume_confirm = true;
    }
}

/// Primer pulsación arma la confirmación, la segunda envía `/halt`.
fn request_halt(state: &mut AppState) {
    state.dashboard.rollback_confirm_checkpoint = None;
    state.dashboard.halt_confirm = true;
}

fn move_checkpoint_selection(state: &mut AppState, delta: isize) {
    if state.checkpoints.entries.is_empty() {
        return;
    }
    let len = state.checkpoints.entries.len();
    let current = state.checkpoints.selected.unwrap_or_else(|| len.saturating_sub(1));
    let next = if delta.is_negative() {
        current.saturating_sub(delta.unsigned_abs())
    } else {
        current.saturating_add(delta as usize).min(len.saturating_sub(1))
    };
    state.checkpoints.selected = Some(next);
    clear_pending_confirm(state);
}

fn confirm_or_send_dashboard_rollback(state: &mut AppState) {
    if state.checkpoints.entries.is_empty() {
        return;
    }
    if state.checkpoints.selected.is_none() {
        if let Some(halt_checkpoint) = state.dashboard.halt.checkpoint_id.as_deref() {
            state.checkpoints.selected = state
                .checkpoints
                .entries
                .iter()
                .position(|checkpoint| checkpoint.id == halt_checkpoint);
        }
    }
    let idx = state
        .checkpoints
        .selected
        .unwrap_or_else(|| state.checkpoints.entries.len().saturating_sub(1));
    let Some(checkpoint) = state.checkpoints.entries.get(idx) else {
        return;
    };
    let checkpoint_id = checkpoint.id.clone();
    if state.dashboard.rollback_confirm_checkpoint.as_deref() == Some(checkpoint_id.as_str()) {
        state.pending_ipc.push(TuiMessage::Rollback { checkpoint_id });
        state.dashboard.rollback_confirm_checkpoint = None;
    } else {
        state.checkpoints.selected = Some(idx);
        state.dashboard.rollback_confirm_checkpoint = Some(checkpoint_id);
    }
}

pub fn handle_mouse_event(state: &mut AppState, mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::ScrollUp if state.active_tab == TabId::Mesa && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Mesa && !state.history_nav_mode => {
            state.history.scroll = state.history.scroll.saturating_add(3);
        }
        MouseEventKind::ScrollUp if state.active_tab == TabId::Plan => {
            match plan_scroll_target(state, mouse.column, mouse.row) {
                PlanScrollTarget::Stream => state.plan.scroll = state.plan.scroll.saturating_sub(3),
                PlanScrollTarget::FileMap => state.filemap.scroll = state.filemap.scroll.saturating_sub(3),
                PlanScrollTarget::Adr => state.adrs.scroll = state.adrs.scroll.saturating_sub(3),
            }
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Plan => {
            match plan_scroll_target(state, mouse.column, mouse.row) {
                PlanScrollTarget::Stream => state.plan.scroll = state.plan.scroll.saturating_add(3),
                PlanScrollTarget::FileMap => state.filemap.scroll = state.filemap.scroll.saturating_add(3),
                PlanScrollTarget::Adr => state.adrs.scroll = state.adrs.scroll.saturating_add(3),
            }
        }
        MouseEventKind::ScrollUp if state.active_tab == TabId::Code => {
            state.diff.scroll = state.diff.scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Code => {
            state.diff.scroll = state.diff.scroll.saturating_add(3);
        }
        MouseEventKind::ScrollUp if state.active_tab == TabId::Review => {
            state.adrs.scroll = state.adrs.scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Review => {
            state.adrs.scroll = state.adrs.scroll.saturating_add(3);
        }
        MouseEventKind::ScrollUp if state.active_tab == TabId::Swarm => {
            state.dashboard_scroll = state.dashboard_scroll.saturating_sub(3);
        }
        MouseEventKind::ScrollDown if state.active_tab == TabId::Swarm => {
            state.dashboard_scroll = state.dashboard_scroll.saturating_add(3);
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
            if let Some(action) = state.hit_map.hit(mouse.column, mouse.row).map(|r| r.action.clone()) {
                if handle_hit_action(state, action) {
                    state.selection = None;
                    return;
                }
            }
            if state.active_tab == TabId::Swarm {
                if let Some(area) = screen_rect_from_size(terminal::size().ok()) {
                    if let Some(checkpoint_idx) = dashboard_layout::checkpoint_at(state, area, mouse.column, mouse.row) {
                        state.checkpoints.selected = Some(checkpoint_idx);
                        state.dashboard.rollback_confirm_checkpoint = None;
                        state.selection = None;
                        return;
                    }
                    if let Some(worker) = dashboard_layout::worker_at(state, area, mouse.column, mouse.row) {
                        state.focused_worker = Some(worker);
                        state.active_tab = TabId::Code;
                        state.tab_locked = true;
                        state.history_nav_mode = false;
                        state.history_hscroll = 0;
                        state.show_welcome = false;
                        state.selection = None;
                        return;
                    }
                }
            }
            // Click en la fila del tabbar. El tabbar va justo debajo del header,
            // cuya altura es configurable (1-5), así que su fila se deriva del
            // layout y no de una constante.
            if state.active_tab != TabId::Swarm {
                if let Some((w, h)) = terminal::size().ok() {
                    let tabbar_area = crate::term::Rect::new(
                        0,
                        state.panels.header_height.clamp(1, 5),
                        w,
                        1,
                    );
                    if tabbar_area.y < h {
                        if let Some(tab) = tabbar::tab_at_col(tabbar_area, mouse.column, state) {
                            state.active_tab = tab;
                            if tab != TabId::Mesa {
                                state.history_nav_mode = false;
                                state.history_hscroll = 0;
                            }
                            state.show_welcome = false;
                            state.selection = None;
                            return;
                        }
                    }
                }
            }
            let history_area = content_rect_from_size(state, terminal::size().ok());
            if state.active_tab == TabId::Mesa {
                if let Some(area) = history_area {
                    if let Some(entry_idx) = history::entry_at_y(state, area, mouse.row) {
                        persist_hscroll_for_selected(state);
                        state.history_nav_mode = true;
                        state.history.selected = Some(entry_idx);
                        state.history.scroll = 0;
                        restore_hscroll_for_selected(state);
                        state.selection = None;
                        return;
                    }
                }
            }
            // Iniciar selección de texto si el click está en el área de contenido
            if let Some(area) = content_rect_from_size(state, terminal::size().ok()) {
                if rect_contains(area, mouse.column, mouse.row) {
                    state.selection = Some(Selection {
                        anchor: (mouse.column, mouse.row),
                        cursor: (mouse.column, mouse.row),
                        active: true,
                    });
                }
            }
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(ref mut sel) = state.selection {
                if sel.active {
                    sel.cursor = (mouse.column, mouse.row);
                    return;
                }
            }
            if update_active_split_drag(state, mouse.column, mouse.row) {
                return;
            }
        }
        MouseEventKind::Up(MouseButton::Left) => {
            state.panels.end_drag();
            if let Some(ref mut sel) = state.selection {
                if sel.active {
                    sel.active = false;
                    state.pending_copy_request = true;
                }
            }
        }
        MouseEventKind::Down(MouseButton::Right) => {
            let history_area = content_rect_from_size(state, terminal::size().ok());
            if state.active_tab == TabId::Mesa {
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

fn handle_hit_action(state: &mut AppState, action: HitAction) -> bool {
    match action {
        HitAction::ActivateTab(name) => {
            let Some(tab) = TabId::from_name(&name) else {
                return false;
            };
            state.active_tab = tab;
            if tab != TabId::Mesa {
                state.history_nav_mode = false;
                state.history_hscroll = 0;
            }
            state.show_welcome = false;
            true
        }
        HitAction::Command(command) => {
            state.input.set(&command);
            true
        }
        HitAction::SelectRow(i) => {
            if let ModalState::Settings(hub) = &mut state.modal {
                hub.selected_row = i;
                return true;
            }
            false
        }
        HitAction::Custom(ref id) if id.starts_with("settings:") => {
            if id == "settings:noop" { return true; }
            if let Some(tab_name) = id.strip_prefix("settings:tab:") {
                if let ModalState::Settings(hub) = &mut state.modal {
                    hub.active_tab = match tab_name {
                        "Providers" => SettingsTab::Providers,
                        "Modelos"   => SettingsTab::Models,
                        "Agentes"   => SettingsTab::Agents,
                        "MCP"       => SettingsTab::Mcp,
                        "Skills"    => SettingsTab::Skills,
                        "GitHub"    => SettingsTab::Github,
                        "Telegram"  => SettingsTab::Telegram,
                        _           => hub.active_tab,
                    };
                    hub.selected_row = 0;
                }
                return true;
            }
            if let Some(row_str) = id.strip_prefix("settings:row:") {
                if let Ok(row) = row_str.parse::<usize>() {
                    if let ModalState::Settings(hub) = &mut state.modal {
                        hub.selected_row = row;
                    }
                }
                return true;
            }
            false
        }
        HitAction::ResizeSplit { id } => {
            state.panels.begin_drag(id);
            true
        }
        _ => false,
    }
}

fn update_active_split_drag(state: &mut AppState, col: u16, row: u16) -> bool {
    let Some(id) = state.panels.active_drag.clone() else {
        return false;
    };
    let Some(screen_area) = screen_rect_from_size(terminal::size().ok()) else {
        return false;
    };
    let areas = layout_areas(screen_area, &state.panels);
    let content_area = areas.content;

    let percent = match id.as_str() {
        "chrome:header" => {
            let height = row.saturating_sub(screen_area.y).saturating_add(1);
            state.panels.set_chrome_height(&id, height);
            return true;
        }
        "chrome:input" => {
            let height = screen_area
                .bottom()
                .saturating_sub(row)
                .saturating_sub(state.panels.footer_height);
            state.panels.set_chrome_height(&id, height);
            return true;
        }
        "chrome:footer" => {
            let height = screen_area.bottom().saturating_sub(row);
            state.panels.set_chrome_height(&id, height);
            return true;
        }
        "code:main" | "plan:main" | "review:main" => percent_from_x(content_area, col),
        "code:workers" => {
            let right = right_split_area(
                content_area,
                state.panels.code_main_percent,
            );
            percent_from_y(right, row)
        }
        "plan:right" => {
            let right = right_split_area(
                content_area,
                state.panels.plan_main_percent,
            );
            percent_from_y(right, row)
        }
        "review:right" => {
            let right = right_split_area(
                content_area,
                state.panels.review_main_percent,
            );
            percent_from_y(right, row)
        }
        _ => return false,
    };

    state.panels.set_percent(&id, percent);
    true
}

fn percent_from_x(area: Rect, col: u16) -> u16 {
    if area.w == 0 {
        return 50;
    }
    let offset = col.saturating_sub(area.x).min(area.w.saturating_sub(1));
    ((offset as u32 * 100) / area.w as u32).clamp(20, 80) as u16
}

fn percent_from_y(area: Rect, row: u16) -> u16 {
    if area.h == 0 {
        return 50;
    }
    let offset = row.saturating_sub(area.y).min(area.h.saturating_sub(1));
    ((offset as u32 * 100) / area.h as u32).clamp(20, 80) as u16
}

fn right_split_area(content_area: Rect, left_percent: u16) -> Rect {
    let split = SplitPane::new(
        Axis::Horizontal,
        vec![Constraint::Percent(left_percent), Constraint::Fill(1)],
    );
    let (cols, _) = split_panes(content_area, &split);
    cols.get(1).copied().unwrap_or(content_area)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlanScrollTarget {
    Stream,
    FileMap,
    Adr,
}

fn plan_scroll_target(state: &AppState, col: u16, row: u16) -> PlanScrollTarget {
    let Some(content_area) = content_rect_from_size(state, terminal::size().ok()) else {
        return PlanScrollTarget::Stream;
    };
    let main_split = SplitPane::new(
        Axis::Horizontal,
        vec![
            Constraint::Percent(state.panels.plan_main_percent),
            Constraint::Fill(1),
        ],
    );
    let (cols, _) = split_panes(content_area, &main_split);

    if cols.first().copied().is_some_and(|rect| rect_contains(rect, col, row)) {
        return PlanScrollTarget::Stream;
    }

    let Some(right) = cols.get(1).copied() else {
        return PlanScrollTarget::Stream;
    };
    let right_split = SplitPane::new(
        Axis::Vertical,
        vec![
            Constraint::Percent(state.panels.plan_right_percent),
            Constraint::Fill(1),
        ],
    );
    let (rows, _) = split_panes(right, &right_split);
    if rows.first().copied().is_some_and(|rect| rect_contains(rect, col, row)) {
        return PlanScrollTarget::FileMap;
    }
    if rows.get(1).copied().is_some_and(|rect| rect_contains(rect, col, row)) {
        return PlanScrollTarget::Adr;
    }

    PlanScrollTarget::Stream
}

fn rect_contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.right() && row >= rect.y && row < rect.bottom()
}

fn screen_rect_from_size(size: Option<(u16, u16)>) -> Option<crate::term::Rect> {
    #[cfg(test)]
    let (w, h) = size.unwrap_or((80, 24));

    #[cfg(not(test))]
    let (w, h) = size?;

    Some(crate::term::Rect::new(0, 0, w, h))
}

fn content_rect_from_size(state: &AppState, size: Option<(u16, u16)>) -> Option<crate::term::Rect> {
    let area = screen_rect_from_size(size)?;
    Some(layout_areas(area, &state.panels).content)
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
    {
        let _ = clipboard::copy_text(&entry.content);
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
        // La tab por defecto pasó a ser ENJAMBRE, donde la rueda desplaza el
        // panel del enjambre y no el historial. Estos tests fijan MESA
        // explícitamente porque lo que prueban es el scroll del chat.
        state.active_tab = TabId::Mesa;
        state
    }

    // ── El badge ▶ RESUME por fin tiene una acción ────────────────────────────

    /// Un panel de enjambre con una tarea interrumpida esperando continuar.
    fn state_with_pending_resume() -> AppState {
        let mut state = AppState::default();
        state.active_tab = TabId::Swarm;
        state.dashboard.resume = Some(crate::state::ResumeInfo {
            task_id: "task-interrumpida".to_string(),
            checkpoint_id: "cp-1".to_string(),
            reason: "Interrupted at level 2".to_string(),
        });
        state
    }

    #[test]
    fn the_resume_badge_sends_nothing_on_the_first_press() {
        let mut state = state_with_pending_resume();

        let handled = handle_dashboard_key(
            &mut state,
            KeyCode::Enter,
            KeyModifiers::NONE,
            false,
        );

        assert!(handled);
        assert!(state.dashboard.resume_confirm, "the first press arms");
        assert!(
            state.pending_ipc.is_empty(),
            "arming must not act: {:?}",
            state.pending_ipc
        );
    }

    #[test]
    fn the_second_press_sends_the_task_resume() {
        let mut state = state_with_pending_resume();
        state.dashboard.resume_confirm = true;

        handle_dashboard_key(&mut state, KeyCode::Enter, KeyModifiers::NONE, false);

        assert!(!state.dashboard.resume_confirm, "the confirm is consumed");
        assert_eq!(state.pending_ipc.len(), 1, "{:?}", state.pending_ipc);
        assert!(
            matches!(
                &state.pending_ipc[0],
                TuiMessage::TaskResume { task_id } if task_id == "task-interrumpida"
            ),
            "expected TaskResume, got {:?}",
            state.pending_ipc[0]
        );
        // The badge is consumed: leaving it up would let Enter re-arm forever.
        assert!(state.dashboard.resume.is_none());
    }

    #[test]
    fn enter_while_typing_still_sends_the_message_not_a_resume() {
        let mut state = state_with_pending_resume();

        // `typing: true` is what keeps Enter a "send" keystroke.
        let handled = handle_dashboard_key(&mut state, KeyCode::Enter, KeyModifiers::NONE, true);

        assert!(!handled, "the key falls through to the input");
        assert!(!state.dashboard.resume_confirm);
        assert!(state.pending_ipc.is_empty());
    }

    #[test]
    fn escape_cancels_an_armed_resume() {
        let mut state = state_with_pending_resume();
        state.dashboard.resume_confirm = true;

        handle_dashboard_key(&mut state, KeyCode::Esc, KeyModifiers::NONE, false);

        assert!(!state.dashboard.resume_confirm);
        assert!(state.pending_ipc.is_empty());
        // The offer survives: cancelling must not throw away the task.
        assert!(state.dashboard.resume.is_some());
    }

    // ── Provider + API key desde el hub de settings ────────────────────────────

    fn provider_row(id: &str, has_key: bool, browser_login: bool) -> crate::state::SettingsProvider {
        crate::state::SettingsProvider {
            id: id.to_string(),
            name: id.to_string(),
            model: format!("{id}/default"),
            is_active: false,
            has_key,
            browser_login,
            models: vec![format!("{id}/default")],
        }
    }

    fn hub_state(rows: Vec<crate::state::SettingsProvider>) -> AppState {
        let mut state = AppState::default();
        state.modal = ModalState::Settings(SettingsHubState {
            providers: rows,
            ..Default::default()
        });
        state
    }

    fn press(state: &mut AppState, code: KeyCode) {
        handle_key_event(state, KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::NONE,
        });
    }

    fn type_text(state: &mut AppState, text: &str) {
        for c in text.chars() {
            press(state, KeyCode::Char(c));
        }
    }

    fn pending(state: &AppState) -> Vec<&TuiMessage> {
        state.pending_ipc.iter().collect()
    }

    #[test]
    fn enter_en_un_provider_sin_clave_pide_la_clave_sin_relistar_providers() {
        let mut state = hub_state(vec![
            provider_row("anthropic", true, false),
            provider_row("openai", false, false),
        ]);
        if let ModalState::Settings(hub) = &mut state.modal {
            hub.selected_row = 1;
        }

        press(&mut state, KeyCode::Enter);

        // El modal es local: un único campo secreto, y el id del provider ya
        // elegido viaja en la acción. No hay desplegable de providers.
        let ModalState::Config(modal) = &state.modal else {
            panic!("Enter sobre un provider sin clave debe abrir el formulario de clave");
        };
        assert_eq!(modal.fields.len(), 1, "no debe volver a preguntar el provider");
        assert_eq!(modal.fields[0].key, "api_key");
        assert_eq!(modal.fields[0].kind, ModalFieldKind::Secret, "la clave se enmascara");
        assert!(modal.fields[0].required, "sin clave previa el campo es obligatorio");
        assert_eq!(
            modal.action,
            Some(ModalAction::ProviderActivate { provider_id: "openai".to_string() }),
        );
        // Nada sale hacia Bun hasta que el usuario confirme.
        assert!(pending(&state).is_empty(), "no debe enviar nada antes de confirmar");
    }

    #[test]
    fn confirmar_la_clave_manda_el_id_y_vuelve_al_hub() {
        let mut state = hub_state(vec![provider_row("openai", false, false)]);
        press(&mut state, KeyCode::Enter);
        type_text(&mut state, "sk-test-123");

        press(&mut state, KeyCode::Enter);

        let msgs = pending(&state);
        assert!(
            matches!(msgs[0], TuiMessage::ProviderActivate { provider_id, api_key }
                if provider_id == "openai" && api_key.as_deref() == Some("sk-test-123")),
            "esperaba ProviderActivate con la clave escrita, llegó {:?}",
            msgs[0],
        );
        // El hub vuelve a estar montado: si no, el `SettingsData` de respuesta se
        // descartaría y el usuario vería las filas viejas.
        assert!(
            matches!(&state.modal, ModalState::Settings(hub) if hub.loading),
            "debe volver al hub en estado cargando, quedó {:?}",
            state.modal,
        );
    }

    #[test]
    fn una_clave_solo_espacios_no_cuenta_como_clave_nueva() {
        let mut state = hub_state(vec![provider_row("openai", false, false)]);
        press(&mut state, KeyCode::Enter);
        type_text(&mut state, "   ");

        press(&mut state, KeyCode::Enter);

        // `required` solo mira que no esté vacío, así que un campo de espacios sí
        // pasa; el `.trim()` al construir el mensaje es lo que evita guardar "".
        assert!(
            matches!(pending(&state)[0], TuiMessage::ProviderActivate { api_key: None, .. }),
            "una clave de espacios debe viajar como None, no como cadena vacía",
        );
    }

    #[test]
    fn provider_con_clave_se_activa_sin_abrir_modal() {
        let mut state = hub_state(vec![provider_row("anthropic", true, false)]);
        press(&mut state, KeyCode::Enter);

        assert!(
            matches!(&state.modal, ModalState::Settings(_)),
            "no hay nada que preguntar: debe activar directo",
        );
        assert!(
            matches!(pending(&state)[0], TuiMessage::ProviderActivate { provider_id, api_key: None }
                if provider_id == "anthropic"),
        );
    }

    #[test]
    fn login_de_navegador_no_pregunta_api_key() {
        // hivecode-free hace PKCE: pedirle una clave sería un callejón sin salida.
        let mut state = hub_state(vec![provider_row("hivecode-free", false, true)]);
        press(&mut state, KeyCode::Enter);

        assert!(matches!(&state.modal, ModalState::Settings(_)), "no debe abrir formulario");
        assert!(
            matches!(pending(&state)[0], TuiMessage::ProviderActivate { provider_id, .. }
                if provider_id == "hivecode-free"),
        );
    }

    #[test]
    fn esc_en_el_formulario_de_clave_vuelve_al_hub_sin_enviar_nada() {
        let mut state = hub_state(vec![provider_row("openai", false, false)]);
        press(&mut state, KeyCode::Enter);
        state.pending_ipc.clear();

        press(&mut state, KeyCode::Esc);

        assert!(matches!(&state.modal, ModalState::Settings(hub) if !hub.loading));
        assert!(
            pending(&state).is_empty(),
            "cancelar no debe mandar ProviderActivate ni ModalCancel",
        );
    }

    #[test]
    fn enter_ya_no_manda_provider_set_como_mensaje_de_chat() {
        // El bug reportado: `/provider set <id>` hacía que Bun ignorara el id y
        // volviera a pintar la lista de providers.
        let mut state = hub_state(vec![provider_row("openai", false, false)]);
        press(&mut state, KeyCode::Enter);

        for msg in pending(&state) {
            assert!(
                !matches!(msg, TuiMessage::Submit { input } if input.starts_with("/provider set")),
                "el hub ya no debe enviar `/provider set`: {:?}",
                msg,
            );
        }
    }

    #[test]
    fn las_acciones_del_hub_dejan_el_hub_montado_para_el_refresco() {
        // Con el hub cerrado, el `SettingsData` de respuesta se descartaba y había
        // que volver a pulsar F2.
        let mut state = hub_state(vec![provider_row("openai", true, false)]);
        press(&mut state, KeyCode::Char('d'));

        assert!(
            matches!(&state.modal, ModalState::Settings(hub) if hub.loading),
            "tras una acción el hub debe quedarse montado cargando",
        );
    }

    #[test]
    fn el_modal_de_la_clave_solo_tiene_un_campo() {
        let mut state = hub_state(vec![provider_row("openai", false, false)]);
        press(&mut state, KeyCode::Enter);

        let ModalState::Config(modal) = &state.modal else { panic!("se esperaba el formulario") };
        // `handle_config_modal_key` sale temprano si no hay campos: un modal de
        // cero campos sería un formulario imposible de cerrar con Enter.
        assert!(!modal.fields.is_empty());
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

    #[test]
    fn plan_scroll_uses_arrow_keys_when_input_is_empty() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Plan;

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(state.plan.scroll, 1);

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(state.plan.scroll, 0);
    }

    #[test]
    fn plan_mouse_scroll_targets_right_side_panels() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Plan;

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 70,
            row: 5,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(state.filemap.scroll, 3);
        assert_eq!(state.plan.scroll, 0);

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 70,
            row: 14,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(state.adrs.scroll, 3);
        assert_eq!(state.filemap.scroll, 3);
    }

    #[test]
    fn code_scroll_uses_wheel_without_entering_history_navigation() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Code;
        state.history_nav_mode = true;
        state.history.selected = Some(1);

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });

        assert_eq!(state.diff.scroll, 3);
        assert_eq!(state.history.selected, Some(1));
    }

    #[test]
    fn code_scroll_uses_arrow_keys_when_input_is_empty() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Code;

        let key = KeyEvent::new(KeyCode::Down, KeyModifiers::NONE);
        let _ = handle_key_event(&mut state, key);

        assert_eq!(state.diff.scroll, 1);
    }

    #[test]
    fn review_scroll_uses_wheel_without_entering_history_navigation() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Review;
        state.history_nav_mode = true;
        state.history.selected = Some(1);

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });

        assert_eq!(state.adrs.scroll, 3);
        assert_eq!(state.history.selected, Some(1));
    }

    #[test]
    fn dashboard_scroll_uses_wheel_without_entering_history_navigation() {
        let mut state = mk_state_with_entries(3);
        state.active_tab = TabId::Swarm;
        state.history_nav_mode = true;
        state.history.selected = Some(1);

        handle_mouse_event(&mut state, MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });

        assert_eq!(state.dashboard_scroll, 3);
        assert_eq!(state.history.selected, Some(1));
    }

    #[test]
    fn review_action_requires_second_confirmation() {
        let mut state = mk_state_with_entries(1);
        state.active_tab = TabId::Review;
        state.session.mode = ReplMode::Approval;

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT));
        assert!(matches!(
            state.modal,
            ModalState::ReviewConfirm(ReviewConfirmState {
                action: ReviewAction::Approve
            })
        ));
        assert!(state.pending_ipc.is_empty());

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(state.modal, ModalState::None));
        assert!(matches!(
            state.pending_ipc.last(),
            Some(TuiMessage::Submit { input }) if input == "/approve"
        ));
    }

    fn type_str(state: &mut AppState, text: &str) {
        for ch in text.chars() {
            let _ = handle_key_event(&mut *state, KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
        }
    }

    #[test]
    fn typing_in_dashboard_auto_mode_does_not_halt_the_swarm() {
        let mut state = mk_state_with_entries(1);
        state.active_tab = TabId::Swarm;
        state.session.mode = ReplMode::Auto;

        type_str(&mut state, "hola");

        assert_eq!(state.input.value(), "hola");
        assert!(!state.dashboard.halt_confirm);
        assert!(state.pending_ipc.is_empty());
    }

    #[test]
    fn typing_in_immersive_layouts_does_not_halt_the_swarm() {
        for tab in [TabId::Plan, TabId::Code, TabId::Review] {
            let mut state = mk_state_with_entries(1);
            state.active_tab = tab;
            state.session.mode = ReplMode::Auto;

            type_str(&mut state, "haz un fix");

            assert_eq!(state.input.value(), "haz un fix", "tab {tab:?}");
            assert!(!state.dashboard.halt_confirm, "tab {tab:?}");
            assert!(state.pending_ipc.is_empty(), "tab {tab:?}");
        }
    }

    #[test]
    fn typing_in_dashboard_approval_mode_does_not_open_review_modal() {
        let mut state = mk_state_with_entries(1);
        state.active_tab = TabId::Swarm;
        state.session.mode = ReplMode::Approval;

        type_str(&mut state, "arregla");

        assert_eq!(state.input.value(), "arregla");
        assert!(matches!(state.modal, ModalState::None));
    }

    #[test]
    fn halt_requires_a_second_confirmation() {
        let mut state = mk_state_with_entries(1);
        state.active_tab = TabId::Swarm;
        state.session.mode = ReplMode::Auto;

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Char('h'), KeyModifiers::ALT));
        assert!(state.dashboard.halt_confirm);
        assert!(state.pending_ipc.is_empty(), "la primera pulsación solo arma la confirmación");

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(!state.dashboard.halt_confirm);
        assert!(matches!(
            state.pending_ipc.last(),
            Some(TuiMessage::Submit { input }) if input == "/halt"
        ));
    }

    #[test]
    fn esc_cancels_halt_confirmation_even_while_typing() {
        let mut state = mk_state_with_entries(1);
        state.active_tab = TabId::Swarm;
        state.session.mode = ReplMode::Auto;

        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Char('h'), KeyModifiers::ALT));
        assert!(state.dashboard.halt_confirm);

        type_str(&mut state, "no");
        let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

        assert!(!state.dashboard.halt_confirm);
        assert!(state.pending_ipc.is_empty());
    }

    #[test]
    fn arrows_move_the_cursor_when_there_is_text_to_edit() {
        for tab in [TabId::Plan, TabId::Code, TabId::Review, TabId::Swarm] {
            let mut state = mk_state_with_entries(1);
            state.active_tab = tab;
            type_str(&mut state, "abc");
            let before = state.checkpoints.selected;

            let _ = handle_key_event(&mut state, KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));

            assert_eq!(state.checkpoints.selected, before, "tab {tab:?}");
            assert_eq!(state.input.cursor, 2, "tab {tab:?}");
        }
    }

    #[test]
    fn split_drag_updates_panel_percent() {
        let mut state = AppState::default();
        state.active_tab = TabId::Code;
        state.panels.begin_drag("code:main".to_string());

        assert!(update_active_split_drag(&mut state, 60, 6));

        assert!(state.panels.code_main_percent > 55);
    }

    #[test]
    fn chrome_drag_updates_input_height() {
        let mut state = AppState::default();
        state.panels.begin_drag("chrome:input".to_string());

        assert!(update_active_split_drag(&mut state, 0, 18));

        assert!(state.panels.input_height > 4);
    }

    #[test]
    fn the_tabbar_row_follows_the_configured_header_height() {
        // Regression: the click path hardcoded row 2, so a header taller or
        // shorter than 2 rows made the tabs unclickable.
        for header_height in 1..=5u16 {
            let slot = crate::term::Rect::new(0, header_height, 120, 1);
            let state = AppState::default();
            let plan = tabbar::tab_regions(slot, &state)
                .into_iter()
                .find(|(tab, _)| *tab == TabId::Plan)
                .map(|(_, rect)| rect)
                .expect("plan region");

            assert_eq!(
                tabbar::tab_at_col(slot, plan.x, &state),
                Some(TabId::Plan),
                "header_height={header_height}"
            );
        }
    }

    #[test]
    fn a_header_height_change_moves_the_tabbar_with_it() {
        let mut state = AppState::default();
        assert_eq!(state.panels.header_height.clamp(1, 5), 2);
        state.panels.set_chrome_height("chrome:header", 4);
        assert_eq!(state.panels.header_height.clamp(1, 5), 4);
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
            let ModalState::Config(modal) = &state.modal else { return };
            // Modal local de la TUI: no hay nadie en Bun esperando un `modal_cancel`.
            if modal.action.is_some() {
                close_to_settings_hub(state, false);
                return;
            }
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
            let ModalState::Config(modal) = &state.modal else { return };
            let ok = modal.fields.iter().enumerate().all(|(i, f)| {
                !f.required || !modal.values.get(i).map(String::is_empty).unwrap_or(true)
            });
            if !ok { return; }

            // Modal local: la respuesta va en su propio mensaje IPC. Mandar
            // `ModalSubmit` aqui dejaria la clave sin destino, porque en Bun no
            // hay ningun `showConfigModal` parked que la escuche.
            let local_action = {
                let ModalState::Config(modal) = &state.modal else { return };
                modal.action.clone()
            };
            match local_action {
                Some(ModalAction::ProviderActivate { provider_id }) => {
                    let api_key = {
                        let ModalState::Config(modal) = &state.modal else { return };
                        let raw = modal
                            .fields
                            .iter()
                            .position(|f| f.key == "api_key")
                            .and_then(|i| modal.values.get(i))
                            .map(|v| v.trim().to_string())
                            .unwrap_or_default();
                        (!raw.is_empty()).then_some(raw)
                    };
                    close_to_settings_hub(state, true);
                    state.pending_ipc.push(TuiMessage::ProviderActivate { provider_id, api_key });
                }
                // Modales de Bun: `command` identifica su handler.
                None => {
                    let ModalState::Config(modal) = &mut state.modal else { return };
                    let command = modal.command.clone();
                    let values: std::collections::HashMap<String, String> = modal.fields.iter()
                        .enumerate()
                        .map(|(i, f)| (f.key.clone(), modal.values.get(i).cloned().unwrap_or_default()))
                        .collect();
                    state.modal = ModalState::None;
                    state.pending_ipc.push(TuiMessage::ModalSubmit { command, values });
                }
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

Sesiones
──────────────
/session list     Sesiones de este proyecto, con su título
/session resume   Reanudar una sesión (TUI) o por id
/session new      Cerrar la actual; el siguiente mensaje abre otra
/session status   Estado de la sesión activa
/compact  Compactar contexto

El badge [▶ RESUME] del panel del enjambre reanuda una tarea que quedó
a medias: Enter para armarlo, Enter otra vez para continuarla.

Vistas (tabs)
═════════════
1 / /layout enjambre   El enjambre en vivo: tool calls y esperas
2 / /layout plan       Fases del plan y de quién depende cada una
3 / /layout mesa        Chat + narración + razonamiento
4 / /layout codigo      Cambios en código + workers
5 / /layout revision    Revisión + aprobación
6 / /layout taller      Agentes, herramientas, habilidades, MCP, registro
/auto                  Reactivar navegación automática de layouts
/welcome               Volver a la pantalla de bienvenida
/habilidades           Catálogo de habilidades (de quién es cada una)
/ficha <agente>        Ficha del especialista: qué puede y qué le falta

Atajos
══════
i                      Ficha del especialista (global)
f                      Filtrar el stream por agente
s                      Habilidades del especialista abierto (en la ficha)

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
