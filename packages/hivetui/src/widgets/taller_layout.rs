use crate::{
    state::{AppState, McpState},
    term::{
        Canvas, Rect, Style, AMBER_BRIGHT, AMBER_DIM, AMBER_SUBTLE, BG_PANEL,
        DIM, GREEN, RED, SECONDARY, WHITE, YELLOW,
    },
    ui::{
        scroll::{render_vertical_scrollbar, ScrollbarState},
        text::{cell_width, ellipsize_cells},
    },
};

/// TALLER — configuración del enjambre en una sola vista.
///
/// Antes esto eran un modal de 7 sub-pestañas (`SettingsHubState`), la tab
/// Dashboard y `/logs`, repartidos en tres sitios con tres mecanismos de
/// navegación distintos. Ahora es una tab con navegação propia.
///
/// Las secciones son data, no ramas del código: añadir una es agregar una línea.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Section {
    #[default]
    Enjambre,
    Herramientas,
    Habilidades,
    Mcp,
    Registro,
    Github,
    Telegram,
}

impl Section {
    pub const ALL: [Section; 7] = [
        Section::Enjambre,
        Section::Herramientas,
        Section::Habilidades,
        Section::Mcp,
        Section::Registro,
        Section::Github,
        Section::Telegram,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Section::Enjambre => "ENJAMBRE",
            Section::Herramientas => "HERRAMIENTAS",
            Section::Habilidades => "HABILIDADES",
            Section::Mcp => "MCP",
            Section::Registro => "REGISTRO",
            Section::Github => "GITHUB",
            Section::Telegram => "TELEGRAM",
        }
    }

    pub fn next(self) -> Section {
        let i = Section::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Section::ALL[(i + 1) % Section::ALL.len()]
    }

    pub fn prev(self) -> Section {
        let i = Section::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Section::ALL[(i + Section::ALL.len() - 1) % Section::ALL.len()]
    }

    /// Cuántas filas de contenido tiene. Lo usa el controller para topear el
    /// scroll y el widget para dibujar el scrollbar.
    pub fn row_count(self, state: &AppState) -> usize {
        match self {
            Section::Enjambre => state.roster.by_id.len(),
            Section::Herramientas => state.roster.by_id.values().map(|a| a.tools.len()).sum(),
            Section::Habilidades => state.skills.len(),
            Section::Mcp => state.roster.mcp_servers.len(),
            Section::Registro => state.logs.entries.len(),
            Section::Github => 1,
            Section::Telegram => 1,
        }
    }
}

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState, section: Section, scroll: usize) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let section = clamp(section);
    render_tabs(canvas, area, state, section);

    if area.h <= 2 {
        return;
    }
    let body = Rect::new(area.x, area.y + 1, area.w, area.h.saturating_sub(1));
    let rows = body.h.saturating_sub(1) as usize;

    match section {
        Section::Enjambre => render_agents(canvas, body, state, scroll, rows),
        Section::Herramientas => render_tools(canvas, body, state, scroll, rows),
        Section::Habilidades => render_skills(canvas, body, state, scroll, rows),
        Section::Mcp => render_mcp(canvas, body, state, scroll, rows),
        Section::Registro => render_logs(canvas, body, state, scroll, rows),
        Section::Github => render_flag(canvas, body, "github", state.github_connected, state.github_repo.as_deref()),
        Section::Telegram => render_flag(canvas, body, "telegram", state.telegram_active, None),
    }

    render_vertical_scrollbar(
        canvas,
        Rect::new(area.right().saturating_sub(1), body.y, 1, body.h),
        ScrollbarState::new(section.row_count(state), rows, scroll),
        Style::new().fg(AMBER_DIM),
        Style::new().fg(DIM),
    );
}

fn clamp(section: Section) -> Section {
    if Section::ALL.contains(&section) {
        section
    } else {
        Section::Enjambre
    }
}

