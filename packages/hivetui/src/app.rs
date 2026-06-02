use std::io::{stdin, stdout, IsTerminal, Stdout, Write};
use chrono::Local;
use color_eyre::eyre::{bail, Result};
use crossterm::{
    cursor::Hide,
    cursor::MoveTo,
    cursor::Show,
    event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream,
            DisableBracketedPaste, EnableBracketedPaste},
    execute,
    terminal::{self, disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use tokio::time::{self, Duration};
use tokio::signal::unix::{signal, SignalKind};

use crate::{
    controller::{handle_key_event, handle_mouse_event, handle_paste_event},
    ipc::{self, TuiMessage},
    renderer,
    state::{AppState, Role},
    term::Canvas,
};

/// Headless runner: no TTY required.
/// Connects to IPC, processes messages, emits canvas snapshots as NDJSON to stdout.
/// Activated by env var HIVETUI_HEADLESS=1.
pub async fn run_headless() -> Result<()> {
    use std::env;

    let w: u16 = env::var("HIVETUI_COLS").ok().and_then(|v| v.parse().ok()).unwrap_or(120);
    let h: u16 = env::var("HIVETUI_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);

    let mut ipc_ch = ipc::connect().await.map_err(|e| {
        color_eyre::eyre::eyre!("headless: IPC connect failed: {e}")
    })?;

    let _ = ipc_ch.tx.try_send(TuiMessage::Ready);

    let mut state = AppState::default();
    state.show_welcome = false;
    state.cursor_visible = true;
    state.show_workers = true;

    let mut canvas = Canvas::new(w, h);
    let mut frame: u64 = 0;
    let mut stdout = stdout();

    let emit = |canvas: &mut Canvas, state: &mut AppState, frame: u64, out: &mut dyn Write| {
        renderer::render(canvas, state);
        let rows = canvas.to_text_rows();
        let tab = format!("{:?}", state.active_tab).to_lowercase();
        let mode = format!("{:?}", state.session.mode).to_lowercase();
        let running = state.running;
        let row_json: Vec<String> = rows.iter().map(|r| {
            // JSON-encode each row string manually (escape backslash and double-quote)
            let escaped = r.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{escaped}\"")
        }).collect();
        let _ = writeln!(
            out,
            r#"{{"frame":{frame},"tab":"{tab}","mode":"{mode}","running":{running},"rows":[{}]}}"#,
            row_json.join(",")
        );
        let _ = out.flush();
    };

    // Initial frame (empty state)
    emit(&mut canvas, &mut state, frame, &mut stdout);

    loop {
        tokio::select! {
            biased;
            Some(msg) = ipc_ch.critical.recv() => {
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            Some(msg) = ipc_ch.normal.recv() => {
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            Some(msg) = ipc_ch.low.recv() => {
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            else => break,
        }
    }

    Ok(())
}

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
    state.show_workers = true;
    state.show_welcome = true;
    state.clock = Local::now().format("%H:%M:%S").to_string();
    let mut events = EventStream::new();
    let mut anim_tick_timer = time::interval(Duration::from_millis(120));
    let mut frame_tick = time::interval(Duration::from_millis(16));
    anim_tick_timer.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    frame_tick.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut should_quit = false;
    let mut draw_pending = false;

    session.draw(&mut state)?;

    let mut sigterm = signal(SignalKind::terminate())
        .unwrap_or_else(|_| signal(SignalKind::hangup()).expect("signal setup failed"));

    while !should_quit {
        tokio::select! {
            biased;

            // 1. Mensajes críticos (ConflictAlert, Error) — máxima prioridad
            Some(msg) = ipc_ch.critical.recv() => {
                state.apply_message(msg);
                session.draw(&mut state)?;
                draw_pending = false;
            }
            // 2a. Ctrl-C
            _ = tokio::signal::ctrl_c() => {
                let _ = ipc_ch.tx.try_send(TuiMessage::Exit);
                should_quit = true;
            }
            // 2b. SIGTERM — Bun sends this when it shuts down the child process
            _ = sigterm.recv() => {
                should_quit = true;
            }
            // 3. Eventos de teclado y ratón: latencia interactiva, dibujar ya.
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
                                    // tui-launcher nunca envía status{running:true} antes del
                                    // resultado, así que lo marcamos aquí para activar la
                                    // live-activity de Focus y el routing post-tarea.
                                    state.running = true;
                                }
                            }
                        }
                        // Drenar mensajes IPC pendientes escritos por el controller
                        for msg in state.pending_ipc.drain(..) {
                            let _ = ipc_ch.tx.try_send(msg);
                        }
                        session.draw(&mut state)?;
                        draw_pending = false;
                    }
                    Some(Ok(Event::Resize(w, h))) => {
                        session.resize(w, h);
                        session.draw(&mut state)?;
                        draw_pending = false;
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        handle_mouse_event(&mut state, mouse);
                        session.draw(&mut state)?;
                        draw_pending = false;
                    }
                    Some(Ok(Event::Paste(text))) => {
                        handle_paste_event(&mut state, text);
                        for msg in state.pending_ipc.drain(..) {
                            let _ = ipc_ch.tx.try_send(msg);
                        }
                        session.draw(&mut state)?;
                        draw_pending = false;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(err.into()),
                    None => break,
                }
            }
            // 4. Tick de reloj y animación bee (cursor ya no parpadea)
            _ = anim_tick_timer.tick() => {
                state.anim_tick = (state.anim_tick + 1) % 8;
                state.slow_tick = (state.slow_tick + 1) % 30;
                state.clock = Local::now().format("%H:%M:%S").to_string();
                draw_pending = true;
            }
            // 5. Frame cap: coalescer ráfagas IPC y animación a ~60fps.
            _ = frame_tick.tick() => {
                if draw_pending {
                    session.draw(&mut state)?;
                    draw_pending = false;
                }
            }
            // 6. Mensajes normales (Init, WorkerUpdate, CheckpointCreated, AssistantDone)
            // Patrón "drain inbox" de tuie: procesar todos los mensajes del buffer
            // antes del siguiente draw para evitar renders intermedios durante búsqueda.
            Some(msg) = ipc_ch.normal.recv() => {
                state.apply_message(msg);
                while let Ok(extra) = ipc_ch.normal.try_recv() {
                    state.apply_message(extra);
                }
                draw_pending = true;
            }
            // 7. Mensajes low (ThoughtChunk, FileRiskUpdate, AssistantChunk)
            Some(msg) = ipc_ch.low.recv() => {
                state.apply_message(msg);
                while let Ok(extra) = ipc_ch.low.try_recv() {
                    state.apply_message(extra);
                }
                draw_pending = true;
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
        let _ = execute!(stdout, LeaveAlternateScreen, Show, DisableBracketedPaste, DisableMouseCapture);
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
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste, Hide)?;
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
        let _ = execute!(self.stdout, LeaveAlternateScreen, Show, DisableBracketedPaste, DisableMouseCapture);
    }
}
