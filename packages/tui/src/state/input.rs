use crossterm::event::KeyCode;

/// UTF-8-aware input field with a cursor position.
#[derive(Debug, Default)]
pub struct InputState {
    pub chars: Vec<char>,
    pub cursor: usize,
}

impl InputState {
    pub fn value(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    pub fn set(&mut self, s: &str) {
        self.chars = s.chars().collect();
        self.cursor = self.chars.len();
    }

    pub fn handle_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char(c) => {
                self.chars.insert(self.cursor, c);
                self.cursor += 1;
            }
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.chars.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.chars.len() => {
                self.chars.remove(self.cursor);
            }
            KeyCode::Left if self.cursor > 0               => self.cursor -= 1,
            KeyCode::Right if self.cursor < self.chars.len() => self.cursor += 1,
            KeyCode::Home => self.cursor = 0,
            KeyCode::End  => self.cursor = self.chars.len(),
            _ => {}
        }
    }
}