fn render_tabs(canvas: &mut Canvas, area: Rect, state: &AppState, active: Section) {
    let y = area.y;
    let mut x = area.x + 1;
    for section in Section::ALL {
        let is_active = section == active;
        let bg = if is_active { AMBER_SUBTLE } else { BG_PANEL };
        canvas.fill_rect(Rect::new(x, y, cell_width(section.label()) as u16 + 2, 1), ' ', Style::new().bg(bg));
        let style = if is_active {
            Style::new().fg(AMBER_BRIGHT).bold().bg(bg)
        } else {
            Style::new().fg(SECONDARY).bg(bg)
        };
        canvas.print(x + 1, y, section.label(), style);
        // Contador en las secciones que tienen algo que ver.
        let count = section.row_count(state);
        if count > 0 && !is_active {
            canvas.print(x + 1 + cell_width(section.label()) as u16, y, &format!(" {count}"), Style::new().fg(DIM).bg(bg));
        }
        x += cell_width(section.label()) as u16 + 2 + if count > 0 && !is_active { cell_width(&count.to_string()) as u16 + 1 } else { 0 };
    }
    let hint = if area.w > 90 { "  ←/→ sección · ↑/↓ scroll" } else { "" };
    canvas.print(area.right().saturating_sub(cell_width(hint) as u16 + 1), y, hint, Style::new().fg(DIM));
}

/// Cada especialista: alias, rol, función, y lo que puede hacer.
fn render_agents(canvas: &mut Canvas, area: Rect, state: &AppState, scroll: usize, rows: usize) {
    let agents = state.roster.agents();
    if agents.is_empty() {
        empty(canvas, area, "sin agentes en el roster — esperando el snapshot del enjambre");
        return;
    }
    for (i, agent) in agents.iter().skip(scroll).take(rows).enumerate() {
        let y = area.y + i as u16;
        let color = agent.color();
        canvas.print(area.x + 1, y, "⬡", Style::new().fg(color));
        canvas.print(area.x + 3, y, &ellipsize_cells(&agent.alias, 16), Style::new().fg(color).bold());
        canvas.print(area.x + 20, y, &ellipsize_cells(&agent.rol, 18), Style::new().fg(SECONDARY));

        // Bloqueado por MCP: la razón por la que `planJevContext` devuelve
        // `agentMcpOff`. Se marca aquí, sin esperar a la primera decisión.
        let blocked = agent.blocked_by();
        let status = if blocked.is_empty() {
            format!("{} tools", agent.tools.len())
        } else {
            format!("✗ {} apagado", blocked.join(" "))
        };
        let status_style = if blocked.is_empty() {
            Style::new().fg(DIM)
        } else {
            Style::new().fg(RED).bold()
        };
        canvas.print(area.x + 40, y, &ellipsize_cells(&status, 24), status_style);

        if area.w > 110 {
            canvas.print(
                area.x + 66,
                y,
                &ellipsize_cells(&agent.funcion, area.w.saturating_sub(68) as usize),
                Style::new().fg(DIM),
            );
        }
    }
}

/// Las herramientas por especialista: la respuesta a "¿quién puede hacer qué?".
fn render_tools(canvas: &mut Canvas, area: Rect, state: &AppState, scroll: usize, rows: usize) {
    let mut flat: Vec<(&str, &str)> = Vec::new();
    for agent in state.roster.agents() {
        for tool in &agent.tools {
            flat.push((tool.as_str(), agent.alias.as_str()));
        }
    }
    if flat.is_empty() {
        empty(canvas, area, "ningún agente declara herramientas todavía");
        return;
    }
    for (i, (tool, alias)) in flat.iter().skip(scroll).take(rows).enumerate() {
        let y = area.y + i as u16;
        canvas.print(area.x + 1, y, &ellipsize_cells(tool, 40), Style::new().fg(WHITE));
        canvas.print(area.x + 43, y, &format!("· {alias}"), Style::new().fg(AMBER_DIM));
    }
}

