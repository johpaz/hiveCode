use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, SECONDARY},
};

pub struct Command {
    pub cmd: &'static str,
    pub desc: &'static str,
}

pub const COMMANDS: &[Command] = &[
    // ── Locales TUI ───────────────────────────────────────────────────────────
    Command { cmd: "/help",                 desc: "Mostrar ayuda" },
    Command { cmd: "/quit",                 desc: "Salir de hivetui" },
    Command { cmd: "/exit",                 desc: "Salir de hivetui (alias)" },
    Command { cmd: "/clear",                desc: "Limpiar historial de conversación" },
    Command { cmd: "/logs",                 desc: "Mostrar/ocultar panel de logs" },
    Command { cmd: "/timeline",             desc: "Mostrar/ocultar panel de workers" },
    Command { cmd: "/copy",                 desc: "Activar modo navegación/copia" },
    Command { cmd: "/layout focus",         desc: "Cambiar a vista FOCUS (chat)" },
    Command { cmd: "/layout plan",          desc: "Cambiar a vista PLAN (razonamiento)" },
    Command { cmd: "/layout code",          desc: "Cambiar a vista CODE (cambios)" },
    Command { cmd: "/layout review",        desc: "Cambiar a vista REVIEW (aprobación)" },
    Command { cmd: "/layout dashboard",     desc: "Cambiar a vista DASHBOARD (workers)" },
    Command { cmd: "/welcome",              desc: "Volver a la pantalla de bienvenida" },
    // ── Modo de ejecución ─────────────────────────────────────────────────────
    Command { cmd: "/mode",                 desc: "Ciclar modo (plan→aprobación→auto)" },
    Command { cmd: "/mode get",             desc: "Mostrar modo actual" },
    Command { cmd: "/mode set",             desc: "Fijar modo: plan | aprobación | auto" },
    Command { cmd: "/mode history",         desc: "Historial de cambios de modo" },
    // ── Provider ──────────────────────────────────────────────────────────────
    Command { cmd: "/provider list",        desc: "Listar providers configurados" },
    Command { cmd: "/provider add",         desc: "Añadir nuevo provider de IA" },
    Command { cmd: "/provider set",         desc: "Cambiar provider activo" },
    Command { cmd: "/provider test",        desc: "Probar conexión al provider" },
    Command { cmd: "/provider status",      desc: "Estado de todos los providers" },
    // ── Modelo ────────────────────────────────────────────────────────────────
    Command { cmd: "/modelo list",          desc: "Listar modelos disponibles" },
    Command { cmd: "/modelo set",           desc: "Cambiar modelo activo" },
    Command { cmd: "/modelo add",           desc: "Añadir modelo a la base de datos" },
    Command { cmd: "/modelo delete",        desc: "Eliminar modelo" },
    Command { cmd: "/modelo info",          desc: "Detalles del modelo activo" },
    // ── MCP ───────────────────────────────────────────────────────────────────
    Command { cmd: "/mcp list",             desc: "Listar servidores MCP" },
    Command { cmd: "/mcp add",              desc: "Registrar nuevo servidor MCP" },
    Command { cmd: "/mcp enable",           desc: "Habilitar servidor MCP" },
    Command { cmd: "/mcp disable",          desc: "Deshabilitar servidor MCP" },
    Command { cmd: "/mcp test",             desc: "Verificar conexión MCP" },
    // ── Skills ────────────────────────────────────────────────────────────────
    Command { cmd: "/skill list",           desc: "Listar skills disponibles" },
    Command { cmd: "/skill enable",         desc: "Activar skill" },
    Command { cmd: "/skill disable",        desc: "Desactivar skill" },
    Command { cmd: "/skill info",           desc: "Ver contenido y metadata de skill" },
    Command { cmd: "/skill add",            desc: "Importar skill desde archivo .md" },
    // ── GitHub ────────────────────────────────────────────────────────────────
    Command { cmd: "/github connect",       desc: "Conectar GitHub con token PAT" },
    Command { cmd: "/github status",        desc: "Estado de conexión GitHub" },
    Command { cmd: "/github whoami",        desc: "Usuario GitHub autenticado" },
    Command { cmd: "/github disconnect",    desc: "Desconectar GitHub" },
    Command { cmd: "/github set-repo",      desc: "Vincular repositorio owner/repo" },
    // ── Telegram ──────────────────────────────────────────────────────────────
    Command { cmd: "/telegram status",      desc: "Estado del bot de Telegram" },
    Command { cmd: "/telegram connect",     desc: "Conectar bot de Telegram" },
    Command { cmd: "/telegram edit",        desc: "Editar configuración de Telegram" },
    Command { cmd: "/telegram disconnect",  desc: "Desconectar Telegram" },
    // ── Tareas ────────────────────────────────────────────────────────────────
    Command { cmd: "/task list",            desc: "Listar tareas recientes" },
    Command { cmd: "/task status",          desc: "Estado detallado de una tarea" },
    Command { cmd: "/task cancel",          desc: "Cancelar tarea en ejecución" },
    Command { cmd: "/task rollback",        desc: "Revertir cambios de una tarea" },
    Command { cmd: "/run",                  desc: "Ejecutar tarea en modo actual" },
    Command { cmd: "/plan",                 desc: "Planificar tarea sin ejecutar" },
    Command { cmd: "/stop",                 desc: "Detener tarea en curso" },
    // ── Narrativa ─────────────────────────────────────────────────────────────
    Command { cmd: "/narrative show",       desc: "Mostrar últimas entradas de narrativa" },
    Command { cmd: "/narrative search",     desc: "Buscar en el historial de narrativa" },
    Command { cmd: "/narrative export",     desc: "Exportar narrativa completa" },
    // ── ACE / Aprendizaje ─────────────────────────────────────────────────────
    Command { cmd: "/ace status",           desc: "Estado del sistema de aprendizaje" },
    Command { cmd: "/ace playbook list",    desc: "Reglas aprendidas con confianza" },
    Command { cmd: "/ace playbook reset",   desc: "Limpiar reglas del playbook" },
    Command { cmd: "/ace reflector run",    desc: "Forzar análisis de trazas" },
    // ── Notas ─────────────────────────────────────────────────────────────────
    Command { cmd: "/note add",             desc: "Guardar nota de scratchpad" },
    Command { cmd: "/note list",            desc: "Listar notas guardadas" },
    Command { cmd: "/note delete",          desc: "Eliminar nota" },
    // ── Logs (remoto) ─────────────────────────────────────────────────────────
    Command { cmd: "/logs list",            desc: "Consultar logs con filtros" },
    Command { cmd: "/logs follow",          desc: "Seguir logs en tiempo real" },
    // ── Sistema ───────────────────────────────────────────────────────────────
    Command { cmd: "/doctor",               desc: "Diagnóstico del sistema" },
    Command { cmd: "/version",              desc: "Versión de hivecode" },
    Command { cmd: "/env",                  desc: "Variables de entorno seguras" },
    Command { cmd: "/session new",          desc: "Nueva sesión" },
    Command { cmd: "/compact",              desc: "Compactar contexto" },
    Command { cmd: "/status",               desc: "Estado de la sesión actual" },
];

