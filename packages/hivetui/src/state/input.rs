use crossterm::event::KeyCode;
use unicode_width::UnicodeWidthChar;

#[derive(Debug, Clone, Default)]
pub struct InputState {
    pub buffer: String,
    pub cursor: usize,
    pub history: Vec<String>,
    pub history_index: Option<usize>,
    history_draft: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VisibleSegment {
    pub text: String,
    pub cursor_column: usize,
}

impl InputState {
    pub fn value(&self) -> &str {
        &self.buffer
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
        self.history_index = None;
        self.history_draft = None;
    }

    pub fn set(&mut self, value: &str) {
        self.buffer = value.to_string();
        self.cursor = self.buffer.chars().count();
        self.history_index = None;
    }

    pub fn insert(&mut self, c: char) {
        let byte_index = self.byte_index_for_cursor();
        self.buffer.insert(byte_index, c);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }

        let delete_at = self.cursor - 1;
        let byte_index = self.byte_index_for_char_index(delete_at);
        let byte_end = self.byte_index_for_char_index(delete_at + 1);
        self.buffer.replace_range(byte_index..byte_end, "");
        self.cursor = delete_at;
    }

    pub fn delete_forward(&mut self) {
        if self.cursor >= self.buffer.chars().count() {
            return;
        }

        let byte_index = self.byte_index_for_cursor();
        let byte_end = self.byte_index_for_char_index(self.cursor + 1);
        self.buffer.replace_range(byte_index..byte_end, "");
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.buffer.chars().count());
    }

    pub fn move_home(&mut self) {
        self.cursor = 0;
    }

    pub fn move_end(&mut self) {
        self.cursor = self.buffer.chars().count();
    }

    pub fn move_word_left(&mut self) {
        if self.cursor == 0 {
            return;
        }

        let chars: Vec<char> = self.buffer.chars().collect();
        let mut index = self.cursor;

        while index > 0 && chars[index - 1].is_whitespace() {
            index -= 1;
        }

        while index > 0 && !chars[index - 1].is_whitespace() {
            index -= 1;
        }

        self.cursor = index;
    }

    pub fn move_word_right(&mut self) {
        let chars: Vec<char> = self.buffer.chars().collect();
        let mut index = self.cursor;

        while index < chars.len() && !chars[index].is_whitespace() {
            index += 1;
        }

        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }

        self.cursor = index;
    }

    pub fn scroll_offset(&self, width: usize) -> u16 {
        if width == 0 {
            return 0;
        }

        let cursor_col = self.visible_width_until_cursor();
        if cursor_col < width {
            0
        } else {
            (cursor_col - width + 1).min(u16::MAX as usize) as u16
        }
    }

    pub fn submit(&mut self) -> String {
        let submitted = self.buffer.clone();
        if !submitted.is_empty() {
            self.history.push(submitted.clone());
        }
        self.buffer.clear();
        self.cursor = 0;
        self.history_index = None;
        self.history_draft = None;
        submitted
    }

    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }

        if self.history_index.is_none() {
            self.history_draft = Some(self.buffer.clone());
            self.history_index = Some(self.history.len() - 1);
        } else if let Some(index) = self.history_index {
            self.history_index = Some(index.saturating_sub(1));
        }

        if let Some(index) = self.history_index {
            if let Some(entry) = self.history.get(index) {
                self.buffer = entry.clone();
                self.cursor = self.buffer.chars().count();
            }
        }
    }

    pub fn history_down(&mut self) {
        let Some(index) = self.history_index else {
            return;
        };

        if index + 1 < self.history.len() {
            self.history_index = Some(index + 1);
            if let Some(entry) = self.history.get(index + 1) {
                self.buffer = entry.clone();
                self.cursor = self.buffer.chars().count();
            }
            return;
        }

        self.history_index = None;
        self.buffer = self.history_draft.take().unwrap_or_default();
        self.cursor = self.buffer.chars().count();
    }

    pub fn handle_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char(c) => self.insert(c),
            KeyCode::Backspace => self.backspace(),
            KeyCode::Delete => self.delete_forward(),
            KeyCode::Left => self.move_left(),
            KeyCode::Right => self.move_right(),
            KeyCode::Home => self.move_home(),
            KeyCode::End => self.move_end(),
            _ => {}
        }
    }

    pub fn visible_segment(&self, width: usize) -> VisibleSegment {
        if width == 0 {
            return VisibleSegment {
                text: String::new(),
                cursor_column: 0,
            };
        }

        let start_col = self.scroll_offset(width) as usize;
        let mut seen_cols = 0usize;
        let mut visible_cols = 0usize;
        let mut text = String::new();

        for c in self.buffer.chars() {
            let char_width = UnicodeWidthChar::width(c).unwrap_or(1).max(1);

            if seen_cols + char_width <= start_col {
                seen_cols += char_width;
                continue;
            }

            if visible_cols + char_width > width {
                break;
            }

            text.push(c);
            visible_cols += char_width;
        }

        let cursor_column = self
            .visible_width_until_cursor()
            .saturating_sub(start_col)
            .min(width);

        VisibleSegment {
            text,
            cursor_column,
        }
    }

    fn byte_index_for_cursor(&self) -> usize {
        self.byte_index_for_char_index(self.cursor)
    }

    fn byte_index_for_char_index(&self, target: usize) -> usize {
        self.buffer
            .char_indices()
            .nth(target)
            .map(|(byte_index, _)| byte_index)
            .unwrap_or(self.buffer.len())
    }

    fn visible_width_until_cursor(&self) -> usize {
        self.buffer
            .chars()
            .take(self.cursor)
            .map(|c| UnicodeWidthChar::width(c).unwrap_or(0))
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_tracks_chars_not_bytes() {
        let mut input = InputState::default();
        input.set("Hola 🐝 mundo");

        assert_eq!(input.cursor, 12);

        input.move_home();
        assert_eq!(input.scroll_offset(10), 0);
    }

    #[test]
    fn visible_segment_never_overflows_cell_width() {
        let mut input = InputState::default();
        input.set("abc🐝Z");

        let visible = input.visible_segment(4);

        let width: usize = visible
            .text
            .chars()
            .map(|c| UnicodeWidthChar::width(c).unwrap_or(1).max(1))
            .sum();
        assert!(width <= 4);
    }

    #[test]
    fn supports_word_navigation_and_history() {
        let mut input = InputState::default();
        input.set("hola mundo rust");

        input.move_word_left();
        assert_eq!(input.cursor, 11);

        input.move_word_left();
        assert_eq!(input.cursor, 5);

        input.move_word_right();
        assert_eq!(input.cursor, 11);

        let submitted = input.submit();
        assert_eq!(submitted, "hola mundo rust");
        assert_eq!(input.history.len(), 1);

        input.set("draft");
        input.history_up();
        assert_eq!(input.value(), "hola mundo rust");

        input.history_down();
        assert_eq!(input.value(), "draft");
    }
}
