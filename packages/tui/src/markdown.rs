use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

use crate::app::{AMBER, DIM, GREEN};

mod core_style {
    pub use ratatui_core::style::{Color as CColor, Modifier as CModifier, Style as CStyle};

    pub fn indexed(i: u8) -> CColor {
        CColor::Indexed(i)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentType {
    Plain,
    Markdown,
    Thinking,
}

#[derive(Debug, Clone)]
pub struct ThinkingMeta {
    pub elapsed_secs: u32,
    pub token_count: u32,
}

fn c_style(fg: core_style::CColor, modifiers: core_style::CModifier) -> core_style::CStyle {
    core_style::CStyle::default().fg(fg).add_modifier(modifiers)
}

fn c_style_bg(fg: core_style::CColor, bg: core_style::CColor) -> core_style::CStyle {
    core_style::CStyle::default().fg(fg).bg(bg)
}

#[derive(Clone, Debug, Default)]
pub struct HiveStyleSheet;

impl tui_markdown::StyleSheet for HiveStyleSheet {
    fn heading(&self, level: u8) -> core_style::CStyle {
        match level {
            1 => c_style(core_style::indexed(214), core_style::CModifier::BOLD | core_style::CModifier::UNDERLINED),
            2 => c_style(core_style::indexed(214), core_style::CModifier::BOLD),
            3 => c_style(core_style::indexed(45), core_style::CModifier::BOLD),
            4 | 5 | 6 => c_style(core_style::indexed(45), core_style::CModifier::ITALIC),
            _ => c_style(core_style::indexed(45), core_style::CModifier::empty()),
        }
    }

    fn code(&self) -> core_style::CStyle {
        c_style_bg(core_style::indexed(114), core_style::indexed(236))
    }

    fn link(&self) -> core_style::CStyle {
        c_style(core_style::indexed(45), core_style::CModifier::UNDERLINED)
    }

    fn blockquote(&self) -> core_style::CStyle {
        c_style(core_style::indexed(248), core_style::CModifier::empty())
    }

    fn heading_meta(&self) -> core_style::CStyle {
        c_style(core_style::indexed(240), core_style::CModifier::empty())
    }

    fn metadata_block(&self) -> core_style::CStyle {
        c_style(core_style::indexed(136), core_style::CModifier::empty())
    }
}

fn convert_color(c: ratatui_core::style::Color) -> Color {
    match c {
        ratatui_core::style::Color::Indexed(i) => Color::Indexed(i),
        ratatui_core::style::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
        ratatui_core::style::Color::White => Color::White,
        ratatui_core::style::Color::Black => Color::Black,
        ratatui_core::style::Color::Gray => Color::Gray,
        ratatui_core::style::Color::DarkGray => Color::DarkGray,
        ratatui_core::style::Color::Red => Color::Red,
        ratatui_core::style::Color::Green => Color::Green,
        ratatui_core::style::Color::Yellow => Color::Yellow,
        ratatui_core::style::Color::Blue => Color::Blue,
        ratatui_core::style::Color::Magenta => Color::Magenta,
        ratatui_core::style::Color::Cyan => Color::Cyan,
        ratatui_core::style::Color::LightRed => Color::LightRed,
        ratatui_core::style::Color::LightGreen => Color::LightGreen,
        ratatui_core::style::Color::LightYellow => Color::LightYellow,
        ratatui_core::style::Color::LightBlue => Color::LightBlue,
        ratatui_core::style::Color::LightMagenta => Color::LightMagenta,
        ratatui_core::style::Color::LightCyan => Color::LightCyan,
        _ => Color::default(),
    }
}

fn convert_modifier(m: ratatui_core::style::Modifier) -> Modifier {
    let mut out = Modifier::empty();
    if m.contains(ratatui_core::style::Modifier::BOLD) { out |= Modifier::BOLD; }
    if m.contains(ratatui_core::style::Modifier::ITALIC) { out |= Modifier::ITALIC; }
    if m.contains(ratatui_core::style::Modifier::UNDERLINED) { out |= Modifier::UNDERLINED; }
    if m.contains(ratatui_core::style::Modifier::DIM) { out |= Modifier::DIM; }
    if m.contains(ratatui_core::style::Modifier::CROSSED_OUT) { out |= Modifier::CROSSED_OUT; }
    if m.contains(ratatui_core::style::Modifier::REVERSED) { out |= Modifier::REVERSED; }
    if m.contains(ratatui_core::style::Modifier::SLOW_BLINK) { out |= Modifier::SLOW_BLINK; }
    if m.contains(ratatui_core::style::Modifier::RAPID_BLINK) { out |= Modifier::RAPID_BLINK; }
    out
}

fn convert_style(s: ratatui_core::style::Style) -> Style {
    let mut style = Style::default();
    if let Some(fg) = s.fg {
        style = style.fg(convert_color(fg));
    }
    if let Some(bg) = s.bg {
        style = style.bg(convert_color(bg));
    }
    if !s.add_modifier.is_empty() {
        style = style.add_modifier(convert_modifier(s.add_modifier));
    }
    style
}

pub fn is_likely_markdown(content: &str) -> bool {
    if content.contains("```") {
        return true;
    }
    for l in content.lines().take(5) {
        if l.starts_with("# ") || l.starts_with("## ") || l.starts_with("### ") {
            return true;
        }
    }
    if content.contains("**") {
        let first = content.find("**");
        let last = content.rfind("**");
        if first.is_some() && last.is_some() && first != last {
            return true;
        }
    }
    let bullet_count = content.lines().take(10).filter(|l| l.starts_with("- ") || l.starts_with("* ")).count();
    if bullet_count >= 2 {
        return true;
    }
    let backtick_count = content.matches('`').count();
    if backtick_count >= 2 {
        return true;
    }
    false
}

pub fn is_likely_diff(content: &str) -> bool {
    let mut diff_markers = 0u32;
    for line in content.lines().take(10) {
        if line.starts_with("diff ") || line.starts_with("--- ") || line.starts_with("+++ ") || line.starts_with("@@") {
            diff_markers += 1;
        }
    }
    diff_markers >= 2
}

pub fn render_content(
    content: &str,
    content_type: &ContentType,
    thinking_meta: &Option<ThinkingMeta>,
    width: usize,
    prefix: &str,
    prefix_color: Color,
    indent: &str,
) -> Vec<Line<'static>> {
    match content_type {
        ContentType::Thinking => render_thinking_content(content, thinking_meta, prefix, prefix_color, indent, width),
        ContentType::Markdown if is_likely_diff(content) => render_diff(content, prefix, prefix_color, indent, width),
        ContentType::Markdown => render_markdown(content, prefix, prefix_color, indent, width),
        ContentType::Plain => render_plain(content, prefix, prefix_color, indent, width),
    }
}

fn render_thinking_content(
    content: &str,
    meta: &Option<ThinkingMeta>,
    prefix: &str,
    prefix_color: Color,
    indent: &str,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    if let Some(m) = meta {
        let tokens_str = if m.token_count > 0 {
            format!(" · {} tokens", fmt_tokens(m.token_count))
        } else {
            String::new()
        };
        lines.push(Line::from(vec![
            Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
            Span::styled(
                format!("Pensó por {}s{}", m.elapsed_secs, tokens_str),
                Style::default().fg(DIM).add_modifier(Modifier::ITALIC),
            ),
        ]));
    } else {
        lines.push(Line::from(vec![
            Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
            Span::styled(
                "Pensando...".to_string(),
                Style::default().fg(DIM).add_modifier(Modifier::ITALIC),
            ),
        ]));
    }

    if !content.is_empty() {
        let thinking_style = Style::default().fg(DIM).add_modifier(Modifier::ITALIC);
        for (i, line) in content.lines().enumerate() {
            let available = if i == 0 { width.saturating_sub(prefix.len()) } else { width.saturating_sub(indent.len()) };
            let wrapped = textwrap::wrap(line, available.max(10));

            for (j, wrapped_line) in wrapped.into_iter().enumerate() {
                if i == 0 && j == 0 {
                    lines.push(Line::from(vec![
                        Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
                        Span::styled(wrapped_line.into_owned(), thinking_style),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::raw(indent.to_string()),
                        Span::styled(wrapped_line.into_owned(), thinking_style),
                    ]));
                }
            }
        }
    }

    lines.push(Line::from(""));
    lines
}

fn fmt_tokens(n: u32) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

pub fn render_markdown(
    content: &str,
    prefix: &str,
    prefix_color: Color,
    indent: &str,
    width: usize,
) -> Vec<Line<'static>> {
    let prefix_len = prefix.len();
    let indent_len = indent.len();
    let first_line_max = width.saturating_sub(prefix_len).max(10);
    let rest_max = width.saturating_sub(indent_len).max(10);

