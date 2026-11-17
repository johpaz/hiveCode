//! The symbols of one source file, with the lines each one spans.
//!
//! Declarations are read from the top level only (column 0) plus the methods of a class, so a
//! `const` inside a function body never shows up. A range ends where the next sibling begins (blank
//! and comment lines trimmed): exact for the usual one-declaration-after-another layout,
//! approximate when declarations are nested oddly. Port of `agent/source-symbols.ts`.
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
    pub exported: bool,
    /// The declaration line, trimmed: enough to tell what it takes and returns.
    pub signature: String,
}

static TOP_LEVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+(\w+)").unwrap()
});
static METHOD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ {2}(?:(?:public|private|protected|static|readonly|override|async|abstract)\s+)*(?:get\s+|set\s+)?(\w+)\s*[(<]").unwrap()
});
static RUST_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\s*)(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+(\w+)")
        .unwrap()
});
static SKIPPABLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:$|//|/\*|\*)").unwrap());
const NOT_A_METHOD: &[&str] = &[
    "if",
    "for",
    "while",
    "switch",
    "return",
    "catch",
    "function",
    "constructor",
    "super",
    "await",
    "new",
    "typeof",
];

fn clip(line: &str) -> String {
    let trimmed = line.trim();
    let trimmed = trimmed.strip_suffix('{').map_or(trimmed, str::trim_end);
    trimmed.chars().take(140).collect()
}

/// Last line (1-based) of a symbol starting at `start` that must stop before `limit` (exclusive,
/// 1-based): trailing blank and comment lines are dropped.
fn trim_end(lines: &[&str], start: usize, limit: usize) -> usize {
    let mut end = limit - 1;
    while end > start && SKIPPABLE.is_match(lines[end - 1]) {
        end -= 1;
    }
    end.max(start)
}

pub fn extract(source: &str, ext: &str) -> Vec<Symbol> {
    let lines: Vec<&str> = source.split('\n').collect();
    if ext == "rs" {
        rust(&lines)
    } else {
        js(&lines)
    }
}

fn js(lines: &[&str]) -> Vec<Symbol> {
    let mut tops: Vec<Symbol> = vec![];
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = TOP_LEVEL.captures(line) {
            tops.push(Symbol {
                name: m[3].to_owned(),
                kind: m[2].replace('*', ""),
                start_line: i + 1,
                end_line: i + 1,
                exported: m.get(1).is_some(),
                signature: clip(line),
            });
        }
    }
    let starts: Vec<usize> = tops.iter().map(|t| t.start_line).collect();
    let mut result = vec![];
    for (n, mut top) in tops.into_iter().enumerate() {
        top.end_line = trim_end(
            lines,
            top.start_line,
            starts.get(n + 1).copied().unwrap_or(lines.len() + 1),
        );
        let is_class = top.kind == "class";
        let (class_name, class_end, exported, from) = (
            top.name.clone(),
            top.end_line,
            top.exported,
            top.start_line + 1,
        );
        result.push(top);
        if !is_class {
            continue;
        }
        let mut members: Vec<Symbol> = vec![];
        for line in from..=class_end {
            if let Some(m) = METHOD.captures(lines[line - 1])
                && !NOT_A_METHOD.contains(&&m[1])
            {
                members.push(Symbol {
                    name: format!("{class_name}.{}", &m[1]),
                    kind: "method".into(),
                    start_line: line,
                    end_line: line,
                    exported,
                    signature: clip(lines[line - 1]),
                });
            }
        }
        let starts: Vec<usize> = members.iter().map(|m| m.start_line).collect();
        for (k, member) in members.iter_mut().enumerate() {
            member.end_line = trim_end(
                lines,
                member.start_line,
                starts.get(k + 1).copied().unwrap_or(class_end),
            );
        }
        result.extend(members);
    }
    result
}

fn rust(lines: &[&str]) -> Vec<Symbol> {
    let mut items: Vec<Symbol> = vec![];
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = RUST_ITEM.captures(line)
            && m[1].is_empty()
        {
            items.push(Symbol {
                name: m[4].to_owned(),
                kind: m[3].to_owned(),
                start_line: i + 1,
                end_line: i + 1,
                exported: m.get(2).is_some(),
                signature: clip(line),
            });
        }
    }
    let starts: Vec<usize> = items.iter().map(|t| t.start_line).collect();
    for (n, item) in items.iter_mut().enumerate() {
        item.end_line = trim_end(
            lines,
            item.start_line,
            starts.get(n + 1).copied().unwrap_or(lines.len() + 1),
        );
    }
    items
}