fn render_skills(canvas: &mut Canvas, area: Rect, state: &AppState, scroll: usize, rows: usize) {
    if state.skills.is_empty() {
        empty(canvas, area, "sin habilidades cargadas");
        return;
    }
    for (i, skill) in state.skills.iter().skip(scroll).take(rows).enumerate() {
        let y = area.y + i as u16;
        let dot_style = if skill.active {
            Style::new().fg(GREEN)
        } else {
            Style::new().fg(DIM)
        };
        canvas.print(area.x + 1, y, if skill.active { "●" } else { "○" }, dot_style);
        canvas.print(area.x + 3, y, &ellipsize_cells(&skill.name, 28), Style::new().fg(WHITE));
        canvas.print(area.x + 33, y, &ellipsize_cells(&skill.category, 16), Style::new().fg(SECONDARY));
        canvas.print(area.x + 51, y, &ellipsize_cells(&skill.description, area.w.saturating_sub(54) as usize), Style::new().fg(DIM));
    }
}

fn render_mcp(canvas: &mut Canvas, area: Rect, state: &AppState, scroll: usize, rows: usize) {
    let servers = &state.roster.mcp_servers;
    if servers.is_empty() {
        empty(canvas, area, "sin servidores MCP registrados");
        return;
    }
    for (i, server) in servers.iter().skip(scroll).take(rows).enumerate() {
        let y = area.y + i as u16;
        let (glyph, color) = match server.state {
            McpState::Active => ("●", GREEN),
            McpState::Available => ("○", SECONDARY),
            // Apagado no es un error de configuración menor: bloquea a quien
            // dependa de él, así que se marca en ámbar fuerte.
            McpState::Off => ("×", YELLOW),
            McpState::Unknown => ("·", DIM),
        };
        canvas.print(area.x + 1, y, glyph, Style::new().fg(color));
        canvas.print(area.x + 3, y, &ellipsize_cells(&server.name, 28), Style::new().fg(WHITE));
        canvas.print(area.x + 33, y, &format!("{} tools", server.tools), Style::new().fg(DIM));
        canvas.print(area.x + 48, y, server.state.label(), Style::new().fg(color));
    }
}

fn render_logs(canvas: &mut Canvas, area: Rect, state: &AppState, scroll: usize, rows: usize) {
    if state.logs.entries.is_empty() {
        empty(canvas, area, "sin entradas en el registro");
        return;
    }
    // Lo reciente al final: el dato interesante de un log es el final.
    let total = state.logs.entries.len();
    let start = scroll.max(total.saturating_sub(rows));
    for (i, entry) in state.logs.entries.iter().skip(start).take(rows).enumerate() {
        let y = area.y + i as u16;
        let color = match entry.level.to_ascii_lowercase().as_str() {
            "error" | "err" => RED,
            "warn" | "warning" => YELLOW,
            "debug" => DIM,
            _ => GREEN,
        };
        canvas.print(area.x + 1, y, &format!("{:<5}", entry.level.to_uppercase()), Style::new().fg(color));
        canvas.print(area.x + 8, y, &ellipsize_cells(&entry.source, 14), Style::new().fg(AMBER_DIM));
        canvas.print(area.x + 24, y, &ellipsize_cells(&entry.message, area.w.saturating_sub(26) as usize), Style::new().fg(SECONDARY));
    }
}

fn render_flag(canvas: &mut Canvas, area: Rect, name: &str, connected: bool, detail: Option<&str>) {
    let y = area.y + 1;
    let (glyph, label, color) = if connected {
        ("●", "conectado", GREEN)
    } else {
        ("○", "sin conectar", SECONDARY)
    };
    canvas.print(area.x + 2, y, glyph, Style::new().fg(color));
    canvas.print(area.x + 4, y, name, Style::new().fg(WHITE).bold());
    canvas.print(area.x + 4 + name.len() as u16 + 2, y, label, Style::new().fg(color));
    if let Some(detail) = detail.filter(|d| !d.is_empty()) {
        canvas.print(area.x + 2, y + 2, &format!("repositorio: {detail}"), Style::new().fg(DIM));
    }
}

fn empty(canvas: &mut Canvas, area: Rect, message: &str) {
    if area.h == 0 {
        return;
    }
    canvas.print(
        area.x + 2,
        area.y + 1,
        &ellipsize_cells(message, area.w.saturating_sub(4) as usize),
        Style::new().fg(DIM),
    );
}

