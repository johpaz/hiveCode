use std::io::{stdin, stdout, IsTerminal, Stdout, Write};
use chrono::Local;
use color_eyre::eyre::{bail, Result};
use crossterm::{
    cursor::Hide,
    cursor::MoveTo,
    cursor::Show,
    event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyEvent,
            DisableBracketedPaste, EnableBracketedPaste},
    execute,
    terminal::{self, disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use tokio::io::{AsyncReadExt as _, BufReader};
use tokio::time::{self, Duration};
use tokio::signal::unix::{signal, SignalKind};

use crate::{
    controller::{handle_key_event, handle_mouse_event, handle_paste_event},
    ipc::{self, BunMessage, TuiMessage},
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
        // The tab goes out as its slug, not as the enum's Debug name: renaming a
        // variant would silently break every E2E assertion that waits on
        // `f.tab === "..."`. The slug is the stable public identifier.
        let tab = state.active_tab.slug();
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

    // Headless still reads stdin, so the E2E harness can drive real keystrokes
    // (`\x1bOQ` = F2, `\r` = Enter, ...) through the same reducer the TTY mode
    // uses. Without this only inbound messages could move the state machine, and
    // the whole key-driven surface (settings hub, modals) would be untestable
    // end-to-end.
    //
    // The read lives in its own task because `tokio::select!` needs a branch it
    // can poll again on the next iteration, and an `async {}` wrapping a
    // `BufReader` is consumed on its first poll. A channel hands the bytes over.
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin());
        let mut chunk = [0u8; 1024];
        loop {
            match reader.read(&mut chunk).await {
                // 0 = stdin closed: no more keys will ever arrive.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // A chunk that splits a UTF-8 sequence is skipped; the rest
                    // arrives in a later read.
                    if let Ok(text) = std::str::from_utf8(&chunk[..n]) {
                        if stdin_tx.send(text.to_string()).is_err() { break; }
                    }
                }
            }
        }
    });
    let mut stdin_buf = String::new();

    loop {
        tokio::select! {
            biased;
            Some(msg) = ipc_ch.critical.recv() => {
                headless_ack(&msg, &ipc_ch.tx);
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            Some(msg) = ipc_ch.normal.recv() => {
                headless_ack(&msg, &ipc_ch.tx);
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            Some(msg) = ipc_ch.low.recv() => {
                headless_ack(&msg, &ipc_ch.tx);
                state.apply_message(msg);
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            chunk = stdin_rx.recv() => {
                let Some(chunk) = chunk else { break };
                stdin_buf.push_str(&chunk);
                if !drain_keys(&mut state, &mut stdin_buf, &ipc_ch.tx)? {
                    return Ok(());
                }
                frame += 1;
                emit(&mut canvas, &mut state, frame, &mut stdout);
            }
            else => break,
        }
    }

    Ok(())
}

/// Consume el buffer de entrada aplicando cada tecla al reducer.
/// Devuelve `false` cuando la tecla pide salir de la TUI.
fn drain_keys(
    state: &mut AppState,
    stdin_buf: &mut String,
    tx: &tokio::sync::mpsc::Sender<TuiMessage>,
) -> Result<bool> {
    // Un `\r` suelto no puede esperar más bytes, así que se decodifica de a un
    // parche en lugar de por líneas completas.
    while let Some((key, rest)) = next_key(stdin_buf) {
        *stdin_buf = rest;
        if handle_key_event(state, key) {
            let _ = tx.try_send(TuiMessage::Exit);
            return Ok(false);
        }
        for msg in state.pending_ipc.drain(..) {
            let _ = tx.try_send(msg);
        }
    }
    Ok(true)
}



/// Extrae la siguiente tecla de un buffer de entrada ANSI.
///
/// Cubre lo que los tests necesitan y lo que una terminal envía de verdad:
/// teclas de control, `\r`/`\n`, caracteres UTF-8 completos y las secuencias
/// CSI/SS3 de crossterm (F1-F4, flechas, Supr, Inicio/Fin). Devuelve `None`
/// cuando el buffer está incompleto, para no descartar media secuencia.
fn next_key(buf: &str) -> Option<(KeyEvent, String)> {
    use crossterm::event::{KeyCode, KeyEventKind, KeyEventState, KeyModifiers};

    if buf.is_empty() {
        return None;
    }
    let mut chars = buf.chars();
    let first = chars.next()?;

    let (code, modifiers, consumed): (KeyCode, KeyModifiers, usize) = match first {
        '\x1b' => {
            let rest: String = chars.collect();
            let mut it = rest.chars();
            match it.next() {
                // SS3: F1-F4 y las flechas en modo aplicación.
                Some('O') => match it.next() {
                    Some('P') => (KeyCode::F(1), KeyModifiers::NONE, 3),
                    Some('Q') => (KeyCode::F(2), KeyModifiers::NONE, 3),
                    Some('R') => (KeyCode::F(3), KeyModifiers::NONE, 3),
                    Some('S') => (KeyCode::F(4), KeyModifiers::NONE, 3),
                    Some('A') => (KeyCode::Up, KeyModifiers::NONE, 3),
                    Some('B') => (KeyCode::Down, KeyModifiers::NONE, 3),
                    Some('C') => (KeyCode::Right, KeyModifiers::NONE, 3),
                    Some('D') => (KeyCode::Left, KeyModifiers::NONE, 3),
                    _ => return None,
                },
                // CSI:parameters~ (Supr = 3~, Inicio/Fin = 1~/4~) y CSI letter.
                Some('[') => {
                    let mut seq = String::new();
                    for c in it.by_ref() {
                        seq.push(c);
                        if c.is_ascii_alphabetic() || c == '~' {
                            break;
                        }
                    }
                    let chars_of: Vec<char> = seq.chars().collect();
                    let letter = *chars_of.last()?;
                    let code = match letter {
                        'A' => KeyCode::Up,
                        'B' => KeyCode::Down,
                        'C' => KeyCode::Right,
                        'D' => KeyCode::Left,
                        'H' => KeyCode::Home,
                        'F' => KeyCode::End,
                        '~' => match chars_of.first() {
                            Some('1') | Some('7') => KeyCode::Home,
                            Some('4') | Some('8') => KeyCode::End,
                            Some('3') => KeyCode::Delete,
                            _ => return None,
                        },
                        _ => return None,
                    };
                    // ESC inicial + '[' + los chars de la secuencia.
                    (code, KeyModifiers::NONE, 2 + chars_of.len())
                }
                // ESC suelto: cancelar.
                Some(_) => (KeyCode::Esc, KeyModifiers::NONE, 1),
                // An ESC alone in the buffer resolves as Esc.
                //
                // A real terminal can send ESC by itself (cancel) or start a
                // CSI/SS3 sequence, and telling those apart needs a timing
                // heuristic. Headless mode has no such ambiguity: its stdin is a
                // pipe and the harness writes one whole key at a time, so a
                // trailing ESC can only be a cancel. Waiting for more bytes would
                // leave `Esc` hanging forever.
                None => (KeyCode::Esc, KeyModifiers::NONE, 1),
            }
        }
        '\r' | '\n' => (KeyCode::Enter, KeyModifiers::NONE, 1),
        '\t' => (KeyCode::Tab, KeyModifiers::NONE, 1),
        '\x7f' | '\x08' => (KeyCode::Backspace, KeyModifiers::NONE, 1),
        '\x03' => (KeyCode::Char('c'), KeyModifiers::CONTROL, 1),
        // Un carácter ocupa un `char` del buffer, no sus bytes: un emoji son 4 bytes
        // pero un solo `next_key`.
        c => (KeyCode::Char(c), KeyModifiers::NONE, 1),
    };

    let key = KeyEvent { code, modifiers, kind: KeyEventKind::Press, state: KeyEventState::NONE };
    Some((key, skip_n_chars(buf, consumed)))
}

/// `buf` sin sus primeros `n` caracteres, contando UTF-8 y no bytes.
fn skip_n_chars(buf: &str, n: usize) -> String {
    buf.char_indices()
        .nth(n)
        .map(|(i, _)| buf[i..].to_string())
        .unwrap_or_default()
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
    // `None` while suspended: dropping the stream stops the TUI from consuming
    // stdin bytes that belong to Bun's interactive prompt.
    let mut events = Some(EventStream::new());
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
                let effect = apply_ipc_message(msg, &mut state, &mut session, &ipc_ch.tx)?;
                apply_terminal_effect(effect, &mut events);
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
            maybe_event = async { events.as_mut().expect("guarded by events.is_some()").next().await }, if events.is_some() => {
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
                state.tick_layout_transition();
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
                let effect = apply_ipc_message(msg, &mut state, &mut session, &ipc_ch.tx)?;
                apply_terminal_effect(effect, &mut events);
                while let Ok(extra) = ipc_ch.normal.try_recv() {
                    let effect = apply_ipc_message(extra, &mut state, &mut session, &ipc_ch.tx)?;
                    apply_terminal_effect(effect, &mut events);
                }
                draw_pending = true;
            }
            // 7. Mensajes low (ThoughtChunk, FileRiskUpdate, AssistantChunk)
            Some(msg) = ipc_ch.low.recv() => {
                let effect = apply_ipc_message(msg, &mut state, &mut session, &ipc_ch.tx)?;
                apply_terminal_effect(effect, &mut events);
                while let Ok(extra) = ipc_ch.low.try_recv() {
                    let effect = apply_ipc_message(extra, &mut state, &mut session, &ipc_ch.tx)?;
                    apply_terminal_effect(effect, &mut events);
                }
                draw_pending = true;
            }
        }
    }

    Ok(())
}

