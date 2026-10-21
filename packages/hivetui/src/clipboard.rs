use base64::Engine as _;

pub fn osc52_sequence(text: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    format!("\x1b]52;c;{encoded}\x07")
}

/// Copia al portapapeles del sistema (arboard) y además emite OSC52 para terminales remotas.
/// El `Clipboard` se conserva vivo: en Linux el contenido desaparece si su dueño se destruye.
#[cfg(not(test))]
pub fn copy_text(text: &str) -> std::io::Result<()> {
    use std::io::{stdout, Write};
    use std::sync::{Mutex, OnceLock};

    static HOLDER: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
    let native_ok = {
        let mut guard = HOLDER.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = arboard::Clipboard::new().ok();
        }
        guard.as_mut().is_some_and(|cb| cb.set_text(text.to_string()).is_ok())
    };

    // Wayland sin data-control: wl-copy se queda como dueño de la selección por su cuenta.
    let native_ok = native_ok || {
        use std::process::{Command, Stdio};
        Command::new("wl-copy")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut child| {
                child.stdin.take().map(|mut i| i.write_all(text.as_bytes())).transpose()?;
                Ok(())
            })
            .is_ok()
    };

    let mut out = stdout();
    let osc = out.write_all(osc52_sequence(text).as_bytes()).and_then(|_| out.flush());
    if native_ok { Ok(()) } else { osc }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc52_encodes_text_without_writing_to_stderr() {
        assert_eq!(osc52_sequence("hola"), "\x1b]52;c;aG9sYQ==\x07");
    }
}
