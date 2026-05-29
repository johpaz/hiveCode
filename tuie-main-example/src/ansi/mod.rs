//! Native ANSI/VT terminal backend.

pub mod input;
pub mod output;
pub mod query;

pub use output::*;

use crate::prelude::*;

/// Terminal light/dark color-scheme preference.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ColorScheme {
    /// Dark background.
    Dark,
    /// Light background.
    Light,
}

impl std::fmt::Display for ColorScheme {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Dark => write!(f, "Dark"),
            Self::Light => write!(f, "Light"),
        }
    }
}

/// A queryable terminal color slot.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum ColorType {
    /// 256-color palette entry `n` (OSC 4).
    Palette(u8),
    /// Default foreground (OSC 10).
    Foreground,
    /// Default background (OSC 11).
    Background,
    /// Text cursor color (OSC 12).
    Cursor,
    /// Mouse pointer foreground (OSC 13).
    PointerForeground,
    /// Mouse pointer background (OSC 14).
    PointerBackground,
    /// Tektronix foreground (OSC 15).
    TektronixForeground,
    /// Tektronix background (OSC 16).
    TektronixBackground,
    /// Highlight background (OSC 17).
    HighlightBackground,
    /// Tektronix cursor (OSC 18).
    TektronixCursor,
    /// Highlight foreground (OSC 19).
    HighlightForeground,
}

impl ColorType {
    /// Maps an OSC number (10..=19) to its `ColorType`.
    pub fn from_osc_number(n: u8) -> Option<Self> {
        Some(match n {
            10 => Self::Foreground,
            11 => Self::Background,
            12 => Self::Cursor,
            13 => Self::PointerForeground,
            14 => Self::PointerBackground,
            15 => Self::TektronixForeground,
            16 => Self::TektronixBackground,
            17 => Self::HighlightBackground,
            18 => Self::TektronixCursor,
            19 => Self::HighlightForeground,
            _ => return None,
        })
    }

    /// Returns the OSC number for this color slot.
    pub fn get_osc_number(&self) -> u8 {
        match self {
            Self::Palette(_) => 4,
            Self::Foreground => 10,
            Self::Background => 11,
            Self::Cursor => 12,
            Self::PointerForeground => 13,
            Self::PointerBackground => 14,
            Self::TektronixForeground => 15,
            Self::TektronixBackground => 16,
            Self::HighlightBackground => 17,
            Self::TektronixCursor => 18,
            Self::HighlightForeground => 19,
        }
    }
}

/// A parsed color reported by the terminal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ColorEntry {
    /// The color slot.
    pub color_type: ColorType,
    /// The red channel.
    pub r: u8,
    /// The green channel.
    pub g: u8,
    /// The blue channel.
    pub b: u8,
}

/// A decoded mouse event.
#[derive(Clone, PartialEq, Debug)]
pub struct MouseInput {
    /// The mouse action, as a native [`Trigger`].
    pub trigger: Trigger,
    /// The column position, 0-indexed.
    pub column: u16,
    /// The row position, 0-indexed.
    pub row: u16,
    /// The modifier keys held during the event.
    pub modifiers: Modifiers,
}

/// A single decoded terminal event.
#[derive(Clone, PartialEq, Debug)]
pub enum ParsedEvent {
    /// A decoded keypress as a [`Chord`].
    Key(Chord),
    /// A decoded mouse event.
    Mouse(MouseInput),
    /// Terminal resized to `(columns, rows)`.
    Resize(u16, u16),
    /// Focus gained (`true`) or lost (`false`).
    Focus(bool),
    /// A bracketed-paste payload.
    Paste(String),
    /// A color-scheme change report.
    ColorScheme(ColorScheme),
    /// A primary device attributes reply.
    PrimaryDeviceAttributes(Vec<u16>),
    /// A terminal name/version reply.
    XtVersion(String),
    /// A Kitty graphics protocol reply.
    KittyGraphicsReply { id: u32, ok: bool },
    /// The cell size in pixels.
    CellPixelSize { width: u16, height: u16 },
    /// The window size in pixels.
    WindowPixelSize { width: u16, height: u16 },
    /// A terminal color query reply.
    Color(ColorEntry),
    /// A DEC mode state report.
    DecModeReport { mode: u16, status: u8 },
}

