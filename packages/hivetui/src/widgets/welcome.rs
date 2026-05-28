use crate::{
    state::AppState,
    term::{
        Canvas, Cell, Color, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_MAIN, DIM, GREEN,
        SECONDARY, WHITE, YELLOW,
    },
};

// ── BeeMascot — pixel grid estático (igual que en el diseño JSX) ──────────────
//
// G array del diseño:
//   A = bee-body  (#C68A12)
//   D = bee-stripe (#6B4506)
//   W = bee-wing   (#1F6E78)
//   0 = transparente

const BEE_COLS: u16 = 13;
const PX: u16 = 2;  // cada pixel = 2 chars → ancho total 13×2 = 26

const BEE_BODY:   Color = Color::Rgb { r: 198, g: 138, b: 18  };
const BEE_STRIPE: Color = Color::Rgb { r: 107, g: 69,  b: 6   };
const BEE_WING:   Color = Color::Rgb { r: 31,  g: 110, b: 120 };

// Grid estático — frame único, sin aleteo (igual que el diseño)
const BEE_GRID: [[u8; 13]; 7] = [
    [0, 3, 3, 0, 1, 1, 1, 1, 1, 0, 3, 3, 0],
    [0, 3, 3, 0, 1, 1, 1, 1, 1, 0, 3, 3, 0],
    [0, 3, 3, 0, 2, 2, 2, 2, 2, 0, 3, 3, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
];

fn pixel_color(v: u8) -> Option<Color> {
    match v {
        1 => Some(BEE_BODY),
        2 => Some(BEE_STRIPE),
        3 => Some(BEE_WING),
        _ => None,
    }
}

/// Dibuja la BeeMascot exactamente como en el diseño.
/// `slow_tick` (0-29 @ 120ms) controla el bob lento: 0-14 = arriba, 15-29 = abajo.
/// Ciclo completo = 30 × 120ms = 3.6s — igual que `animation: bee-bob 3.6s`.
fn draw_bee(canvas: &mut Canvas, x: u16, y: u16, slow_tick: u16) {
    let total_w = BEE_COLS * PX; // 26

    // Bob vertical: 0-14 → posición normal; 15-29 → 1 fila abajo
    let bob: u16 = if slow_tick < 15 { 0 } else { 1 };
    let bee_y = y + bob;

    // Antenas + cara (texto estático del diseño):
    //   \       /
    //    \     /
    //     \   /
    //    ( o o )
    let antenna_lines = [
        "  \\       /  ",
        "   \\     /   ",
        "    \\   /    ",
    ];
    for (i, line) in antenna_lines.iter().enumerate() {
        let ax = x + (total_w.saturating_sub(line.chars().count() as u16)) / 2;
        canvas.print(ax, bee_y + i as u16, line, Style::new().fg(DIM));
    }

    // Cara: ( o o )
    let face = "( o o )";
    let face_x = x + (total_w.saturating_sub(face.chars().count() as u16)) / 2;
    let face_y = bee_y + 3;
    let paren_style = Style::new().fg(BEE_BODY);
    let eyes_style  = Style::new().fg(WHITE).bold();
    canvas.print(face_x,                   face_y, "(", paren_style);
    canvas.print(face_x + 1,              face_y, " o o ", eyes_style);
    canvas.print(face_x + 6,              face_y, ")", paren_style);

    // Pixel grid (debajo de 3 antenas + 1 cara)
    let grid_y = bee_y + 4;
    for (ri, row) in BEE_GRID.iter().enumerate() {
        for (ci, &v) in row.iter().enumerate() {
            if let Some(color) = pixel_color(v) {
                let cx = x + (ci as u16) * PX;
                let cy = grid_y + ri as u16;
                for dx in 0..PX {
                    canvas.put(cx + dx, cy, Cell::new(' ', Style::new().bg(color)));
                }
            }
        }
    }

    // Stinger (▼ ▼ ▼) centrado bajo el grid
    let sting = "▼ ▼ ▼";
    let sting_x = x + (total_w.saturating_sub(sting.chars().count() as u16)) / 2;
    canvas.print(sting_x, grid_y + 7, sting, Style::new().fg(AMBER_BRIGHT).bold());
}

// ── Panel derecho — fiel al diseño ───────────────────────────────────────────

/// Dibuja el lado derecho del welcome con la estructura EXACTA del JSX:
/// título · subtítulo · bun · @johpaz · separador · boot lines · hints
fn draw_right_base(canvas: &mut Canvas, x: u16, y: u16, _w: u16, version: &str) -> u16 {
    let mut row = y;

    // hivecode  v1.0.0
    canvas.print(x, row, "hivecode", Style::new().fg(WHITE).bold());
    canvas.print(x + 9, row, &format!("v{version}"), Style::new().fg(DIM));
    row += 1;

    // Gateway de agentes de código
    canvas.print(x, row, "Gateway de agentes de código", Style::new().fg(WHITE));
    row += 1;

    // local-first · bun · sqlite + FTS5
    canvas.print(x, row, "local-first", Style::new().fg(WHITE));
    canvas.print(x + 11, row, " · ", Style::new().fg(DIM));
    canvas.print(x + 14, row, "bun", Style::new().fg(WHITE));
    canvas.print(x + 17, row, " · sqlite + FTS5", Style::new().fg(WHITE));
    row += 1;

    // @johpaz
    canvas.print(x, row, "@johpaz", Style::new().fg(WHITE));
    row += 1;

    // ⬡ ──────────────────────── ⬡  (separador exacto del diseño)
    row += 1;
    canvas.print(x, row, "⬡ ──────────────────────── ⬡", Style::new().fg(AMBER_DIM));
    row += 2;

    row
}

/// Boot lines dinámicas — reflejan el estado real recibido vía IPC (que a su vez viene de SQLite).
fn draw_boot_lines(canvas: &mut Canvas, x: u16, y: u16, w: u16, state: &AppState) -> u16 {
    let mut row = y;

    let worker_count = state.workers.workers.len();
    let has_session  = !state.session.session_id.is_empty();
    let adr_count    = state.adrs.entries.len();
    let provider     = &state.session.provider;

    // Cada línea: (tag_pad, texto, es_last, ok_si_true)
    let load_txt = if worker_count > 0 {
        format!("{worker_count} workers · bee · arch · back · front · sec · test · devops")
    } else {
        "iniciando workers...".to_string()
    };
    let sqlite_txt = if has_session {
        format!("sqlite WAL · sesión {}", &state.session.session_id.get(..8).unwrap_or("?"))
    } else {
        "sqlite + FTS5 · WAL mode".to_string()
    };
    let adr_txt = if adr_count > 0 {
        format!("{adr_count} ADR(s) cargados")
    } else {
        "sin ADRs — cargando...".to_string()
    };
    let ready_txt = format!("listo · provider: {provider} · ⬡ escribe tu tarea");

    let lines: &[(&str, String, bool, bool)] = &[
        ("load ", load_txt,    false, worker_count > 0),
        ("db   ", sqlite_txt,  false, has_session),
        ("adr  ", adr_txt,     false, adr_count > 0),
        ("ready", ready_txt,   true,  true),
    ];

    for (tag, text, is_last, ok) in lines {
        let bracket_tag = format!("[{tag}]");
        let tag_style = if *ok { Style::new().fg(AMBER) } else { Style::new().fg(DIM) };
        canvas.print(x, row, &bracket_tag, tag_style);
        let tag_w = bracket_tag.chars().count() as u16;
        let msg_x = x + tag_w + 1;
        let max_msg = w.saturating_sub(tag_w + 1 + 4) as usize;
        let shown: String = text.chars().take(max_msg).collect();
        let msg_style = if *ok { Style::new().fg(SECONDARY) } else { Style::new().fg(DIM) };
        canvas.print(msg_x, row, &shown, msg_style);
        if *is_last {
            canvas.print(msg_x + shown.chars().count() as u16 + 1, row, "▌", Style::new().fg(AMBER_BRIGHT));
        } else if *ok {
            let ok_x = (x + w).saturating_sub(3);
            canvas.print(ok_x, row, "OK", Style::new().fg(GREEN).bold());
        }
        row += 1;
    }

    row
}

/// Hints exactos del diseño JSX
fn draw_hints(canvas: &mut Canvas, x: u16, y: u16, w: u16) -> u16 {
    let mut row = y + 1; // pequeño gap

    let hints: &[(&str, &str)] = &[
        ("enter",                                    " entrar"),
        ("/welcome",                                 " volver a esta pantalla"),
        ("/layout focus|plan|code|review|dashboard", " cambiar vista"),
    ];

    for (key, desc) in hints {
        let kw = key.chars().count() as u16;
        canvas.print(x, row, key, Style::new().fg(AMBER));
        let avail = w.saturating_sub(kw + 1) as usize;
        let shown: String = desc.chars().take(avail).collect();
        canvas.print(x + kw, row, &shown, Style::new().fg(DIM));
        row += 1;
    }

    row
}

fn draw_right_with_provider(canvas: &mut Canvas, x: u16, y: u16, w: u16, state: &AppState) -> u16 {
    let row = draw_right_base(canvas, x, y, w, &state.session.version);
    let row = draw_boot_lines(canvas, x, row, w, state);
    draw_hints(canvas, x, row, w)
}

fn draw_right_no_provider(canvas: &mut Canvas, x: u16, y: u16, w: u16, version: &str) -> u16 {
    let mut row = draw_right_base(canvas, x, y, w, version);

    // ⚠ Sin provider — extensión propia (fuera del diseño original pero solicitada)
    canvas.print(x, row, "⚠  Sin provider de IA configurado", Style::new().fg(YELLOW).bold());
    row += 1;
    canvas.print(x, row, "   Necesitas al menos un provider para usar hiveCode.", Style::new().fg(SECONDARY));
    row += 2;

    canvas.print(x, row, "Para empezar:", Style::new().fg(WHITE).bold());
    row += 1;
    canvas.print(x, row, "  /provider add", Style::new().fg(AMBER_BRIGHT).bold());
    canvas.print(x + 15, row, "  →  configurar provider de IA", Style::new().fg(DIM));
    row += 1;
    canvas.print(x, row, "  /provider list", Style::new().fg(AMBER));
    canvas.print(x + 16, row, "  →  ver providers disponibles", Style::new().fg(DIM));
    row += 2;

    canvas.print(x, row, "Escribe el comando arriba y pulsa Enter ↵", Style::new().fg(SECONDARY));
    row += 2;

    // Boot lines estándar del diseño (con [wait] en lugar de [ready])
    let lines: &[(&str, &str, bool)] = &[
        ("load ", "cargando workers · bee · arch · back · front · sec · test", false),
        ("sqlite", "sqlite + FTS5 · .hivecode/state.db · WAL mode (~0.6ms)", false),
        ("adr  ", "cargando ADRs · ADR-003 activo", false),
        ("wait ", "esperando configuración del provider", true),
    ];
    for (tag, text, is_last) in lines {
        let bracket_tag = format!("[{tag}]");
        canvas.print(x, row, &bracket_tag, Style::new().fg(AMBER));
        let tag_w = bracket_tag.chars().count() as u16;
        let msg_x = x + tag_w + 1;
        let max_msg = w.saturating_sub(tag_w + 1 + 4) as usize;
        let shown: String = text.chars().take(max_msg).collect();
        let msg_style = if *is_last { Style::new().fg(AMBER) } else { Style::new().fg(SECONDARY) };
        canvas.print(msg_x, row, &shown, msg_style);
        if !is_last {
            canvas.print((x + w).saturating_sub(3), row, "OK", Style::new().fg(GREEN).bold());
        }
        row += 1;
    }

    row
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // Overlay opaco con bg-main (#0D0B07) — cubre todo lo que está debajo
    canvas.fill_rect(area, ' ', Style::new().bg(BG_MAIN));

    let bee_w = BEE_COLS * PX; // 26
    let gap: u16 = 5;
    let right_x = area.x + bee_w + gap;
    let right_w = area.w.saturating_sub(bee_w + gap + 1);

    if area.w < bee_w + gap + 20 {
        // Terminal muy estrecha — solo bee centrada
        let cx = area.x + area.w.saturating_sub(bee_w) / 2;
        let cy = area.y + area.h.saturating_sub(12) / 2;
        draw_bee(canvas, cx, cy, state.slow_tick);
        return;
    }

    // Centrar verticalmente (bee tiene 12 filas + 1 de margen del bob)
    let bee_h: u16 = 12;
    let y = area.y + area.h.saturating_sub(bee_h + 1) / 2;

    draw_bee(canvas, area.x + 1, y, state.slow_tick);

    if state.session.provider.is_empty() {
        draw_right_no_provider(canvas, right_x, y, right_w, &state.session.version);
    } else {
        draw_right_with_provider(canvas, right_x, y, right_w, state);
    }
}

// ── Helpers públicos ──────────────────────────────────────────────────────────

pub fn worker_color(name: &str) -> Color {
    crate::widgets::components::worker_color(name)
}
