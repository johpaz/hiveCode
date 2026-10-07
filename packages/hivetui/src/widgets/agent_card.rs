use crate::{
    state::{AppState, RosterAgent, SkillFit},
    term::{
        Canvas, Rect, Style, AMBER_DIM, AMBER_SUBTLE, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED,
        SECONDARY, WHITE, YELLOW,
    },
    ui::text::{cell_width, ellipsize_cells},
};

/// FICHA · <alias> — qué es este agente y qué puede hacer.
///
/// Responde cuatro preguntas que antes no tenían respuesta en ninguna parte:
///
/// 1. **¿Qué es?** — alias, rol y función en una línea.
/// 2. **¿Qué puede hacer?** — la carga base declarada.
/// 3. **¿Qué tiene *ahora*?** — la carga efectiva del último turno, que JEV puede
///    haber podado. Mostrar solo la base mentiría en la dirección contraria.
/// 4. **¿Por qué no avanza?** — la espera, la última decisión de JEV y la tool
///    en vuelo.
///
/// La sección de habilidades es la que responde "¿puedo pedirle esto?": cada
/// fila dice si este agente puede usarla y, si no puede, qué tool le falta.

/// Columna de valores. Debe superar `1 + ancho de la etiqueta más larga`
/// (`"ÚLTIMA DECISIÓN"` = 14 celdas), o el valor pisa el último carácter de la
/// etiqueta.
const LABEL_X: u16 = 16;

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState, agent: &RosterAgent) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let mut y = area.y;

    // ── Cabecera: quién es ────────────────────────────────────────────────
    canvas.print(area.x + 1, y, "⬡", Style::new().fg(agent.color()));
    canvas.print(
        area.x + 3,
        y,
        &ellipsize_cells(&agent.alias, 20),
        Style::new().fg(agent.color()).bold(),
    );
    canvas.print(
        area.x + 3 + cell_width(&agent.alias) as u16 + 2,
        y,
        &format!("· {}", agent.rol),
        Style::new().fg(SECONDARY),
    );
    if let Some(worker) = state.workers.workers.iter().find(|w| w.name == agent.rol) {
        canvas.print(
            area.right().saturating_sub(worker.status.emoji().len() as u16 + 8),
            y,
            &format!("{} {}", worker.status.emoji(), agent.tier.label()),
            Style::new().fg(crate::widgets::components::worker_color(&agent.rol)),
        );
    }
    y += 1;

    if y < area.bottom() {
        canvas.print(
            area.x + 3,
            y,
            &wrap_line(&agent.funcion, area.w.saturating_sub(6) as usize),
            Style::new().fg(WHITE),
        );
        y += 1;
    }

    y = rule(canvas, area, y);

    // ── Carga base: lo declarado ─────────────────────────────────────────
    y = field(
        canvas, area, y, "CARGA BASE",
        &format!("{} herramientas · {} habilidades", agent.tools.len(), base_skills(state, agent)),
    );
    y = chips(canvas, area, y, &agent.tools.iter().take(6).map(|s| s.as_str()).collect::<Vec<_>>(), agent.color());
    y = chips(canvas, area, y, &base_skill_names(state, agent), GREEN);

    // ── Carga ahora: la efectiva, que JEV puede haber podado ─────────────
    match state.loadout.get(&agent.id) {
        Some(loadout) => {
            let marca = if loadout.pruned { "  podada por jev" } else { "" };
            y = field(
                canvas, area, y, "CARGA AHORA",
                &format!("{}{marca}", loadout.summary()),
            );
            y = chips(canvas, area, y, &loadout.tools.iter().take(6).map(|s| s.as_str()).collect::<Vec<_>>(), if loadout.pruned { YELLOW } else { agent.color() });
            y = chips(canvas, area, y, &loadout.skills.iter().take(4).map(|s| s.as_str()).collect::<Vec<_>>(), GREEN);
        }
        None => {
            y = field(canvas, area, y, "CARGA AHORA", "sin datos de este turno todavía");
        }
    }

    y = rule(canvas, area, y);

    // ── Qué está haciendo ahora ─────────────────────────────────────────
    let (line, color) = live_line(state, agent);
    if y < area.bottom() {
        canvas.print(area.x + 1, y, &ellipsize_cells(&line, area.w.saturating_sub(4) as usize), Style::new().fg(color));
        y += 1;
    }

    // ── Última decisión de JEV ──────────────────────────────────────────
    if let Some(decision) = state.jev.last_by_agent.get(&agent.id) {
        let detalle = decision
            .saved_tokens_display()
            .map(|t| format!(" · ahorró {t}"))
            .unwrap_or_default();
        y = field(
            canvas, area, y, "ÚLTIMA DECISIÓN",
            &format!("{} · {}{detalle}", decision.kind, decision.summary),
        );
    } else if state.jev.availability.is_configured() {
        y = field(canvas, area, y, "ÚLTIMA DECISIÓN", "todavía ninguna");
    }

    // ── Habilidades: puede, no puede, y por qué ────────────────────────
    if !state.library.is_empty() && y < area.bottom() {
        y = rule(canvas, area, y);
        let (always, discoverable, blocked) = (
            state.library.count_for(&agent.tools, SkillFit::Always),
            state.library.count_for(&agent.tools, SkillFit::Discoverable),
            state.library.count_for(&agent.tools, SkillFit::Blocked),
        );
        canvas.print(
            area.x + 1, y,
            &format!("HABILIDADES  ●{always} siempre  ○{discoverable} por descubrir  ✗{blocked} bloqueadas"),
            Style::new().fg(if blocked > 0 { YELLOW } else { GREEN }),
        );
        y += 1;

        // Las bloqueadas primero: son las que impiden pedirle algo.
        for skill in state.library.skills.iter().filter(|s| s.fit_for(&agent.tools) == SkillFit::Blocked) {
            if y >= area.bottom() { break }
            let missing = skill.missing_tools(&agent.tools);
            canvas.print(area.x + 3, y, "✗", Style::new().fg(RED));
            canvas.print(area.x + 5, y, &ellipsize_cells(&skill.name, 24), Style::new().fg(WHITE));
            canvas.print(
                area.x + 31, y,
                &ellipsize_cells(&format!("le falta {}", missing.join(" ")), area.w.saturating_sub(34) as usize),
                Style::new().fg(RED),
            );
            y += 1;
        }
    }

    // ── MCP bloqueante ──────────────────────────────────────────────────
    let blocked = agent.blocked_by();
    if !blocked.is_empty() && y < area.bottom() {
        canvas.print(
            area.x + 1, y,
            &format!("✗ bloqueado por MCP: {}", blocked.join(" ")),
            Style::new().fg(RED).bold(),
        );
    }
}

