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

// ASCII bee — 12 lines × 28 display chars
//
// Structure: antennae (0-2) · head (3) · wings+thorax (4-6) · abdomen (7-10) · stinger (11)
// Wings use ▒ in CYAN to visually separate from amber body (░/█).

fn bee_line<'a>(i: usize, state: &'a AppState) -> Line<'a> {
    let amber = Style::default().fg(AMBER).add_modifier(Modifier::BOLD);
    let dim   = Style::default().fg(DIM);
    let wing  = Style::default().fg(CYAN);

    // Each match arm totals exactly 28 display chars.
    let bee_spans: Vec<Span<'a>> = match i {
        // ── antennae (diverge upward, converge to head) ────────────────────
        0 => vec![Span::styled("        \\          /        ", dim)],
        1 => vec![Span::styled("         \\        /         ", dim)],
        2 => vec![Span::styled("          \\      /          ", dim)],
        // ── head ───────────────────────────────────────────────────────────
        3 => vec![
            Span::styled("          ", dim),
            Span::styled("(", amber),
            Span::styled(" o  o ", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(")", amber),
            Span::styled("          ", dim),
        ],
        // ── wings (▒ cyan) flanking thorax ─────────────────────────────────
        4 => vec![
            Span::styled("   ", dim),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled(" ░░░░░░░░░░ ", amber),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled("   ", dim),
        ],
        5 => vec![
            Span::styled("   ", dim),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled(" ░░██████░░ ", amber),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled("   ", dim),
        ],
        6 => vec![
            Span::styled("   ", dim),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled(" ░░░░░░░░░░ ", amber),
            Span::styled("▒▒▒▒▒", wing),
            Span::styled("   ", dim),
        ],
        // ── abdomen (alternating amber / dark stripes, tapering) ───────────
        7  => vec![Span::styled("         ░░██████░░         ", amber)],
        8  => vec![Span::styled("         ░░░░░░░░░░         ", amber)],
        9  => vec![Span::styled("          ░░░░░░░░          ", amber)],
        10 => vec![Span::styled("           ░░░░░░           ", amber)],
        // ── stinger ────────────────────────────────────────────────────────
        11 => vec![Span::styled("            ▼▼▼▼            ", amber)],
        _  => vec![],
    };

    let side: Vec<Span<'a>> = match i {
        3 => vec![
            Span::styled("  hivecode", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(format!("  v{}", state.version), Style::default().fg(DIM)),
        ],
        4 => vec![Span::styled("  Gateway de agentes de código", Style::default().fg(DIM))],
        5 => vec![Span::styled("  local-first · Bun runtime", Style::default().fg(DIM))],
        6 => vec![Span::styled("  @johpaz", Style::default().fg(DIM))],
        _ => vec![],
    };

    let mut spans = bee_spans;
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
    let count_color = if agent_count >= 7 { GREEN } else { RED };
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
            ("bee",    AMBER),
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

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    // Content is ~24 lines; center vertically if terminal is taller
    let content_height: u16 = 24;
    let top_pad = area.height.saturating_sub(content_height) / 2;

    let mut lines: Vec<Line> = Vec::new();

    // Top padding
    for _ in 0..top_pad {
        lines.push(Line::from(""));
    }

    // ── Bee art (12 lines) ────────────────────────────────────────────────────
    for i in 0..12 {
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

        // Directory
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
            Span::styled("  Directory ", Style::default().fg(DIM)),
            Span::styled(project_display, Style::default().fg(SECONDARY)),
        ]));

        // Session
        let session_display = if state.session_id.is_empty() {
            "—".to_string()
        } else {
            state.session_id.clone()
        };
        lines.push(Line::from(vec![
            bar_span(),
            Span::styled("  Session   ", Style::default().fg(DIM)),
            Span::styled(session_display, Style::default().fg(SECONDARY)),
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
        Span::styled("  Escribe / para ver todos los comandos disponibles", Style::default().fg(DIM)),
    ]));

    frame.render_widget(Paragraph::new(lines), area);
}