/// Filas de la sección activa. Lo consulta el controller al hacer scroll.
pub fn section_rows(state: &AppState) -> usize {
    clamp(state.taller_section).row_count(state)
}

/// Estado del tab: la sección activa vive en `AppState`.
pub fn render_for_state(canvas: &mut Canvas, area: Rect, state: &AppState) {
    render(canvas, area, state, state.taller_section, state.taller_scroll);
}

/// Reexportado para el header, que muestra en qué sección está el taller.
pub fn section_label(state: &AppState) -> &'static str {
    clamp(state.taller_section).label()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{IpcRosterAgent, IpcRosterMcpRef};
    use crate::state::{RosterAgent, RosterState, SkillSummary};

    fn agent(rol: &str, alias: &str, nivel: u8, tools: &[&str], mcp: &[(&str, &str)]) -> IpcRosterAgent {
        IpcRosterAgent {
            id: format!("id-{rol}"),
            rol: rol.to_string(),
            alias: alias.to_string(),
            funcion: "función de prueba".to_string(),
            nivel,
            tools: tools.iter().map(|s| s.to_string()).collect(),
            mcp: mcp.iter().map(|(n, s)| IpcRosterMcpRef {
                name: n.to_string(),
                state: s.to_string(),
            }).collect(),
        }
    }

    fn canvas_for(w: u16, h: u16) -> Canvas {
        Canvas::new(w, h)
    }

    #[test]
    fn the_section_strip_lists_all_seven_sections() {
        let mut state = AppState::default();
        state.taller_section = Section::Enjambre;
        let mut canvas = canvas_for(140, 12);
        render_for_state(&mut canvas, Rect::new(0, 0, 140, 12), &state);

        let frame = canvas.to_text_rows().join("\n");
        for label in ["ENJAMBRE", "HERRAMIENTAS", "HABILIDADES", "MCP", "REGISTRO", "GITHUB", "TELEGRAM"] {
            assert!(frame.contains(label), "falta la sección {label}");
        }
    }

    #[test]
    fn sections_cycle_in_both_directions_and_wrap_around() {
        assert_eq!(Section::Enjambre.next(), Section::Herramientas);
        assert_eq!(Section::Enjambre.prev(), Section::Telegram);
        assert_eq!(Section::Telegram.next(), Section::Enjambre);
        // Recorrer todo el ciclo devuelve al inicio.
        let mut s = Section::Enjambre;
        for _ in 0..Section::ALL.len() {
            s = s.next();
        }
        assert_eq!(s, Section::Enjambre);
    }

    #[test]
    fn an_empty_section_says_so_instead_of_rendering_nothing() {
        let mut state = AppState::default();
        state.taller_section = Section::Enjambre;
        let mut canvas = canvas_for(120, 10);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        // Un panel vacío parece un bug. Decir qué falta no lo es.
        assert!(frame.contains("sin agentes en el roster"), "{frame}");
    }

    #[test]
    fn a_blocked_specialist_is_marked_with_the_mcp_that_blocks_it() {
        let mut state = AppState::default();
        state.roster.apply(vec![agent("quetzal", "Quetzal", 2, &["fs_write"], &[("obscura", "apagado")])]);

        let mut canvas = canvas_for(120, 10);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("Quetzal"), "{frame}");
        assert!(frame.contains("obscura"), "no dice qué MCP lo bloquea");
    }

    #[test]
    fn an_operable_specialist_shows_its_tool_count_not_a_warning() {
        let mut state = AppState::default();
        state.roster.apply(vec![agent("topo", "Topo", 2, &["fs_read", "fs_write"], &[])]);

        let mut canvas = canvas_for(120, 10);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("2 tools"), "{frame}");
        assert!(!frame.contains('✗'));
    }

    #[test]
    fn the_tools_section_answers_who_can_do_what() {
        // La pregunta que `/habilidades` hará después: primero quién puede.
        let mut state = AppState::default();
        state.roster.apply(vec![
            agent("topo", "Topo", 2, &["fs_write", "shell_executor"], &[]),
            agent("quetzal", "Quetzal", 2, &["fs_write"], &[]),
        ]);
        state.taller_section = Section::Herramientas;

        let mut canvas = canvas_for(120, 12);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 12), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("shell_executor"), "{frame}");
        assert!(frame.contains("Topo"));
        assert!(frame.contains("Quetzal"));
        // Una tool compartida por dos aparece dos veces, no fusionada: el usuario
        // necesita ver quién la tiene, no solo que existe.
        assert_eq!(frame.matches("fs_write").count(), 2);
    }

    #[test]
    fn skills_show_their_active_state() {
        let mut state = AppState::default();
        state.skills = vec![
            SkillSummary { name: "git_workflow".into(), category: "git".into(), description: "commits y PRs".into(), active: true },
            SkillSummary { name: "voice_output".into(), category: "voice".into(), description: "habla".into(), active: false },
        ];
        state.taller_section = Section::Habilidades;

        let mut canvas = canvas_for(120, 10);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("git_workflow"), "{frame}");
        assert!(frame.contains("voice_output"));
        assert!(frame.contains('●'));
        assert!(frame.contains('○'));
    }

    #[test]
    fn an_off_mcp_is_distinguishable_from_a_connected_one() {
        let mut state = AppState::default();
        state.roster.mcp_servers = vec![
            crate::state::McpRef { id: "1".into(), name: "activo".into(), tools: 37, state: McpState::Active },
            crate::state::McpRef { id: "2".into(), name: "apagado".into(), tools: 0, state: McpState::Off },
        ];
        state.taller_section = Section::Mcp;

        let mut canvas = canvas_for(120, 10);
        render_for_state(&mut canvas, Rect::new(0, 0, 120, 10), &state);

        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("conectado"), "{frame}");
        assert!(frame.contains("apagado"));
        assert!(frame.contains('×'));
    }

    #[test]
    fn the_row_count_matches_what_each_section_actually_renders() {
        // El controller topea el scroll con este número: si miente, la rueda
        // recorre un vacío.
        let mut state = AppState::default();
        state.roster.apply(vec![
            agent("topo", "Topo", 2, &["fs_read", "fs_write"], &[]),
            agent("quetzal", "Quetzal", 2, &["fs_write"], &[]),
        ]);

        assert_eq!(Section::Enjambre.row_count(&state), 2);
        // 2 + 1 tools entre los dos agentes.
        assert_eq!(Section::Herramientas.row_count(&state), 3);
        assert_eq!(Section::Habilidades.row_count(&state), 0);

        state.skills = vec![SkillSummary::default()];
        assert_eq!(Section::Habilidades.row_count(&state), 1);
    }

    #[test]
    fn rendering_survives_a_tiny_area() {
        for (w, h) in [(1u16, 1u16), (10, 2), (40, 3), (200, 60)] {
            let mut state = AppState::default();
            state.roster.apply(vec![agent("topo", "Topo", 2, &["fs_read"], &[])]);
            for section in Section::ALL {
                state.taller_section = section;
                let mut canvas = canvas_for(w, h);
                render_for_state(&mut canvas, Rect::new(0, 0, w, h), &state);
            }
        }
    }

    #[test]
    fn section_label_never_panics_on_a_bad_state() {
        let mut state = AppState::default();
        assert_eq!(section_label(&state), "ENJAMBRE");
        state.taller_section = Section::Telegram;
        assert_eq!(section_label(&state), "TELEGRAM");
    }

    #[test]
    fn a_reserved_agent_type_keeps_its_spanish_label() {
        // El roster debe poder sobreescribir el alias (agentes custom), pero si
        // no lo manda, la tabla sigue hablando español.
        let mut roster = RosterState::default();
        roster.apply(vec![agent("backend", "", 2, &[], &[])]);
        assert_eq!(roster.by_id["id-backend"].label(), "Topo · backend");
        let _: &RosterAgent = &roster.by_id["id-backend"];
    }
}
