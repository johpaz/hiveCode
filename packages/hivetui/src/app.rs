use std::io::{stdin, stdout, IsTerminal, Stdout, Write};
use color_eyre::eyre::{bail, Result};
use crossterm::{
    cursor::MoveTo,
    cursor::Show,
    event::{Event, EventStream},
    execute,
    terminal::{self, disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use tokio::time::{self, Duration};

use crate::{
    controller::{handle_key_event, handle_mouse_event},
    ipc::{self, TuiMessage},
    renderer,
    state::{AppState, Role},
    term::Canvas,
};

pub async fn run() -> Result<()> {
    ensure_tty()?;
    install_panic_hook();

    let mut ipc_ch = ipc::connect().await.unwrap_or_else(|_| {
        // Si el socket falla, arrancar en demo mode
        let (_, c) = tokio::sync::mpsc::channel(1);
        let (_, n) = tokio::sync::mpsc::channel(1);
        let (_, l) = tokio::sync::mpsc::channel(1);
        let (t, _) = tokio::sync::mpsc::channel(1);
        ipc::IpcChannels { critical: c, normal: n, low: l, tx: t }
    });

    // Avisar a Bun que la TUI está lista
    let _ = ipc_ch.tx.try_send(TuiMessage::Ready);

    let mut session = TerminalSession::enter()?;
    let mut state = AppState::default();
    state.cursor_visible = true;
    state.history_nav_mode = false;
    state.history_hscroll = 0;
    let mut events = EventStream::new();
    let mut tick = time::interval(Duration::from_millis(120));
    let mut should_quit = false;

    session.draw(&mut state)?;

    while !should_quit {
        tokio::select! {
            biased;

            // 1. Mensajes críticos (ConflictAlert, Error) — máxima prioridad
            Some(msg) = ipc_ch.critical.recv() => {
                state.apply_message(msg);
                session.draw(&mut state)?;
            }
            // 2. Ctrl-C
            _ = tokio::signal::ctrl_c() => {
                let _ = ipc_ch.tx.try_send(TuiMessage::Exit);
                should_quit = true;
            }
            // 3. Mensajes normales (Init, WorkerUpdate, CheckpointCreated, AssistantDone)
            Some(msg) = ipc_ch.normal.recv() => {
                state.apply_message(msg);
                session.draw(&mut state)?;
            }
            // 4. Tick del cursor
            _ = tick.tick() => {
                state.cursor_visible = !state.cursor_visible;
                session.draw(&mut state)?;
            }
            // 5. Eventos de teclado y ratón
            maybe_event = events.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => {
                        let before = state.history.entries.len();
                        if handle_key_event(&mut state, key) {
                            let _ = ipc_ch.tx.try_send(TuiMessage::Exit);
                            should_quit = true;
                        }
                        // Si Enter añadió una entrada de usuario, enviarla a Bun
                        if state.history.entries.len() > before {
                            if let Some(last) = state.history.entries.last() {
                                if last.role == Role::User {
                                    let _ = ipc_ch.tx.try_send(TuiMessage::Submit {
                                        input: last.content.clone(),
                                    });
                                }
                            }
                        }
                        // Drenar mensajes IPC pendientes escritos por el controller
                        for msg in state.pending_ipc.drain(..) {
                            let _ = ipc_ch.tx.try_send(msg);
                        }
                        session.draw(&mut state)?;
                    }
                    Some(Ok(Event::Resize(w, h))) => {
                        session.resize(w, h);
                        session.draw(&mut state)?;
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        handle_mouse_event(&mut state, mouse);
                        session.draw(&mut state)?;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(err.into()),
                    None => break,
                }
            }
            // 6. Mensajes low (ThoughtChunk, FileRiskUpdate, AssistantChunk)
            Some(msg) = ipc_ch.low.recv() => {
                state.apply_message(msg);
                session.draw(&mut state)?;
            }
        }
    }

    Ok(())
}

fn ensure_tty() -> Result<()> {
    if !stdin().is_terminal() || !stdout().is_terminal() {
        bail!("hivetui requires an interactive TTY (stdin/stdout). Run it directly in a terminal.");
    }
    Ok(())
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = disable_raw_mode();
        let mut stdout = stdout();
        let _ = execute!(stdout, LeaveAlternateScreen, Show);
        previous(panic_info);
    }));
}

struct TerminalSession {
    stdout: Stdout,
    canvas: Canvas,
}

impl TerminalSession {
    fn enter() -> Result<Self> {
        enable_raw_mode()?;

        let mut stdout = stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let (w, h) = terminal::size()?;

        Ok(Self {
            stdout,
            canvas: Canvas::new(w, h),
        })
    }

    fn draw(&mut self, state: &mut AppState) -> Result<()> {
        let (cx, cy) = renderer::render(&mut self.canvas, state);
        self.canvas.flush(&mut self.stdout)?;
        execute!(self.stdout, MoveTo(cx, cy))?;
        self.stdout.flush()?;
        Ok(())
    }

    fn resize(&mut self, w: u16, h: u16) {
        self.canvas.resize(w, h);
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.stdout, LeaveAlternateScreen, Show);
    }
}
