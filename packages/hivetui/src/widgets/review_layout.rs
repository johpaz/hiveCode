use crate::{
    state::{AppState, ReplMode, RiskLevel},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED, WHITE, YELLOW},
    ui::{render_data_table, render_markdown, DataTable, MarkdownView, TableAlign, TableCell, TableColumn, TableState},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.h < 6 {
        return;
    }

    // En modo APPROVAL el strip es más alto (8 filas) para señalizar la decisión
    let strip_h = if state.session.mode == ReplMode::Approval {
        8u16.min(area.h / 2)
    } else {
        6u16.min(area.h / 3)
    };
    let panels = area.vsplit(&[0, strip_h]);
    canvas.with_clip(panels[0], |canvas| render_adr_pane(canvas, panels[0], state));
    canvas.with_clip(panels[1], |canvas| render_approval_strip(canvas, panels[1], state));
}

fn render_adr_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if state.adrs.entries.is_empty() {
        let title = "⬡ ADR · Architecture Decision Records";
        canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());
        canvas.print(area.x + 2, area.y + 2, "Sin ADRs activos", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 3, "Se mostrarán aquí cuando el worker de arquitectura genere decisiones.", Style::new().fg(DIM));
        return;
    }

    let idx = state.adrs.selected.min(state.adrs.entries.len().saturating_sub(1));
    let adr = &state.adrs.entries[idx];

    // Header: título + status + navegación si hay más de uno
    let status_color = match adr.status.as_str() {
        "accepted" => GREEN,
        "proposed" => YELLOW,
        "rejected" => RED,
        _          => DIM,
    };
    let header = format!("⬡ ADR · {} [{}/{}]", adr.title, idx + 1, state.adrs.entries.len());
    canvas.print(area.x + 1, area.y, &header, Style::new().fg(AMBER).bold());
    canvas.print(area.right().saturating_sub(adr.status.len() as u16 + 2), area.y,
                 &adr.status, Style::new().fg(status_color).bold());

    let markdown_area = Rect::new(area.x + 2, area.y + 1, area.w.saturating_sub(4), area.h.saturating_sub(2));
    let lines = crate::ui::build_markdown_lines(&adr.content, markdown_area.w as usize);
    let avail_h = markdown_area.h as usize;
    let start = state.adrs.scroll.min(lines.len().saturating_sub(avail_h));
    render_markdown(
        canvas,
        markdown_area,
        &adr.content,
        MarkdownView { scroll: state.adrs.scroll },
    );

    if lines.len() > avail_h {
        let pct = (start * 100) / lines.len().max(1);
        let hint = format!("{}% · ↑↓ scroll", pct);
        canvas.print(area.right().saturating_sub(hint.len() as u16 + 1),
                     area.bottom().saturating_sub(1), &hint, Style::new().fg(DIM));
    }
}

fn render_approval_strip(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    // En modo APPROVAL: borde superior destacado para señalizar el momento de decisión
    let is_approval = state.session.mode == ReplMode::Approval;
    let border_color = if is_approval { AMBER_BRIGHT } else { AMBER_DIM };
    let sep: String = std::iter::repeat('─').take(area.w as usize).collect();
    canvas.print(area.x, area.y, &sep, Style::new().fg(border_color));

    let file_count = state.filemap.entries.len();
    let header = if is_approval {
        format!("⬡ APROBAR O RECHAZAR · {} archivo(s)", file_count)
    } else {
        format!("⬡ ARCHIVOS PARA APROBAR · {file_count}")
    };
    let header_color = if is_approval { AMBER_BRIGHT } else { AMBER_BRIGHT };
    canvas.print(area.x + 1, area.y, &header, Style::new().fg(header_color).bold());

    if state.filemap.entries.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin archivos pendientes de aprobación", Style::new().fg(DIM));
        return;
    }

    let list_rows = area.h.saturating_sub(3) as usize;
    let columns = [
        TableColumn::fixed("", 1, TableAlign::Left),
        TableColumn::fill("archivo", 1, TableAlign::Left),
        TableColumn::fixed("riesgo", 8, TableAlign::Right),
    ];
    let mut rows = Vec::new();
    for entry in state.filemap.entries.iter().take(list_rows) {
        let (dot_color, risk_tag) = match entry.risk {
            RiskLevel::Low      => (GREEN,  "[low]   "),
            RiskLevel::Medium   => (YELLOW, "[medium]"),
            RiskLevel::High     => (AMBER,  "[high]  "),
            RiskLevel::Critical => (RED,    "[crit]  "),
        };
        rows.push(vec![
            TableCell::new("●", Style::new().fg(dot_color).bold()),
            TableCell::new(entry.path.clone(), Style::new().fg(WHITE)),
            TableCell::new(risk_tag.trim(), Style::new().fg(dot_color)),
        ]);
    }
    render_data_table(
        canvas,
        Rect::new(area.x + 1, area.y + 1, area.w.saturating_sub(2), list_rows as u16),
        &columns,
        &rows,
        TableState::default(),
        &DataTable { show_header: false, ..DataTable::default() },
    );

    // Hints de acción — más prominentes en modo APPROVAL
    let hint_y = area.bottom().saturating_sub(1);
    if is_approval {
        canvas.print(area.x + 1, hint_y, "[↩ /approve]", Style::new().fg(GREEN).bold());
        canvas.print(area.x + 14, hint_y, " proceder  ·  ", Style::new().fg(DIM));
        canvas.print(area.x + 28, hint_y, "[↩ /reject <razón>]", Style::new().fg(RED).bold());
        canvas.print(area.x + 48, hint_y, " devolver a Bee", Style::new().fg(DIM));
    } else {
        canvas.print(area.x + 1, hint_y, "→ ", Style::new().fg(AMBER_DIM));
        canvas.print(area.x + 3, hint_y, "/approve", Style::new().fg(AMBER).bold());
        canvas.print(area.x + 11, hint_y, " para aceptar  ·  ", Style::new().fg(DIM));
        canvas.print(area.x + 29, hint_y, "/reject <razón>", Style::new().fg(AMBER).bold());
        canvas.print(area.x + 44, hint_y, " para devolver", Style::new().fg(DIM));
    }
}
