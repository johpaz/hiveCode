use crate::{
    state::{AppState, ModalState, SettingsTab},
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, RED, SECONDARY, WHITE, BG_ELEVATED},
    ui::{HitAction, MouseRegion},
};

const HUB_Z: i16 = 50; // por encima de todo lo demás

pub fn render(canvas: &mut Canvas, full_area: Rect, state: &mut AppState, register_hits: bool) {
    let ModalState::Settings(hub) = &state.modal else { return };

    let modal_w = (full_area.w.saturating_sub(8)).min(100).max(60);
    let modal_h = (full_area.h.saturating_sub(4)).min(30).max(20);
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;
    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print_centered(area.x, area.y, area.w, " ⚙  Configuración ", Style::new().fg(CYAN).bold());

    // ── Tabs ──────────────────────────────────────────────────────────────────
    let tab_y = area.y + 1;
    let mut tab_x = area.x + 2;
    for tab in SettingsTab::ALL {
        let is_active = *tab == hub.active_tab;
        let label = if is_active {
            format!("[{}]", tab.label())
        } else {
            format!(" {} ", tab.label())
        };
        let style = if is_active { Style::new().fg(AMBER).bold() } else { Style::new().fg(SECONDARY) };
        canvas.print(tab_x, tab_y, &label, style);

        // Registrar hit region del tab
        if register_hits {
            let tab_rect = Rect { x: tab_x, y: tab_y, w: label.len() as u16, h: 1 };
            state.hit_map.push(MouseRegion::new(
                format!("settings:tab:{}", tab.label()),
                tab_rect,
                HUB_Z,
                HitAction::Custom(format!("settings:tab:{}", tab.label())),
            ));
        }
        tab_x += label.len() as u16 + 2;
    }

    // Separador
    let sep_y = area.y + 2;
    for x in (area.x + 1)..(area.right() - 1) {
        canvas.print(x, sep_y, "─", Style::new().fg(DIM));
    }

    // Área de contenido
    let content_area = Rect {
        x: area.x + 1,
        y: sep_y + 1,
        w: area.w - 2,
        h: area.h.saturating_sub(6),
    };

    if hub.loading {
        canvas.print(content_area.x + 2, content_area.y + 2, "Cargando…", Style::new().fg(DIM));
    } else {
        // Re-borrow immutably for rendering content
        let ModalState::Settings(hub) = &state.modal else { return };
        match hub.active_tab {
            SettingsTab::Providers => render_providers(canvas, content_area, state, register_hits),
            SettingsTab::Models    => render_models(canvas, content_area, state, register_hits),
            SettingsTab::Mcp       => render_mcp(canvas, content_area, state, register_hits),
            SettingsTab::Skills    => render_skills(canvas, content_area, state, register_hits),
            SettingsTab::Github    => render_github(canvas, content_area, state),
            SettingsTab::Telegram  => render_telegram(canvas, content_area, state),
        }
    }

    // Footer
    let hint_y = area.bottom().saturating_sub(2);
    canvas.print(area.x + 2, hint_y,
        "Tab · ↑↓/clic · A añadir · D eliminar · Enter editar · Esc cerrar",
        Style::new().fg(DIM));

    // Registrar región del modal completo para capturar clics (evita que pasen al fondo)
    if register_hits {
        state.hit_map.push(MouseRegion::new(
            "settings:backdrop",
            area,
            HUB_Z - 1,
            HitAction::Custom("settings:noop".into()),
        ));
    }
}