/// Qué está haciendo, con el mismo criterio de prioridad que la tarjeta del
/// enjambre: tool en vuelo > espera > última tool cerrada.
fn live_line(state: &AppState, agent: &RosterAgent) -> (String, crate::term::Color) {
    if let Some(call) = state.swarm.calls_for(&agent.id).into_iter().next() {
        return (format!("{} {}", call.bee_state.glyph(), call.tool), call.bee_state.color());
    }
    if let Some(waiting) = state.swarm.waiting.get(&agent.id) {
        return (format!("⏳ {}", waiting.reason_label()), YELLOW);
    }
    if let Some(last) = state.swarm.last_tool.get(&agent.id) {
        if last.settled {
            let mark = if last.ok == Some(false) { "✗" } else { "✓" };
            return (
                format!("{mark} {} · {}ms", last.tool, last.duration_ms.unwrap_or(0)),
                if last.ok == Some(false) { RED } else { DIM },
            );
        }
    }
    ("inactivo en este turno".to_string(), DIM)
}

fn base_skills(state: &AppState, agent: &RosterAgent) -> usize {
    state
        .library
        .skills
        .iter()
        .filter(|s| s.prefers_role(&agent.rol))
        .count()
}

fn base_skill_names<'a>(state: &'a AppState, agent: &RosterAgent) -> Vec<&'a str> {
    state
        .library
        .skills
        .iter()
        .filter(|s| s.prefers_role(&agent.rol))
        .map(|s| s.name.as_str())
        .take(4)
        .collect()
}

fn field(canvas: &mut Canvas, area: Rect, y: u16, label: &str, value: &str) -> u16 {
    if y >= area.bottom() {
        return y;
    }
    canvas.print(area.x + 1, y, label, Style::new().fg(AMBER_DIM));
    canvas.print(
        area.x + LABEL_X,
        y,
        &ellipsize_cells(value, area.w.saturating_sub(LABEL_X + 2) as usize),
        Style::new().fg(WHITE),
    );
    y + 1
}

