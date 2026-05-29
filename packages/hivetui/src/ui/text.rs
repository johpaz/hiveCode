use unicode_width::UnicodeWidthChar;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    Clip,
    Ellipsis,
    Wrap,
    WordWrap,
}

pub fn cell_width(text: &str) -> usize {
    text.chars()
        .map(|ch| UnicodeWidthChar::width(ch).unwrap_or(1).max(1))
        .sum()
}

pub fn truncate_cells(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }

    let mut out = String::new();
    let mut width = 0usize;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
        if width + ch_width > max_width {
            break;
        }
        out.push(ch);
        width += ch_width;
    }
    out
}

pub fn ellipsize_cells(text: &str, max_width: usize) -> String {
    if cell_width(text) <= max_width {
        return text.to_string();
    }
    if max_width == 0 {
        return String::new();
    }
    if max_width == 1 {
        return "…".to_string();
    }
    let mut out = truncate_cells(text, max_width.saturating_sub(1));
    out.push('…');
    out
}

pub fn wrap_cells(text: &str, max_width: usize, overflow: Overflow) -> Vec<String> {
    let max_width = max_width.max(1);
    match overflow {
        Overflow::Clip => vec![truncate_cells(text, max_width)],
        Overflow::Ellipsis => vec![ellipsize_cells(text, max_width)],
        Overflow::Wrap => wrap_anywhere(text, max_width),
        Overflow::WordWrap => wrap_words(text, max_width),
    }
}

fn wrap_anywhere(text: &str, max_width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut width = 0usize;

    for ch in text.chars() {
        if ch == '\n' {
            lines.push(std::mem::take(&mut current));
            width = 0;
            continue;
        }

        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
        if width > 0 && width + ch_width > max_width {
            lines.push(std::mem::take(&mut current));
            width = 0;
        }
        current.push(ch);
        width += ch_width;
    }

    lines.push(current);
    lines
}

fn wrap_words(text: &str, max_width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw_line in text.split('\n') {
        let mut remaining = raw_line.trim().to_string();
        if remaining.is_empty() {
            out.push(String::new());
            continue;
        }

        while !remaining.is_empty() {
            if cell_width(&remaining) <= max_width {
                out.push(remaining);
                break;
            }

            let cut = byte_cut_for_cells(&remaining, max_width);
            let split = remaining[..cut]
                .char_indices()
                .rev()
                .find(|(_, ch)| ch.is_whitespace())
                .map(|(idx, _)| idx)
                .filter(|idx| *idx > 0)
                .unwrap_or(cut);
            let line = remaining[..split].trim_end().to_string();
            out.push(line);
            remaining = remaining[split..].trim_start().to_string();
        }
    }
    out
}

fn byte_cut_for_cells(text: &str, max_width: usize) -> usize {
    let mut width = 0usize;
    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
        if width > 0 && width + ch_width > max_width {
            break;
        }
        width += ch_width;
        end = idx + ch.len_utf8();
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_without_splitting_wide_cells() {
        assert_eq!(truncate_cells("abc漢Z", 4), "abc");
        assert_eq!(truncate_cells("abc漢Z", 5), "abc漢");
    }

    #[test]
    fn ellipsizes_to_cell_width() {
        let shown = ellipsize_cells("abcdef", 4);
        assert_eq!(shown, "abc…");
        assert_eq!(cell_width(&shown), 4);
    }

    #[test]
    fn word_wrap_prefers_spaces() {
        assert_eq!(
            wrap_cells("hello world again", 8, Overflow::WordWrap),
            vec!["hello", "world", "again"]
        );
    }

    #[test]
    fn hard_wrap_handles_wide_cells() {
        let lines = wrap_cells("ab漢cd", 4, Overflow::Wrap);
        assert_eq!(lines, vec!["ab漢", "cd"]);
        assert!(lines.iter().all(|line| cell_width(line) <= 4));
    }
}