fn render_providers(canvas: &mut Canvas, area: Rect, state: &mut AppState, register_hits: bool) {
    let ModalState::Settings(hub) = &state.modal else { return };

    canvas.print(area.x,      area.y, "ID",     Style::new().fg(DIM));
    canvas.print(area.x + 16, area.y, "Modelo", Style::new().fg(DIM));
    canvas.print(area.x + 36, area.y, "Key",    Style::new().fg(DIM));
    canvas.print(area.x + 42, area.y, "Estado", Style::new().fg(DIM));

    if hub.providers.is_empty() {
        canvas.print(area.x + 2, area.y + 2,
            "Sin providers. Presiona A para añadir uno.", Style::new().fg(DIM));
        return;
    }

    let selected = hub.selected_row;
    for (i, p) in hub.providers.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() { break; }

        let is_sel = selected == i;
        if is_sel {
            canvas.fill_rect(Rect { x: area.x, y, w: area.w, h: 1 }, ' ', Style::new().fg(WHITE));
            canvas.print(area.x, y, "▶ ", Style::new().fg(AMBER).bold());
        }
        let style = if is_sel { Style::new().fg(WHITE).bold() } else { Style::new().fg(SECONDARY) };
        let id    = truncate(&p.id, 14);
        let model = truncate(&p.model, 18);
        canvas.print(area.x + 2,  y, &id,    style);
        canvas.print(area.x + 16, y, &model, style);
        canvas.print(area.x + 36, y, if p.has_key { "✓" } else { "?" },
            if p.has_key { Style::new().fg(GREEN) } else { Style::new().fg(RED) });
        canvas.print(area.x + 42, y,
            if p.is_active { "● activo" } else { "○" },
            if p.is_active { Style::new().fg(GREEN).bold() } else { Style::new().fg(DIM) });

        if register_hits {
            state.hit_map.push(MouseRegion::new(
                format!("settings:row:{i}"),
                Rect { x: area.x, y, w: area.w, h: 1 },
                HUB_Z,
                HitAction::Custom(format!("settings:row:{i}")),
            ));
        }
    }
}

fn render_mcp(canvas: &mut Canvas, area: Rect, state: &mut AppState, register_hits: bool) {
    let ModalState::Settings(hub) = &state.modal else { return };

    canvas.print(area.x,      area.y, "Nombre", Style::new().fg(DIM));
    canvas.print(area.x + 20, area.y, "URL",    Style::new().fg(DIM));
    canvas.print(area.x + 50, area.y, "Estado", Style::new().fg(DIM));

    if hub.mcp.is_empty() {
        canvas.print(area.x + 2, area.y + 2,
            "Sin servidores MCP. Presiona A para añadir.", Style::new().fg(DIM));
        return;
    }

    let selected = hub.selected_row;
    for (i, m) in hub.mcp.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() { break; }

        let is_sel = selected == i;
        if is_sel {
            canvas.fill_rect(Rect { x: area.x, y, w: area.w, h: 1 }, ' ', Style::new().fg(WHITE));
            canvas.print(area.x, y, "▶ ", Style::new().fg(AMBER).bold());
        }
        let style = if is_sel { Style::new().fg(WHITE).bold() } else { Style::new().fg(SECONDARY) };
        canvas.print(area.x + 2,  y, &truncate(&m.name, 18), style);
        canvas.print(area.x + 20, y, &truncate(&m.url, 28),  style);
        canvas.print(area.x + 50, y,
            if m.enabled { "● activo" } else { "○ off" },
            if m.enabled { Style::new().fg(GREEN) } else { Style::new().fg(DIM) });

        if register_hits {
            state.hit_map.push(MouseRegion::new(
                format!("settings:row:{i}"),
                Rect { x: area.x, y, w: area.w, h: 1 },
                HUB_Z,
                HitAction::Custom(format!("settings:row:{i}")),
            ));
        }
    }
}

fn render_skills(canvas: &mut Canvas, area: Rect, state: &mut AppState, register_hits: bool) {
    let ModalState::Settings(hub) = &state.modal else { return };

    canvas.print(area.x,      area.y, "Nombre",    Style::new().fg(DIM));
    canvas.print(area.x + 24, area.y, "Categoría", Style::new().fg(DIM));
    canvas.print(area.x + 40, area.y, "Estado",    Style::new().fg(DIM));

    if hub.skills.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "Sin skills configurados.", Style::new().fg(DIM));
        return;
    }

    let selected = hub.selected_row;
    for (i, s) in hub.skills.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() { break; }

        let is_sel = selected == i;
        if is_sel {
            canvas.fill_rect(Rect { x: area.x, y, w: area.w, h: 1 }, ' ', Style::new().fg(WHITE));
            canvas.print(area.x, y, "▶ ", Style::new().fg(AMBER).bold());
        }
        let style = if is_sel { Style::new().fg(WHITE).bold() } else { Style::new().fg(SECONDARY) };
        canvas.print(area.x + 2,  y, &truncate(&s.name, 22),     style);
        canvas.print(area.x + 24, y, &truncate(&s.category, 14), style);
        canvas.print(area.x + 40, y,
            if s.active { "● on" } else { "○ off" },
            if s.active { Style::new().fg(GREEN) } else { Style::new().fg(DIM) });
        canvas.print(area.x + 46, y, "[Space]", Style::new().fg(DIM));

        if register_hits {
            state.hit_map.push(MouseRegion::new(
                format!("settings:row:{i}"),
                Rect { x: area.x, y, w: area.w, h: 1 },
                HUB_Z,
                HitAction::Custom(format!("settings:row:{i}")),
            ));
        }
    }
}

