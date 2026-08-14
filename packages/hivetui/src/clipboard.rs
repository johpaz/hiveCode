use base64::Engine as _;

pub fn osc52_sequence(text: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    format!("\x1b]52;c;{encoded}\x07")
}

#[cfg(not(test))]
pub fn copy_text(text: &str) -> std::io::Result<()> {
    use std::io::{stdout, Write};

    let mut out = stdout();
    out.write_all(osc52_sequence(text).as_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc52_encodes_text_without_writing_to_stderr() {
        assert_eq!(osc52_sequence("hola"), "\x1b]52;c;aG9sYQ==\x07");
    }
}