    let options = tui_markdown::Options::new(HiveStyleSheet);
    let md_text = tui_markdown::from_str_with_options(content, &options);

    let mut result: Vec<Line<'static>> = Vec::new();

    for (i, md_line) in md_text.lines.into_iter().enumerate() {
        let line_prefix = if i == 0 {
            Span::styled(prefix.to_string(), Style::default().fg(prefix_color))
        } else {
            Span::raw(indent.to_string())
        };
        let max_width = if i == 0 { first_line_max } else { rest_max };

        let line_spans: Vec<Span<'static>> = md_line.spans.into_iter().map(|s| {
            Span::styled(s.content.into_owned(), convert_style(s.style))
        }).collect();

        let line_total: usize = line_spans.iter().map(|s| s.content.len()).sum();

        if line_total <= max_width {
            let mut spans = vec![line_prefix];
            spans.extend(line_spans);
            result.push(Line::from(spans));
        } else {
            // Flatten spans into plain text, wrap, then re-apply a single style
            let flat_content: String = line_spans.iter().map(|s| s.content.as_ref()).collect();
            let primary_style = line_spans.first().map(|s| s.style).unwrap_or_default();
            let wrapped = textwrap::wrap(&flat_content, max_width);

            for (j, wrapped_line) in wrapped.into_iter().enumerate() {
                if j == 0 {
                    result.push(Line::from(vec![
                        line_prefix.clone(),
                        Span::styled(wrapped_line.into_owned(), primary_style),
                    ]));
                } else {
                    result.push(Line::from(vec![
                        Span::raw(indent.to_string()),
                        Span::styled(wrapped_line.into_owned(), primary_style),
                    ]));
                }
            }
        }
    }

    if result.is_empty() {
        result.push(Line::from(vec![
            Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
        ]));
    }

    result.push(Line::from(""));
    result
}

