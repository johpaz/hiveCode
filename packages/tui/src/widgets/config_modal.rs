use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
    Frame,
};

use crate::app::{AppState, AMBER, DIM, RED, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState) {
    if !state.show_modal || state.modal_fields.is_empty() {
        return;
    }

    let area = frame.area();

    // Modal dimensions: 60% width, height = fields + header + hint + padding
    let modal_width = (area.width * 6 / 10).max(50).min(area.width.saturating_sub(4));
    let modal_height = (state.modal_fields.len() as u16 * 3 + 6).min(area.height.saturating_sub(4));

    let x = (area.width.saturating_sub(modal_width)) / 2;
    let y = (area.height.saturating_sub(modal_height)) / 2;

    let modal_area = Rect { x, y, width: modal_width, height: modal_height };

    frame.render_widget(Clear, modal_area);

    let outer_block = Block::default()
        .title(Span::styled(
            format!(" {} ", state.modal_title),
            Style::default().fg(AMBER).add_modifier(Modifier::BOLD),
        ))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(AMBER));

    frame.render_widget(outer_block, modal_area);

    // Inner area (inside the border)
    let inner = Rect {
        x: modal_area.x + 1,
        y: modal_area.y + 1,
        width: modal_area.width.saturating_sub(2),
        height: modal_area.height.saturating_sub(2),
    };

    // Layout: each field gets 3 rows (label, input, spacer), last row is hint
    let mut constraints: Vec<Constraint> = state.modal_fields
        .iter()
        .map(|_| Constraint::Length(3))
        .collect();
    constraints.push(Constraint::Min(0)); // spacer
    constraints.push(Constraint::Length(1)); // hint line

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(inner);

    let label_width = state.modal_fields
        .iter()
        .map(|f| f.label.len() + if !f.required { 6 } else { 2 })
        .max()
        .unwrap_or(14) as u16;

    for (i, field) in state.modal_fields.iter().enumerate() {
        let chunk = chunks[i];
        let focused = i == state.modal_focused;
        let has_error = state.modal_errors.get(i).copied().unwrap_or(false);

        // Build label
        let opt_tag = if !field.required { " (opt)" } else { "" };
        let label_text = format!("{}{}", field.label, opt_tag);

        let label_style = if has_error {
            Style::default().fg(RED).add_modifier(Modifier::BOLD)
        } else if focused {
            Style::default().fg(AMBER).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(SECONDARY)
        };

        let border_style = if has_error {
            Style::default().fg(RED)
        } else if focused {
            Style::default().fg(AMBER)
        } else {
            Style::default().fg(DIM)
        };

        // Split row: label | input box
        let row_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(label_width + 2),
                Constraint::Min(10),
            ])
            .split(chunk);

        // Label area (vertically centered in the 3-row chunk)
        let label_area = Rect {
            x: row_chunks[0].x,
            y: row_chunks[0].y + 1,
            width: row_chunks[0].width,
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(format!("  {:<width$}", label_text, width = label_width as usize))
                .style(label_style),
            label_area,
        );

        // Value display
        let raw_value = state.modal_values.get(i).map(String::as_str).unwrap_or("");
        let display_value: String = if field.secret && !raw_value.is_empty() {
            "●".repeat(raw_value.chars().count())
        } else if field.field_type == "select" {
            if raw_value.is_empty() {
                if let Some(opts) = &field.options {
                    opts.first().cloned().unwrap_or_default()
                } else {
                    String::new()
                }
            } else {
                raw_value.to_string()
            }
        } else {
            raw_value.to_string()
        };

        let cursor_pos = state.modal_cursors.get(i).copied().unwrap_or(0);
        let input_text = if focused && field.field_type != "select" {
            // Insert blinking cursor character
            let chars: Vec<char> = display_value.chars().collect();
            let mut with_cursor = chars.clone();
            let cursor_char = if state.cursor_visible { '▌' } else { ' ' };
            if cursor_pos <= with_cursor.len() {
                with_cursor.insert(cursor_pos, cursor_char);
            }
            with_cursor.iter().collect()
        } else if field.field_type == "select" {
            format!("{} ◂▸", display_value)
        } else {
            display_value
        };

        let placeholder_style = Style::default().fg(DIM).add_modifier(Modifier::ITALIC);
        let (shown_text, text_style) = if input_text.is_empty() {
            (field.placeholder.clone(), placeholder_style)
        } else {
            (input_text, Style::default().fg(if focused { AMBER } else { SECONDARY }))
        };

        let input_block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(border_style);

        let input_para = Paragraph::new(shown_text)
            .block(input_block)
            .style(text_style);

        frame.render_widget(input_para, row_chunks[1]);
    }

    // Hint line
    let hint_area = chunks[state.modal_fields.len() + 1];
    let hint = Line::from(vec![
        Span::styled("  Tab", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" navegar  ", Style::default().fg(DIM)),
        Span::styled("Ctrl+S", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" guardar  ", Style::default().fg(DIM)),
        Span::styled("Esc", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" cancelar", Style::default().fg(DIM)),
    ]);
    frame.render_widget(Paragraph::new(hint), hint_area);
}