fn render_models(canvas: &mut Canvas, area: Rect, state: &mut AppState, register_hits: bool) {
    let ModalState::Settings(hub) = &state.modal else { return };

    canvas.print(area.x,      area.y, "Provider", Style::new().fg(DIM));
    canvas.print(area.x + 16, area.y, "Modelo",   Style::new().fg(DIM));
    canvas.print(area.x + 52, area.y, "Activo",   Style::new().fg(DIM));

    if hub.providers.is_empty() {
        canvas.print(area.x + 2, area.y + 2,
            "Configura un provider primero (tab Providers).", Style::new().fg(DIM));
        return;
    }

    let selected = hub.selected_row;
    for (i, p) in hub.providers.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() { break; }

        let is_sel = selected == i;
        if is_sel {
            canvas.fill_rect(Rect { x: area.x, y, w: area.w, h: 1 }, ' ', Style::new().fg(WHITE));
            canvas.print(area.x, y, "▶ ", Style::new().fg(AMBER).bold());
        }
        let style = if is_sel { Style::new().fg(WHITE).bold() } else { Style::new().fg(SECONDARY) };
        canvas.print(area.x + 2,  y, &truncate(&p.id, 14),    style);
        canvas.print(area.x + 16, y, &truncate(&p.model, 34), style);
        canvas.print(area.x + 52, y,
            if p.is_active { "●" } else { "○" },
            if p.is_active { Style::new().fg(GREEN).bold() } else { Style::new().fg(DIM) });

        if register_hits {
            state.hit_map.push(MouseRegion::new(
                format!("settings:row:{i}"),
                Rect { x: area.x, y, w: area.w, h: 1 },
                HUB_Z,
                HitAction::Custom(format!("settings:row:{i}")),
            ));
        }
    }
    // Hint: Enter para cambiar el modelo de un provider
    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, hint_y,
        "Enter → cambiar modelo del provider seleccionado  ·  A → activar provider",
        Style::new().fg(DIM));
}

fn render_github(canvas: &mut Canvas, area: Rect, state: &mut AppState) {
    let ModalState::Settings(hub) = &state.modal else { return };
    let (label, style) = if hub.github_connected {
        ("● Conectado", Style::new().fg(GREEN).bold())
    } else {
        ("○ Sin conectar", Style::new().fg(DIM))
    };
    canvas.print(area.x + 2, area.y + 1, "Estado:", Style::new().fg(SECONDARY));
    canvas.print(area.x + 10, area.y + 1, label, style);
    if let Some(repo) = &hub.github_repo {
        canvas.print(area.x + 2, area.y + 2, "Repo:", Style::new().fg(SECONDARY));
        canvas.print(area.x + 10, area.y + 2, repo, Style::new().fg(WHITE));
    }
    if hub.github_connected {
        canvas.print(area.x + 2, area.y + 4, "Enter → gestionar conexión", Style::new().fg(DIM));
    } else {
        canvas.print(area.x + 2, area.y + 4, "A → Conectar GitHub", Style::new().fg(AMBER));
    }
}

fn render_telegram(canvas: &mut Canvas, area: Rect, state: &mut AppState) {
    let ModalState::Settings(hub) = &state.modal else { return };
    let (label, style) = if hub.telegram_active {
        ("● Bot activo", Style::new().fg(GREEN).bold())
    } else {
        ("○ Sin conectar", Style::new().fg(DIM))
    };
    canvas.print(area.x + 2, area.y + 1, "Estado:", Style::new().fg(SECONDARY));
    canvas.print(area.x + 10, area.y + 1, label, style);
    if hub.telegram_active {
        canvas.print(area.x + 2, area.y + 3, "Enter → gestionar bot", Style::new().fg(DIM));
    } else {
        canvas.print(area.x + 2, area.y + 3, "A → Conectar Telegram", Style::new().fg(AMBER));
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max { format!("{}…", &s[..max.saturating_sub(1)]) } else { s.to_string() }
}
