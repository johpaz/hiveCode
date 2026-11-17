//! The project's architecture decision records (port of `packages/code/src/adr/*`).
//!
//! ADRs are the Markdown files in the project's `adrs/` folder. Each one has a title (its first `#`
//! heading) and a status (`**Status**: accepted|proposed|deprecated|superseded`, `accepted` when it
//! says nothing). Given a file, the analyzer finds the ADRs that talk about it, and the risk of
//! changing that file follows from them: a file an accepted ADR is named after is `critical`.
use regex::Regex;
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Accepted,
    Proposed,
    Deprecated,
    Superseded,
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Accepted => "accepted",
            Status::Proposed => "proposed",
            Status::Deprecated => "deprecated",
            Status::Superseded => "superseded",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adr {
    pub file: PathBuf,
    pub title: String,
    pub status: Status,
    pub content: String,
}

static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#\s+(.+)").unwrap());
static STATUS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)\*\*?[Ss]tatus\*\*?:?\s*(\w+)").unwrap());

pub fn parse(file: &Path, content: &str) -> Adr {
    let title = TITLE
        .captures(content)
        .map_or("Sin titulo".to_owned(), |c| c[1].trim().to_owned());
    let status = match STATUS
        .captures(content)
        .map(|c| c[1].to_lowercase())
        .as_deref()
    {
        Some("proposed") => Status::Proposed,
        Some("deprecated") => Status::Deprecated,
        Some("superseded") => Status::Superseded,
        _ => Status::Accepted,
    };
    Adr {
        file: file.to_owned(),
        title,
        status,
        content: content.to_owned(),
    }
}

/// Every `adrs/*.md` of the project, in file-name order. A project without that folder has none.
pub fn load(project: &Path) -> Vec<Adr> {
    let Ok(entries) = std::fs::read_dir(project.join("adrs")) else {
        return vec![];
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")))
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|f| Some(parse(f, &std::fs::read_to_string(f).ok()?)))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relevance {
    High,
    Medium,
    Low,
}

#[derive(Clone, Debug)]
pub struct Match {
    pub adr: Adr,
    pub relevance: Relevance,
    pub reason: String,
}

/// ADRs whose title or text contains `query`, up to `limit`.
pub fn search<'a>(adrs: &'a [Adr], query: &str, limit: usize) -> Vec<&'a Adr> {
    let needle = query.to_lowercase();
    adrs.iter()
        .filter(|a| {
            a.title.to_lowercase().contains(&needle) || a.content.to_lowercase().contains(&needle)
        })
        .take(limit)
        .collect()
}

/// The ADRs that talk about a file: one that names a folder or the extension of its path (medium), one
/// that mentions its name (low), and one that is *titled* after its name while accepted (high).
pub fn analyze(adrs: &[Adr], file: &str) -> Vec<Match> {
    let mut matches: Vec<Match> = vec![];
    let mut seen = std::collections::HashSet::new();
    let path = Path::new(file);
    let basename = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let segments: Vec<&str> = file.split(['/', '\\']).filter(|s| !s.is_empty()).collect();

    for adr in adrs {
        let lower = adr.content.to_lowercase();
        let by_segment = segments
            .iter()
            .find(|s| s.len() > 2 && lower.contains(&s.to_lowercase()));
        let by_ext = !ext.is_empty() && lower.contains(&format!(".{}", ext.to_lowercase()));
        if by_segment.is_some() || by_ext {
            let reason = by_segment.map_or(ext.as_str(), |s| s);
            matches.push(Match {
                adr: adr.clone(),
                relevance: Relevance::Medium,
                reason: format!("ruta coincide: \"{reason}\""),
            });
            seen.insert(adr.file.clone());
        }
    }
    if basename.len() > 2 {
        for adr in search(adrs, &basename, 5) {
            if seen.insert(adr.file.clone()) {
                matches.push(Match {
                    adr: adr.clone(),
                    relevance: Relevance::Low,
                    reason: format!("texto coincide: \"{basename}\""),
                });
            }
        }
    }
    for m in &mut matches {
        if m.adr.status == Status::Accepted
            && m.adr
                .title
                .to_lowercase()
                .contains(&basename.to_lowercase())
        {
            m.relevance = Relevance::High;
            m.reason = format!("titulo ADR menciona \"{basename}\"");
        }
    }
    matches
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Risk {
    Low,
    Medium,
    High,
    Critical,
}
impl Risk {
    pub fn as_str(self) -> &'static str {
        match self {
            Risk::Low => "low",
            Risk::Medium => "medium",
            Risk::High => "high",
            Risk::Critical => "critical",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Assessment {
    pub file: String,
    pub risk: Risk,
    pub reason: String,
    /// The ADR that decided it, if any.
    pub adr: Option<PathBuf>,
}

static SCHEMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)schema|migration|migrate").unwrap());

/// How risky changing `file` is, given the project's ADRs. A schema or migration file is at least
/// `high` with no ADR at all; an accepted ADR named after the file makes it `critical`.
pub fn assess(adrs: &[Adr], file: &str) -> Assessment {
    let matches = analyze(adrs, file);
    let schema = SCHEMA.is_match(file) || file.ends_with(".sql");
    let accepted = |relevance: Relevance| {
        matches
            .iter()
            .any(|m| m.relevance == relevance && m.adr.status == Status::Accepted)
    };
    let risk = if matches.is_empty() {
        if schema { Risk::High } else { Risk::Low }
    } else if accepted(Relevance::High) {
        Risk::Critical
    } else if accepted(Relevance::Medium) {
        if schema { Risk::Critical } else { Risk::High }
    } else if schema {
        Risk::High
    } else {
        Risk::Medium
    };
    let reason = match matches.first() {
        None if risk == Risk::High => "Archivo de schema: siempre alto riesgo".to_owned(),
        None => "Sin ADRs relevantes".to_owned(),
        Some(top) => format!(
            "{}: ADR \"{}\" ({})",
            top.reason,
            top.adr.title,
            top.adr.status.as_str()
        ),
    };
    Assessment {
        file: file.to_owned(),
        risk,
        reason,
        adr: matches.first().map(|m| m.adr.file.clone()),
    }
}

/// The files a unified diff touches (`diff --git a/x b/x`), without duplicates.
pub fn files_in_diff(diff: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git a/")
            && let Some((_, new)) = rest.split_once(" b/")
            && !out.iter().any(|f| f == new)
        {
            out.push(new.to_owned());
        }
    }
    out
}