/// Una línea de tools o skills, como chips separados por `·`.
fn chips(canvas: &mut Canvas, area: Rect, y: u16, items: &[&str], color: crate::term::Color) -> u16 {
    if items.is_empty() || y >= area.bottom() {
        return y;
    }
    let mut line = items.join(" · ");
    if items.len() > 6 {
        line.push_str(" …");
    }
    canvas.print(area.x + LABEL_X, y, &ellipsize_cells(&line, area.w.saturating_sub(LABEL_X + 2) as usize), Style::new().fg(color));
    y + 1
}

fn rule(canvas: &mut Canvas, area: Rect, y: u16) -> u16 {
    if y >= area.bottom() {
        return y;
    }
    let rule = "─".repeat(area.w.saturating_sub(2) as usize);
    canvas.print(area.x + 1, y, &rule, Style::new().fg(AMBER_SUBTLE));
    y + 1
}

///Primera línea larga en una sola línea: la ficha es un resumen, no un párrafo.
fn wrap_line(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out = String::new();
    for (i, word) in text.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if cell_width(&out) + cell_width(word) > max.saturating_sub(1) {
            out.push('…');
            return out;
        }
        out.push_str(word);
    }
    out
}

/// Overlay de la ficha. Se dibuja sobre el contenido cuando hay un agente
/// seleccionado; `Esc` o el comando la cierra.
pub fn render_overlay(canvas: &mut Canvas, area: Rect, state: &AppState) -> bool {
    let Some(agent) = taller_agent(state) else { return false };
    let w = area.w.saturating_sub(6).min(110).max(40);
    let h = area.h.saturating_sub(4).min(30).max(12);
    let rect = Rect::new(
        area.x + (area.w.saturating_sub(w)) / 2,
        area.y + (area.h.saturating_sub(h)) / 2,
        w,
        h,
    );
    canvas.fill_rect(rect, ' ', Style::new().bg(BG_ELEVATED));
    canvas.draw_border(rect, Style::new().fg(agent.color()).bg(BG_ELEVATED));
    let inner = Rect::new(rect.x + 1, rect.y + 1, rect.w.saturating_sub(2), rect.h.saturating_sub(2));
    canvas.with_clip(inner, |canvas| {
        render(canvas, inner, state, agent);
        if inner.h > 1 {
            let hint = "Esc cerrar · ←/→ otro agente · i skills";
            canvas.print(
                inner.x,
                inner.bottom().saturating_sub(1),
                &ellipsize_cells(hint, inner.w as usize),
                Style::new().fg(DIM).bg(BG_ELEVATED),
            );
        }
    });
    true
}

