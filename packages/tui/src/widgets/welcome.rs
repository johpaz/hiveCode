use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{
    AppState, ReplMode, AMBER, AMBER_DIM, BLUE, CYAN, DIM, GREEN, PURPLE, RED, SECONDARY,
};

// ASCII bee — 10 lines × 28 display chars
const BEE: [&str; 10] = [
    "        ░░░░    ░░░░        ",
    "      ░░░░░░░░░░░░░░░░      ",
    "    ░░  ░░░░░░░░░░░░  ░░    ",
    "    ░░░░░░  ████  ░░░░░░    ",
    "    ░░░░░░  ████  ░░░░░░    ",
    "      ░░░░░░░░░░░░░░░░      ",
    "   ░░  ░░░░░░░░░░░░░░  ░░   ",
    "   ░░░░░░░░░░░░░░░░░░░░░░   ",
    "    ████░░░░░░░░░░░░████    ",
    "      ██████████████████      ",
];

fn bee_line<'a>(i: usize, state: &'a AppState) -> Line<'a> {
    let bee_span = Span::styled(BEE[i], Style::default().fg(AMBER).add_modifier(Modifier::BOLD));

    let side: Vec<Span<'a>> = match i {
        2 => vec![
            Span::styled("  hivecode", Style::default().fg(ratatui::style::Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(format!("  v{}", state.version), Style::default().fg(DIM)),
        ],
        3 => vec![Span::styled(
            "  Gateway de agentes de código",
            Style::default().fg(DIM),
        )],
        4 => vec![Span::styled(
            "  local-first · Bun runtime",
            Style::default().fg(DIM),
        )],
        5 => vec![Span::styled("  @johpaz", Style::default().fg(DIM))],
        _ => vec![],
    };

    let mut spans = vec![bee_span];
    spans.extend(side);
    Line::from(spans)
}

fn mode_badge(mode: &ReplMode) -> Span<'static> {
    let (label, fg, bg) = match mode {
        ReplMode::Plan     => (" PLAN ",     Color::Rgb(196, 181, 253), Color::Rgb(46, 26, 94)),
        ReplMode::Approval => (" APROBACIÓN ", Color::Rgb(252, 211, 77),  Color::Rgb(69, 26, 3)),
        ReplMode::Auto     => (" AUTO ",     Color::Rgb(110, 231, 183), Color::Rgb(6, 78, 59)),
    };
    Span::styled(
        label,
        Style::default()
            .fg(fg)
            .bg(bg)
            .add_modifier(Modifier::BOLD),
    )
}

fn bar_span() -> Span<'static> {
    Span::styled("  │", Style::default().fg(AMBER))
}

fn workers_line(agent_count: u32) -> Line<'static> {
    let count_color = if agent_count >= 6 { GREEN } else { RED };
    let mut spans = vec![
        bar_span(),
        Span::styled("  Workers   ", Style::default().fg(DIM)),
        Span::styled(
            format!("{} activos", agent_count),
            Style::default().fg(count_color),
        ),
    ];

    if agent_count > 0 {
        spans.push(Span::styled("  ·  ", Style::default().fg(DIM)));
        let roles: &[(&str, Color)] = &[
            ("arch",   PURPLE),
            ("back",   BLUE),
            ("front",  CYAN),
            ("sec",    RED),
            ("test",   GREEN),
            ("devops", AMBER_DIM),
        ];
        let active = (agent_count as usize).min(roles.len());
        for (idx, (name, color)) in roles[..active].iter().enumerate() {
            spans.push(Span::styled(*name, Style::default().fg(*color)));
            if idx + 1 < active {
                spans.push(Span::styled(" · ", Style::default().fg(DIM)));
            }
        }
    }

    Line::from(spans)
}

fn sep_line() -> Line<'static> {
    Line::from(vec![Span::styled(
        "  ─────────────────────────────────────────────",
        Style::default().fg(DIM),
    )])
}

