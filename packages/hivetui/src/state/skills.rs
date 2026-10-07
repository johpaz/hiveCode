//! Habilidades y qué puede hacer cada agente con ellas.
//!
//! La pregunta que responde esta vista es "¿quién puede usar qué?", y tiene tres
//! respuestas distintas que no se pueden confundir:
//!
//! - **siempre disponible**: todas las tools de la skill están en la carga
//!   mínima. No depende de descubrir nada. Lo calcula el backend con
//!   `isMinimalSkill()` — la misma función que usa el runtime — y viaja como
//!   `siempre_disponible`. Si esta vista tuviera su propia regla, podría
//!   discrepar y prometer una skill que el agente nunca va a tener.
//!
//! - **por descubrir**: depende de `search_knowledge`. El agente puede
//!   encontrarla; no es un problema, es el flujo normal.
//!
//! - **bloqueada**: al agente le falta alguna de las tools que la skill
//!   documenta. Ofrecerla sería una promesa falsa.
//!
//! Una cuarta señal es el resultado de la descomposición: los criterios del PRD
//! son binarios por diseño, y "no reproducible" **no** es "cumple".

/// Una habilidad del catálogo.
#[derive(Debug, Clone, Default)]
pub struct SkillCard {
    pub name: String,
    pub description: String,
    pub category: String,
    pub active: bool,
    /// Tools que documenta.
    pub tools: Vec<String>,
    /// Roles que la recomiendan.
    pub preferida_por: Vec<String>,
    /// Todas sus tools están en la carga mínima (lo dice el backend).
    pub siempre_disponible: bool,
}

/// Si un agente puede aprovechar una skill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillFit {
    /// Lista en cualquier turno, sin descubrir nada.
    Always,
    /// El agente puede obtenerla buscando; es el flujo normal.
    Discoverable,
    /// Le falta alguna tool. Ofrecerla sería mentir.
    Blocked,
}

impl SkillFit {
    pub fn label(self) -> &'static str {
        match self {
            SkillFit::Always => "siempre",
            SkillFit::Discoverable => "por descubrir",
            SkillFit::Blocked => "bloqueada",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            SkillFit::Always => "●",
            SkillFit::Discoverable => "○",
            SkillFit::Blocked => "✗",
        }
    }
}

impl SkillCard {
    /// ¿Puede este agente usar la skill?
    ///
    /// Una skill sin `tools` declaradas no se puede bloquear: no hay nada que
    /// comprobar, así que se trata como siempre disponible en vez de inventar un
    /// requisito.
    pub fn fit_for(&self, agent_tools: &[String]) -> SkillFit {
        if self.siempre_disponible {
            return SkillFit::Always;
        }
        if self.tools.is_empty() {
            return SkillFit::Always;
        }
        if agent_tools.iter().any(|t| self.tools.contains(t)) {
            // Tiene alguna: puede descubrir el resto.
            SkillFit::Discoverable
        } else {
            SkillFit::Blocked
        }
    }

    /// Las tools que le faltan al agente.
    pub fn missing_tools(&self, agent_tools: &[String]) -> Vec<&str> {
        self.tools
            .iter()
            .filter(|t| !agent_tools.iter().any(|a| a == *t))
            .map(|t| t.as_str())
            .collect()
    }

    /// ¿La recomienda este rol?
    pub fn prefers_role(&self, role: &str) -> bool {
        self.preferida_por.iter().any(|r| r.eq_ignore_ascii_case(role))
    }
}

/// Catálogo de habilidades, agrupable por categoría.
#[derive(Debug, Clone, Default)]
pub struct SkillLibrary {
    pub skills: Vec<SkillCard>,
}

impl SkillLibrary {
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&SkillCard> {
        self.skills.iter().find(|s| s.name == name)
    }

    pub fn categories(&self) -> Vec<String> {
        let mut cats: Vec<String> = self
            .skills
            .iter()
            .map(|s| s.category.clone())
            .filter(|c| !c.is_empty())
            .collect();
        cats.sort();
        cats.dedup();
        cats
    }

    pub fn by_category(&self, category: &str) -> Vec<&SkillCard> {
        self.skills
            .iter()
            .filter(|s| s.category == category)
            .collect()
    }