#[cfg(unix)]
pub use unix::{disable_raw_mode, enable_raw_mode, is_raw_mode_enabled, size, write_query, Reader};

#[cfg(unix)]
mod unix {
    use super::input::Parser;
    use super::ParsedEvent;
    use std::io::{self, Read, Write};
    use std::os::unix::io::{AsRawFd, RawFd};
    use std::os::unix::net::UnixStream;
    use std::sync::Mutex;
    use std::time::Duration;

    const BUFFER_SIZE: usize = 1024;

    struct RawMode {
        termios: libc::termios,
        fd: RawFd,
        _tty: Option<std::fs::File>,
    }

    static PRIOR_TERMIOS: Mutex<Option<RawMode>> = Mutex::new(None);

    /// Whether raw mode is currently enabled.
    pub fn is_raw_mode_enabled() -> bool {
        PRIOR_TERMIOS.lock().unwrap().is_some()
    }

    /// Enables terminal raw mode (idempotent).
    pub fn enable_raw_mode() -> io::Result<()> {
        let mut prior = PRIOR_TERMIOS.lock().unwrap();
        if prior.is_some() {
            return Ok(());
        }
        let (fd, tty) = open_tty()?;
        let mut termios = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let original = termios;
        unsafe { libc::cfmakeraw(&mut termios) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &termios) } != 0 {
            return Err(io::Error::last_os_error());
        }
        *prior = Some(RawMode { termios: original, fd, _tty: tty });
        Ok(())
    }

    /// Restores the terminal mode saved by [`enable_raw_mode`].
    pub fn disable_raw_mode() -> io::Result<()> {
        let mut prior = PRIOR_TERMIOS.lock().unwrap();
        if let Some(state) = prior.as_ref() {
            let rc = unsafe { libc::tcsetattr(state.fd, libc::TCSANOW, &state.termios) };
            if rc != 0 {
                return Err(io::Error::last_os_error());
            }
            *prior = None;
        }
        Ok(())
    }

    /// Returns the terminal size as `(columns, rows)`.
    pub fn size() -> io::Result<(u16, u16)> {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };
        if rc != 0 || ws.ws_col == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((ws.ws_col, ws.ws_row))
    }

    /// Writes terminal query bytes to the tty.
    pub fn write_query(bytes: &[u8]) -> io::Result<()> {
        if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open("/dev/tty") {
            tty.write_all(bytes)?;
            tty.flush()
        } else {
            let mut out = io::stdout();
            out.write_all(bytes)?;
            out.flush()
        }
    }

    fn open_tty() -> io::Result<(RawFd, Option<std::fs::File>)> {
        match std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty") {
            Ok(file) => {
                let fd = file.as_raw_fd();
                Ok((fd, Some(file)))
            }
            Err(_) => Ok((libc::STDIN_FILENO, None)),
        }
    }

    fn set_nonblocking(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Reads and parses input from the terminal.
    pub struct Reader {
        parser: Parser,
        fd: RawFd,
        _tty: Option<std::fs::File>,
        winch: Option<UnixStream>,
        wake: Option<RawFd>,
        buf: [u8; BUFFER_SIZE],
    }

    impl Reader {
        /// Creates an input reader with `SIGWINCH` resize tracking.
        pub fn new() -> io::Result<Self> {
            let (fd, tty) = open_tty()?;
            set_nonblocking(fd)?;
            let (receiver, sender) = UnixStream::pair()?;
            receiver.set_nonblocking(true)?;
            sender.set_nonblocking(true)?;
            signal_hook::low_level::pipe::register(signal_hook::consts::SIGWINCH, sender)?;
            Ok(Self {
                parser: Parser::new(),
                fd,
                _tty: tty,
                winch: Some(receiver),
                wake: None,
                buf: [0u8; BUFFER_SIZE],
            })
        }

        /// Creates a reader without `SIGWINCH` tracking, for capability queries.
        pub fn for_query() -> io::Result<Self> {
            let (fd, tty) = open_tty()?;
            set_nonblocking(fd)?;
            Ok(Self {
                parser: Parser::new(),
                fd,
                _tty: tty,
                winch: None,
                wake: None,
                buf: [0u8; BUFFER_SIZE],
            })
        }

        /// Sets a wake pipe file descriptor to include in the poll set.
        pub fn set_wake_fd(&mut self, fd: RawFd) {
            self.wake = Some(fd);
        }

        /// Returns whether a decoded event is available within `timeout`.
        pub fn poll(&mut self, timeout: Duration) -> io::Result<bool> {
            if self.parser.has_event() {
                return Ok(true);
            }
            self.wait(Some(timeout))?;
            Ok(self.parser.has_event())
        }

        /// Pops a queued event without blocking.
        pub fn try_read(&mut self) -> Option<ParsedEvent> {
            self.parser.next()
        }

        /// Waits up to `timeout` (or blocks if `None`) for input, returning whether the wake pipe fired.
        pub fn wait(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
            let winch_fd = self.winch.as_ref().map(|s| s.as_raw_fd());
            let mut read_set: libc::fd_set = unsafe { std::mem::zeroed() };
            unsafe { libc::FD_ZERO(&mut read_set) };
            let mut max_fd = self.fd;
            unsafe { libc::FD_SET(self.fd, &mut read_set) };
            if let Some(w) = winch_fd {
                unsafe { libc::FD_SET(w, &mut read_set) };
                max_fd = max_fd.max(w);
            }
            if let Some(w) = self.wake {
                unsafe { libc::FD_SET(w, &mut read_set) };
                max_fd = max_fd.max(w);
            }
            let mut tv = timeout.map(|d| libc::timeval {
                tv_sec: d.as_secs() as libc::time_t,
                tv_usec: d.subsec_micros() as libc::suseconds_t,
            });
            let tv_ptr = tv
                .as_mut()
                .map_or(std::ptr::null_mut(), |t| t as *mut libc::timeval);
            let rc = unsafe {
                libc::select(
                    max_fd + 1,
                    &mut read_set,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    tv_ptr,
                )
            };
            if rc < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    return Ok(false);
                }
                return Err(err);
            }
            if rc == 0 {
                return Ok(false);
            }
            if unsafe { libc::FD_ISSET(self.fd, &read_set) } {
                self.drain_tty()?;
            }
            if let Some(w) = winch_fd {
                if unsafe { libc::FD_ISSET(w, &read_set) } {
                    self.drain_winch()?;
                }
            }
            let woken = match self.wake {
                Some(w) => unsafe { libc::FD_ISSET(w, &read_set) },
                None => false,
            };
            if woken {
                self.drain_wake();
            }
            Ok(woken)
        }

        fn drain_wake(&mut self) {
            let Some(fd) = self.wake else {
                return;
            };
            let mut scratch = [0u8; 64];
            loop {
                let n = unsafe {
                    libc::read(fd, scratch.as_mut_ptr() as *mut libc::c_void, scratch.len())
                };
                if n <= 0 {
                    break;
                }
            }
        }

        fn drain_tty(&mut self) -> io::Result<()> {
            loop {
                let n = unsafe {
                    libc::read(
                        self.fd,
                        self.buf.as_mut_ptr() as *mut libc::c_void,
                        self.buf.len(),
                    )
                };
                if n > 0 {
                    let n = n as usize;
                    self.parser.feed_all(&self.buf[..n]);
                    if n == self.buf.len() {
                        continue;
                    }
                    break;
                } else if n == 0 {
                    break;
                } else {
                    let err = io::Error::last_os_error();
                    match err.kind() {
                        io::ErrorKind::WouldBlock => break,
                        io::ErrorKind::Interrupted => continue,
                        _ => return Err(err),
                    }
                }
            }
            self.parser.flush_escape();
            Ok(())
        }

        fn drain_winch(&mut self) -> io::Result<()> {
            if let Some(stream) = self.winch.as_mut() {
                let mut scratch = [0u8; 64];
                loop {
                    match stream.read(&mut scratch) {
                        Ok(0) => break,
                        Ok(_) => continue,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(e),
                    }
                }
            }
            let (cols, rows) = size()?;
            self.parser.push_event(ParsedEvent::Resize(cols, rows));
            Ok(())
        }
    }

}