fn input_line(state: &AppState) -> Line<'_> {
    let value = state.input.value();
    let cursor = state.input.cursor;

    let cursor_style = if state.cursor_visible {
        Style::default()
            .fg(Color::Black)
            .bg(AMBER)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(DIM)
    };

    if value.is_empty() {
        // Placeholder + blinking block cursor
        return Line::from(vec![
            Span::styled("  ⬡  ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
            Span::styled("¿Qué quieres construir?  ", Style::default().fg(DIM)),
            Span::styled(" ", cursor_style),
        ]);
    }

    let chars: Vec<char> = value.chars().collect();
    let before: String = chars[..cursor].iter().collect();
    let (at, after) = if cursor < chars.len() {
        (chars[cursor].to_string(), chars[cursor + 1..].iter().collect::<String>())
    } else {
        (" ".to_string(), String::new())
    };

    Line::from(vec![
        Span::styled("  ⬡  ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::raw(before),
        Span::styled(at, cursor_style),
        Span::raw(after),
    ])
}

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    // Content is ~23 lines; center vertically if terminal is taller
    let content_height: u16 = 23;
    let top_pad = area.height.saturating_sub(content_height) / 2;

    let mut lines: Vec<Line> = Vec::new();

    // Top padding
    for _ in 0..top_pad {
        lines.push(Line::from(""));
    }

    // ── Bee art (10 lines) ────────────────────────────────────────────────────
    for i in 0..10 {
        lines.push(bee_line(i, state));
    }

    lines.push(Line::from(""));
    lines.push(sep_line());

    if state.provider.is_empty() {
        // No provider — warning state
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Sin provider configurado", Style::default().fg(RED)),
        ]));
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  ▸ Escribe  ", Style::default().fg(DIM)),
            Span::styled("/provider", Style::default().fg(AMBER)),
            Span::styled("  para configurar un LLM", Style::default().fg(DIM)),
        ]));
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled(
                "  anthropic · openai · groq · gemini · ollama",
                Style::default().fg(DIM),
            ),
        ]));
    } else {
        // ── Status rows ──────────────────────────────────────────────────────
        // Modo
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Modo      ", Style::default().fg(DIM)),
            mode_badge(&state.mode),
            Span::styled("  shift+tab para cambiar", Style::default().fg(DIM)),
        ]));

        // Proyecto
        let project_display = {
            let p = state.project_path.as_str();
            if let Some(home) = std::env::var("HOME").ok() {
                p.strip_prefix(&home).map(|s| format!("~{s}")).unwrap_or_else(|| p.to_string())
            } else {
                p.to_string()
            }
        };
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Proyecto  ", Style::default().fg(DIM)),
            Span::styled(project_display, Style::default().fg(SECONDARY)),
        ]));

        // Provider
        let provider_info = if state.model.is_empty() {
            state.provider.clone()
        } else {
            format!("{}  ·  {}", state.provider, state.model)
        };
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Provider  ", Style::default().fg(DIM)),
            Span::styled(provider_info, Style::default().fg(GREEN)),
        ]));

        // Workers
        lines.push(workers_line(state.agent_count));

        // Tasks / tokens
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Tareas    ", Style::default().fg(DIM)),
            Span::styled(state.task_count.to_string(), Style::default().fg(SECONDARY)),
            Span::styled("  ·  tokens ", Style::default().fg(DIM)),
            Span::styled(state.fmt_tokens(), Style::default().fg(DIM)),
        ]));
    }

    lines.push(sep_line());

    // ── Commands ──────────────────────────────────────────────────────────────
    lines.push(Line::from(vec![
        bar_span(),
        Span::styled("  hivecode run    ", Style::default().fg(GREEN)),
        Span::styled("\"<tarea>\"", Style::default().fg(DIM)),
        Span::styled("   ejecutar en modo actual", Style::default().fg(DIM)),
    ]));
    lines.push(Line::from(vec![
        bar_span(),
        Span::styled("  hivecode plan   ", Style::default().fg(PURPLE)),
        Span::styled("\"<tarea>\"", Style::default().fg(DIM)),
        Span::styled("   solo diseñar, sin tocar", Style::default().fg(DIM)),
    ]));
    lines.push(Line::from(vec![
        bar_span(),
        Span::styled("  hivecode doctor ", Style::default().fg(BLUE)),
        Span::styled("              diagnóstico del sistema", Style::default().fg(DIM)),
    ]));
    lines.push(Line::from(vec![
        bar_span(),
        Span::styled("  /provider · /mode · /help", Style::default().fg(DIM)),
        Span::styled("            configurar", Style::default().fg(DIM)),
    ]));

    lines.push(sep_line());

    // ── Input prompt ─────────────────────────────────────────────────────────
    lines.push(input_line(state));

    frame.render_widget(Paragraph::new(lines), area);
}