/// Devuelve los comandos que coinciden con el prefijo actual del input.
pub fn filtered(input: &str) -> Vec<&'static Command> {
    let prefix = input.trim();
    COMMANDS
        .iter()
        .filter(|c| c.cmd.starts_with(prefix))
        .collect()
}

/// Renderiza el popup flotante sobre el área de input.
/// `popup_area` se calcula en el renderer como la zona justo encima del input.
pub fn render(canvas: &mut Canvas, popup_area: Rect, state: &AppState) {
    let input = state.input.value();
    if !input.starts_with('/') {
        return;
    }

    let items = filtered(input);
    if items.is_empty() {
        return;
    }

    // Calcular altura necesaria: borde + items
    let needed_h = (items.len() as u16 + 2).min(popup_area.h);
    let y_start = popup_area.bottom().saturating_sub(needed_h);

    let area = Rect {
        x: popup_area.x,
        y: y_start,
        w: popup_area.w,
        h: needed_h,
    };

    // Fondo del popup
    canvas.fill_rect(area, ' ', Style::new().fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print(area.x + 2, area.y, " comandos ", Style::new().fg(CYAN).bold());

    for (i, cmd) in items.iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom() {
            break;
        }
        let selected = state.command_popup_selected == i;
        let row_style = if selected {
            Style::new().fg(AMBER).bold()
        } else {
            Style::new().fg(SECONDARY)
        };
        let prefix = if selected { "▸ " } else { "  " };
        canvas.print(area.x + 1, y, prefix, row_style);
        canvas.print(area.x + 3, y, cmd.cmd, if selected { Style::new().fg(AMBER).bold() } else { Style::new().fg(GREEN) });

        let desc_x = area.x + 3 + cmd.cmd.len() as u16 + 2;
        if desc_x < area.right().saturating_sub(1) {
            canvas.print(desc_x, y, cmd.desc, Style::new().fg(DIM));
        }
    }
}
