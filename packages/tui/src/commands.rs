#![allow(dead_code)]

use tokio::sync::mpsc::Sender;
use crate::ipc::TuiMessage;
use crate::app::AppState;

/// Result of dispatching a slash command.
pub enum DispatchResult {
    /// Command was recognised and handled; the string is the status message to display.
    Handled(String),
    /// Command is not a slash command — pass through to the agent as normal input.
    PassThrough,
    /// Command wants to quit the TUI.
    Quit,
}

/// Dispatch a slash command entered by the user.
/// Returns `PassThrough` for inputs that don't start with `/`.
pub fn dispatch(input: &str, state: &mut AppState, ipc_tx: &Sender<TuiMessage>) -> DispatchResult {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return DispatchResult::PassThrough;
    }

    let parts: Vec<&str> = trimmed.splitn(2, ' ').collect();
    let cmd = parts[0];
    let arg = parts.get(1).copied().unwrap_or("").trim();

    match cmd {
        "/quit" | "/exit" => {
            let _ = ipc_tx.try_send(TuiMessage::Exit);
            state.should_quit = true;
            DispatchResult::Quit
        }
        "/logs" => {
            state.show_logs = !state.show_logs;
            let msg = if state.show_logs {
                "Panel de logs activo [/logs para cerrar]"
            } else {
                "Panel de logs cerrado"
            };
            DispatchResult::Handled(msg.to_string())
        }
        "/timeline" => {
            state.show_timeline = !state.show_timeline;
            let msg = if state.show_timeline {
                "Timeline de fases activo [/timeline para cerrar]"
            } else {
                "Timeline cerrado"
            };
            DispatchResult::Handled(msg.to_string())
        }
        "/mode" => {
            if !arg.is_empty() {
                use crate::app::ReplMode;
                let new_mode = ReplMode::from(arg);
                state.mode = new_mode.clone();
                let mode_str = new_mode.as_str().to_string();
                let _ = ipc_tx.try_send(TuiMessage::ModeChange { mode: mode_str });
                DispatchResult::Handled(format!("Modo: {}", new_mode.label()))
            } else {
                state.mode = state.mode.next();
                let mode_str = state.mode.as_str().to_string();
                let _ = ipc_tx.try_send(TuiMessage::ModeChange { mode: mode_str });
                DispatchResult::Handled(format!("Modo: {}", state.mode.label()))
            }
        }
        "/clear" => {
            state.history.clear();
            state.history_render_cache.clear();
            DispatchResult::Handled("Historial borrado".to_string())
        }
        "/copy" => {
            state.copy_mode = true;
            if !state.history.is_empty() {
                state.copy_sel = state.history.len().saturating_sub(1);
            }
            DispatchResult::Handled(
                "Modo copia: ↑↓ navegar · Enter copiar · Esc salir".to_string()
            )
        }
        // All other slash commands are forwarded to the Bun gateway as agent input.
        _ => DispatchResult::PassThrough,
    }
}