    /// Cuántas puede usar un agente con esta lista de tools.
    pub fn count_for(&self, agent_tools: &[String], fit: SkillFit) -> usize {
        self.skills
            .iter()
            .filter(|s| s.fit_for(agent_tools) == fit)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(name: &str, tools: &[&str], minimal: bool) -> SkillCard {
        SkillCard {
            name: name.to_string(),
            description: "d".to_string(),
            category: "code".to_string(),
            active: true,
            tools: tools.iter().map(|s| s.to_string()).collect(),
            preferida_por: vec![],
            siempre_disponible: minimal,
        }
    }

    fn tools(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_minimal_skill_is_always_available_for_everyone() {
        let s = card("busqueda_hivedb", &["search_knowledge"], true);
        // Aunque el agente no tenga la tool, el backend lo dice: es el contrato.
        assert_eq!(s.fit_for(&[]), SkillFit::Always);
        assert_eq!(s.fit_for(&tools(&["otra"])), SkillFit::Always);
    }

    #[test]
    fn a_skill_with_no_declared_tools_cannot_be_blocked() {
        // Sin tools no hay nada que comprobar. Marcar como bloqueada sería
        // inventar un requisito que nadie escribió.
        let s = card("meeting_transcription", &[], false);
        assert_eq!(s.fit_for(&[]), SkillFit::Always);
        assert!(s.missing_tools(&[]).is_empty());
    }

    #[test]
    fn an_agent_with_none_of_the_tools_sees_it_blocked() {
        // El caso que motiva la vista: ofrecer una skill cuyas tools el agente
        // no tiene es peor que no ofrecerla.
        let s = card("browser_automate", &["browser_click", "browser_fill"], false);
        assert_eq!(s.fit_for(&tools(&["fs_read"])), SkillFit::Blocked);
        assert_eq!(s.missing_tools(&tools(&["fs_read"])), vec!["browser_click", "browser_fill"]);
    }

    #[test]
    fn an_agent_with_some_of_the_tools_can_discover_the_rest() {
        let s = card("browser_automate", &["browser_click", "browser_fill"], false);
        assert_eq!(s.fit_for(&tools(&["fs_read", "browser_click"])), SkillFit::Discoverable);
        // Solo falta una.
        assert_eq!(s.missing_tools(&tools(&["browser_click"])), vec!["browser_fill"]);
    }

    #[test]
    fn a_skill_can_prefer_a_role_without_requiring_it() {
        let mut s = card("git_workflow", &["git_commit"], false);
        s.preferida_por = vec!["devops".to_string()];
        assert!(s.prefers_role("devops"));
        assert!(s.prefers_role("DevOps"), "el matching ignora mayúsculas");
        assert!(!s.prefers_role("backend"));
        // Preferir no es exigir: el ajuste de fit no cambia.
        assert_eq!(s.fit_for(&tools(&["fs_read"])), SkillFit::Blocked);
    }

    #[test]
    fn categories_are_deduplicated_and_sorted() {
        let lib = SkillLibrary {
            skills: vec![
                card("a", &[], false),
                { let mut c = card("b", &[], false); c.category = "web".into(); c },
                { let mut c = card("d", &[], false); c.category = "code".into(); c },
            ],
        };
        assert_eq!(lib.categories(), vec!["code".to_string(), "web".to_string()]);
        assert_eq!(lib.by_category("code").len(), 2);
        assert!(lib.by_category("nada").is_empty());
    }

    #[test]
    fn the_counts_split_the_catalog_in_three() {
        let lib = SkillLibrary {
            skills: vec![
                card("siempre", &["x"], true),
                card("descubrible", &["y"], false),
                card("bloqueada", &["z"], false),
            ],
        };
        let agente = tools(&["y"]);
        assert_eq!(lib.count_for(&agente, SkillFit::Always), 1);
        assert_eq!(lib.count_for(&agente, SkillFit::Discoverable), 1);
        assert_eq!(lib.count_for(&agente, SkillFit::Blocked), 1);
    }

    #[test]
    fn an_empty_catalog_does_not_panic() {
        let lib = SkillLibrary::default();
        assert!(lib.is_empty());
        assert!(lib.categories().is_empty());
        assert!(lib.get("nada").is_none());
        assert_eq!(lib.count_for(&[], SkillFit::Always), 0);
    }
}