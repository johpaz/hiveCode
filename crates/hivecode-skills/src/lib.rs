//! Skills: `SKILL.md` files (YAML frontmatter + instructions) that tell the agent how to do a kind of
//! task. Three sources, later ones replacing earlier ones by name: the skills shipped inside the
//! binary, the person's (`<home>/skills`) and the project's (`<project>/.hivecode/skills`).
//! A skill is only text added to the prompt; loading one never runs anything.
use serde_json::Value;
use std::{fs, path::Path};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/bundled.rs"));
}

const MAX_BYTES: usize = 262_144;
/// Most skills added to one task, and the most text of them: a prompt full of skills helps no one.
pub const MAX_SELECTED: usize = 2;
pub const MAX_RENDERED_CHARS: usize = 6000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Bundled,
    User,
    Project,
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub category: String,
    pub triggers: Vec<String>,
    pub tools: Vec<String>,
    pub rules: Vec<String>,
    pub steps: Vec<(String, String)>,
    pub body: String,
    pub source: Source,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Parses one `SKILL.md`. An error says what is wrong with the file.
pub fn parse(content: &str, source: Source) -> Result<Skill, String> {
    if content.len() > MAX_BYTES {
        return Err("la skill pasa de 256 KiB".into());
    }
    let text = content.replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .ok_or("falta el encabezado YAML (---)")?;
    let (front, body) = rest
        .split_once("\n---\n")
        .ok_or("el encabezado YAML no está cerrado (---)")?;
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(front).map_err(|e| format!("YAML inválido: {e}"))?;
    let data = serde_json::to_value(yaml).map_err(|e| e.to_string())?;
    let name = data["name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .ok_or("falta `name`")?;
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(format!("`name` no es un identificador: {name}"));
    }
    let steps = data["steps"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some((
                        s["action"].as_str()?.to_owned(),
                        s["instruction"].as_str().unwrap_or("").to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Skill {
        name: name.to_owned(),
        description: data["description"]
            .as_str()
            .ok_or("falta `description`")?
            .to_owned(),
        category: data["category"].as_str().unwrap_or("").to_owned(),
        triggers: strings(&data["triggers"]),
        tools: strings(&data["tools"]),
        rules: strings(&data["rules"]),
        steps,
        body: body.trim().to_owned(),
        source,
    })
}

/// The skills that ship with hivecode.
pub fn bundled() -> Vec<Skill> {
    embedded::EMBEDDED
        .iter()
        .filter_map(|c| parse(c, Source::Bundled).ok())
        .collect()
}

/// Every `SKILL.md` under `dir` (a folder per skill, any depth). A broken file is reported, not
/// silently dropped, and does not stop the others.
pub fn load_dir(dir: &Path, source: Source) -> (Vec<Skill>, Vec<String>) {
    let (mut skills, mut problems) = (Vec::new(), Vec::new());
    let Ok(entries) = fs::read_dir(dir) else {
        return (skills, problems);
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            let (inner, bad) = load_dir(&path, source);
            skills.extend(inner);
            problems.extend(bad);
        } else if path.file_name().is_some_and(|n| n == "SKILL.md") {
            match fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|c| parse(&c, source))
            {
                Ok(skill) => skills.push(skill),
                Err(why) => problems.push(format!("{}: {why}", path.display())),
            }
        }
    }
    (skills, problems)
}

/// Bundled, then the person's, then the project's; a later skill with the same name replaces the
/// earlier one. Returns the skills sorted by name and the files that could not be loaded.
pub fn catalog(home: &Path, project: &Path) -> (Vec<Skill>, Vec<String>) {
    let mut all = bundled();
    let mut problems = Vec::new();
    for (dir, source) in [
        (home.join("skills"), Source::User),
        (project.join(".hivecode").join("skills"), Source::Project),
    ] {
        let (skills, bad) = load_dir(&dir, source);
        problems.extend(bad);
        for skill in skills {
            all.retain(|s| s.name != skill.name);
            all.push(skill);
        }
    }
    all.sort_by(|a, b| a.name.cmp(&b.name));
    (all, problems)
}

fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    let mut from = 0;
    while let Some(at) = haystack[from..].find(phrase) {
        let start = from + at;
        let end = start + phrase.len();
        let before = haystack[..start].chars().next_back();
        let after = haystack[end..].chars().next();
        if !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric) {
            return true;
        }
        from = start + phrase.chars().next().map_or(1, char::len_utf8);
        if from >= haystack.len() {
            break;
        }
    }
    false
}

/// How well `task` fits a skill: the summed length of the triggers found in it as whole words/phrases
/// (a longer phrase says more than a short word). 0 means it does not apply.
pub fn score(skill: &Skill, task: &str) -> usize {
    let task = task.to_lowercase();
    skill
        .triggers
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| t.chars().count() >= 3 && contains_phrase(&task, t))
        .map(|t| t.chars().count())
        .sum()
}

/// The skills that apply to `task`, best first, at most `MAX_SELECTED`.
pub fn select<'a>(skills: &'a [Skill], task: &str) -> Vec<&'a Skill> {
    let mut scored: Vec<(usize, &Skill)> = skills
        .iter()
        .map(|s| (score(s, task), s))
        .filter(|(n, _)| *n > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored
        .into_iter()
        .take(MAX_SELECTED)
        .map(|(_, s)| s)
        .collect()
}

/// The text of a skill as added to the prompt.
pub fn render(skill: &Skill) -> String {
    let mut out = format!("### Skill: {} — {}\n", skill.name, skill.description);
    if !skill.steps.is_empty() {
        out.push_str("Pasos:\n");
        for (i, (action, instruction)) in skill.steps.iter().enumerate() {
            out.push_str(&format!("{}. {action}: {instruction}\n", i + 1));
        }
    }
    if !skill.rules.is_empty() {
        out.push_str("Reglas:\n");
        for rule in &skill.rules {
            out.push_str(&format!("- {rule}\n"));
        }
    }
    if !skill.body.is_empty() {
        out.push('\n');
        out.push_str(&skill.body);
        out.push('\n');
    }
    out
}

/// The section to append to the system prompt for the skills selected for `task` (empty if none apply).
pub fn prompt_section(skills: &[Skill], task: &str) -> String {
    let chosen = select(skills, task);
    if chosen.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n\n## Skills aplicables a esta tarea (guías; las herramientas que nombran pueden no existir aquí: usa las que tengas)\n",
    );
    for skill in chosen {
        let text = render(skill);
        if out.chars().count() + text.chars().count() > MAX_RENDERED_CHARS {
            out.extend(
                text.chars()
                    .take(MAX_RENDERED_CHARS.saturating_sub(out.chars().count())),
            );
            out.push_str("\n[…recortada]\n");
            break;
        }
        out.push_str(&text);
    }
    out
}