pub fn render_diff(
    content: &str,
    prefix: &str,
    prefix_color: Color,
    indent: &str,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();

    for (i, line) in content.lines().enumerate() {
        let line_style = if line.starts_with('+') && !line.starts_with("+++") {
            Style::default().fg(GREEN)
        } else if line.starts_with('-') && !line.starts_with("---") {
            Style::default().fg(Color::Indexed(203))
        } else if line.starts_with("@@") {
            Style::default().fg(DIM).add_modifier(Modifier::ITALIC)
        } else if line.starts_with("diff ") || line.starts_with("--- ") || line.starts_with("+++ ") {
            Style::default().fg(AMBER)
        } else {
            Style::default()
        };

        let available = if i == 0 { width.saturating_sub(prefix.len()) } else { width.saturating_sub(indent.len()) };
        let wrapped = textwrap::wrap(line, available.max(10));

        for (j, wrapped_line) in wrapped.into_iter().enumerate() {
            if i == 0 && j == 0 {
                lines.push(Line::from(vec![
                    Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
                    Span::styled(wrapped_line.into_owned(), line_style),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw(indent.to_string()),
                    Span::styled(wrapped_line.into_owned(), line_style),
                ]));
            }
        }
    }

    lines.push(Line::from(""));
    lines
}

fn render_plain(
    content: &str,
    prefix: &str,
    prefix_color: Color,
    indent: &str,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();

    if content.contains('\n') {
        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim_start();
            let content_style = if trimmed.starts_with('\u{25b8}') {
                Style::default().fg(AMBER)
            } else if trimmed.starts_with('\u{00b7}') {
                Style::default().fg(ratatui::style::Color::Indexed(248))
            } else if trimmed.starts_with('\u{2500}') || trimmed.starts_with('\u{2550}') {
                Style::default().fg(DIM)
            } else {
                Style::default()
            };

            let available = if i == 0 { width.saturating_sub(prefix.len()) } else { width.saturating_sub(indent.len()) };
            let wrapped = textwrap::wrap(line, available.max(10));

            for (j, wrapped_line) in wrapped.into_iter().enumerate() {
                if i == 0 && j == 0 {
                    lines.push(Line::from(vec![
                        Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
                        Span::styled(wrapped_line.into_owned(), content_style),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::raw(indent.to_string()),
                        Span::styled(wrapped_line.into_owned(), content_style),
                    ]));
                }
            }
        }
    } else {
        let available = width.saturating_sub(prefix.len());
        let wrapped = textwrap::wrap(content, available.max(10));

        for (j, wrapped_line) in wrapped.into_iter().enumerate() {
            if j == 0 {
                lines.push(Line::from(vec![
                    Span::styled(prefix.to_string(), Style::default().fg(prefix_color)),
                    Span::styled(wrapped_line.into_owned(), Style::default()),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw(indent.to_string()),
                    Span::styled(wrapped_line.into_owned(), Style::default()),
                ]));
            }
        }
    }

    lines.push(Line::from(""));
    lines
}