//! Chord type and string parser.

use crate::prelude::*;

/// Single input event paired with its modifier state.
#[derive(Clone, PartialEq, Debug)]
pub struct Chord {
    /// Action that triggered the event.
    pub trigger: Trigger,
    /// Modifier flags held when the event fired.
    pub modifiers: Modifiers,
}

impl std::fmt::Display for Chord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.modifiers.is_empty() {
            write!(f, "{}", self.trigger)
        } else {
            write!(f, "{} + {}", self.modifiers, self.trigger)
        }
    }
}

impl Chord {
    /// Creates a chord from a trigger and modifier set.
    pub const fn new(trigger: Trigger, modifiers: Modifiers) -> Self {
        Self { trigger, modifiers }
    }
}

/// Parses a string of literal characters and `<...>` chord specs into a sequence of [`Chord`]s.
pub fn parse_chords(s: &str) -> Vec<Chord> {
    let mut chords = Vec::new();
    let mut rest = s;

    while !rest.is_empty() {
        let c = rest.chars().next().unwrap();

        if c == '\\' {
            let after = &rest[1..];
            if after.starts_with('<') {
                if let Some((_, consumed)) = try_parse_chord_spec(after) {
                    for ch in after[..consumed].chars() {
                        chords.push(Chord::new(Trigger::Key(Key::Char(ch)), Modifiers::new()));
                    }
                    rest = &after[consumed..];
                    continue;
                }
            }
        }

        if c == '<' {
            if let Some((chord, consumed)) = try_parse_chord_spec(rest) {
                chords.push(chord);
                rest = &rest[consumed..];
                continue;
            }
        }

        chords.push(Chord::new(Trigger::Key(Key::Char(c)), Modifiers::new()));
        rest = &rest[c.len_utf8()..];
    }

    chords
}

fn try_parse_chord_spec(s: &str) -> Option<(Chord, usize)> {
    debug_assert!(s.starts_with('<'));
    let end = s.find('>')?;
    let content = &s[1..end];
    parse_chord_content(content).map(|chord| (chord, end + 1))
}

fn parse_chord_content(content: &str) -> Option<Chord> {
    if content.is_empty() {
        return None;
    }
    let (mods_str, key_name) = match content.rfind('-') {
        Some(pos) => (&content[..pos], &content[pos + 1..]),
        None => ("", content),
    };
    let mut modifiers = Modifiers::new();
    if !mods_str.is_empty() {
        for m in mods_str.split('-') {
            let mut chars = m.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            match c.to_ascii_lowercase() {
                'c' => modifiers.set(Modifier::Ctrl, true),
                'a' => modifiers.set(Modifier::Alt, true),
                's' => modifiers.set(Modifier::Shift, true),
                'm' => modifiers.set(Modifier::Meta, true),
                'd' => modifiers.set(Modifier::Super, true),
                'h' => modifiers.set(Modifier::Hyper, true),
                _ => return None,
            }
        }
    }
    let key = parse_key_name(key_name)?;
    Some(Chord::new(Trigger::Key(key), modifiers))
}

fn parse_key_name(name: &str) -> Option<Key> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "esc" => return Some(Key::Esc),
        "cr" | "enter" => return Some(Key::Enter),
        "bs" | "backspace" => return Some(Key::Backspace),
        "del" | "delete" => return Some(Key::Delete),
        "tab" => return Some(Key::Tab),
        "space" => return Some(Key::Char(' ')),
        "up" => return Some(Key::Arrow(Direction2D::Up)),
        "down" => return Some(Key::Arrow(Direction2D::Down)),
        "left" => return Some(Key::Arrow(Direction2D::Left)),
        "right" => return Some(Key::Arrow(Direction2D::Right)),
        "home" => return Some(Key::Home),
        "end" => return Some(Key::End),
        "pageup" => return Some(Key::PageUp),
        "pagedown" => return Some(Key::PageDown),
        "insert" => return Some(Key::Insert),
        "lt" => return Some(Key::Char('<')),
        "gt" => return Some(Key::Char('>')),
        _ => {}
    }
    let mut chars = name.chars();
    let first = chars.next()?;
    if first.to_ascii_lowercase() == 'f' {
        if let Ok(n) = name[1..].parse::<u8>() {
            if (1..=12).contains(&n) {
                return Some(Key::F(n));
            }
        }
    }
    if chars.next().is_none() {
        Some(Key::Char(first))
    } else {
        None
    }
}