/// Headless mode owns no terminal, but the handshake contract still holds:
/// Bun blocks until it gets the acknowledgement back.
fn headless_ack(msg: &BunMessage, tx: &tokio::sync::mpsc::Sender<TuiMessage>) {
    if matches!(msg, BunMessage::Suspend) {
        let _ = tx.try_send(TuiMessage::Suspended);
    }
}

/// Starts/stops reading stdin to match the terminal handover.
fn apply_terminal_effect(effect: TerminalEffect, events: &mut Option<EventStream>) {
    match effect {
        TerminalEffect::Suspended => *events = None,
        TerminalEffect::Resumed => *events = Some(EventStream::new()),
        TerminalEffect::None => {}
    }
}

/// What the terminal must do after an IPC message was applied.
#[derive(PartialEq, Eq)]
enum TerminalEffect {
    None,
    Suspended,
    Resumed,
}

/// Applies an IPC message, handling the suspend/resume handshake before the
/// state machine sees it (both are no-ops there).
fn apply_ipc_message(
    msg: BunMessage,
    state: &mut AppState,
    session: &mut TerminalSession,
    tx: &tokio::sync::mpsc::Sender<TuiMessage>,
) -> Result<TerminalEffect> {
    let effect = match &msg {
        BunMessage::Suspend => {
            session.leave()?;
            // Bun blocks on this reply before touching the terminal.
            let _ = tx.try_send(TuiMessage::Suspended);
            TerminalEffect::Suspended
        }
        BunMessage::Resume => {
            session.reenter()?;
            TerminalEffect::Resumed
        }
        _ => TerminalEffect::None,
    };
    state.apply_message(msg);
    Ok(effect)
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
    /// True while the terminal is handed over to the parent process (see
    /// `leave`). Drawing is a no-op and `Drop` must not restore twice.
    suspended: bool,
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
            suspended: false,
        })
    }

    /// Gives the terminal back so Bun can run an interactive prompt on it.
    /// The caller must also stop reading stdin, or the TUI and the prompt
    /// compete for the same keystrokes.
    fn leave(&mut self) -> Result<()> {
        if self.suspended {
            return Ok(());
        }
        disable_raw_mode()?;
        execute!(self.stdout, LeaveAlternateScreen, Show, DisableBracketedPaste, DisableMouseCapture)?;
        self.stdout.flush()?;
        self.suspended = true;
        Ok(())
    }

    /// Takes the terminal back once the prompt is done. Re-reads the size
    /// because the user may have resized the window while suspended.
    fn reenter(&mut self) -> Result<()> {
        if !self.suspended {
            return Ok(());
        }
        enable_raw_mode()?;
        execute!(self.stdout, EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste, Hide)?;
        let (w, h) = terminal::size()?;
        self.canvas.resize(w, h);
        self.suspended = false;
        Ok(())
    }

    fn draw(&mut self, state: &mut AppState) -> Result<()> {
        if self.suspended {
            return Ok(());
        }
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
        // Already handed back in `leave` — restoring again would leave the
        // parent's prompt in a broken state.
        if self.suspended {
            return;
        }
        let _ = disable_raw_mode();
        let _ = execute!(self.stdout, LeaveAlternateScreen, Show, DisableBracketedPaste, DisableMouseCapture);
    }
}