fn taller_agent(state: &AppState) -> Option<&RosterAgent> {
    state.ficha_agent.as_ref().and_then(|id| state.roster.resolve(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{IpcRosterAgent, IpcRosterMcpRef};
    use crate::state::{Loadout, SkillCard, SkillLibrary, WaitingAgent};
    use crate::term::Canvas;

    fn agent(rol: &str, alias: &str) -> IpcRosterAgent {
        IpcRosterAgent {
            id: format!("id-{rol}"),
            rol: rol.to_string(),
            alias: alias.to_string(),
            funcion: "Construye servicios y endpoints del backend.".to_string(),
            nivel: 2,
            tools: vec!["fs_read".into(), "fs_write".into()],
            mcp: vec![],
        }
    }

    fn base() -> AppState {
        let mut state = AppState::default();
        state.roster.apply(vec![agent("backend", "Topo")]);
        state.library = SkillLibrary {
            skills: vec![
                SkillCard {
                    name: "busqueda_hivedb".into(),
                    description: "busca en la base".into(),
                    category: "core".into(),
                    active: true,
                    tools: vec!["search_knowledge".into()],
                    preferida_por: vec![],
                    siempre_disponible: true,
                },
                SkillCard {
                    name: "browser_automate".into(),
                    description: "21 tools de navegador".into(),
                    category: "web".into(),
                    active: true,
                    tools: vec!["browser_click".into(), "browser_fill".into()],
                    preferida_por: vec!["frontend".into()],
                    siempre_disponible: false,
                },
            ],
        };
        state
    }

    fn draw(state: &AppState) -> String {
        let mut canvas = Canvas::new(110, 34);
        render(&mut canvas, Rect::new(0, 0, 110, 34), state, &state.roster.by_id["id-backend"]);
        canvas.to_text_rows().join("\n")
    }

    #[test]
    fn the_card_says_who_it_is_and_what_it_does() {
        let frame = draw(&base());
        assert!(frame.contains("Topo"), "{frame}");
        assert!(frame.contains("backend"), "{frame}");
        assert!(frame.contains("endpoints"), "la función no aparece: {frame}");
    }

    #[test]
    fn it_separates_the_declared_loadout_from_the_current_one() {
        // La distinction que importa: lo declarado y lo que el agente tiene
        // ahora no son lo mismo cuando JEV poda.
        let mut state = base();
        state.loadout.insert(
            "id-backend".into(),
            Loadout {
                tools: vec!["fs_read".into()],
                skills: vec!["busqueda_hivedb".into()],
                pruned: true,
                minimal: vec!["busqueda_hivedb".into()],
                at: 1,
            },
        );
        let frame = draw(&state);
        assert!(frame.contains("CARGA BASE"), "{frame}");
        assert!(frame.contains("CARGA AHORA"), "{frame}");
        assert!(frame.contains("podada por jev"), "no explica el porqué: {frame}");
    }

    #[test]
    fn without_loadout_data_it_says_so_instead_of_lying() {
        let frame = draw(&base());
        assert!(frame.contains("sin datos de este turno"), "{frame}");
    }

    #[test]
    fn it_answers_can_this_agent_do_the_thing() {
        // La pregunta que motiva la vista: qué puede y qué no.
        let frame = draw(&base());
        assert!(frame.contains("HABILIDADES"), "{frame}");
        assert!(frame.contains("✗"), "{frame}");
        // El motivo del bloqueo: sin él, "bloqueada" no es accionable.
        assert!(frame.contains("le falta"), "{frame}");
        assert!(frame.contains("browser_click"), "no dice qué falta: {frame}");
    }

    #[test]
    fn it_shows_the_last_jev_decision_when_there_is_one() {
        let mut state = base();
        state.jev.record(crate::state::JevDecision {
            agent_id: "id-backend".into(),
            kind: "context".into(),
            summary: "18 → 6 mensajes".into(),
            saved_tokens: 8_200,
            cost_usd: 0.001,
            latency_ms: 61,
            event_id: "e1".into(),
            availability: crate::state::JevAvailability::Ready,
        });
        let frame = draw(&state);
        assert!(frame.contains("ÚLTIMA DECISIÓN"), "{frame}");
        assert!(frame.contains("ahorró"), "{frame}");
    }

    #[test]
    fn it_says_why_an_agent_is_not_moving() {
        let mut state = base();
        state.swarm.set_waiting(WaitingAgent {
            agent: "id-backend".into(),
            waiting_for: vec![],
            reason: "dependencia".into(),
            since: 0,
        });
        let frame = draw(&state);
        assert!(frame.contains("esperando dependencia"), "{frame}");
    }

    #[test]
    fn it_names_the_mcp_that_blocks_the_specialist() {
        let mut state = base();
        let mut a = agent("frontend", "Quetzal");
        a.mcp = vec![IpcRosterMcpRef { name: "obscura".into(), state: "apagado".into() }];
        state.roster.apply(vec![a]);
        state.ficha_agent = Some("id-frontend".into());

        let mut canvas = Canvas::new(110, 34);
        assert!(render_overlay(&mut canvas, Rect::new(0, 0, 110, 34), &state));
        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("obscura"), "{frame}");
    }

    #[test]
    fn the_overlay_does_nothing_without_a_selected_agent() {
        let mut canvas = Canvas::new(110, 34);
        assert!(!render_overlay(&mut canvas, Rect::new(0, 0, 110, 34), &AppState::default()));
    }

    #[test]
    fn a_long_function_wraps_to_one_line_with_an_ellipsis() {
        let out = wrap_line("una palabra dos tres cuatro cinco seis siete ocho", 20);
        assert!(out.ends_with('…'));
        assert!(cell_width(&out) <= 20);
        // Una función corta no se toca.
        assert_eq!(wrap_line("corta", 20), "corta");
    }

    #[test]
    fn it_renders_in_a_small_area_without_panicking() {
        let state = base();
        for (w, h) in [(1u16, 1u16), (20, 5), (40, 10), (200, 60)] {
            let mut canvas = Canvas::new(w.max(1), h.max(1));
            render(&mut canvas, Rect::new(0, 0, w.max(1), h.max(1)), &state, &state.roster.by_id["id-backend"]);
        }
    }
}