//! Original Hive fauna sprites. Two square pixels per terminal cell, with
//! transparent pixels composited over the office floor using half blocks.
use crate::term::{Canvas, Color, Rect, Style, AMBER, CYAN, GREEN, PURPLE, WHITE};

pub const WIDTH: u16 = 11;
pub const HEIGHT: u16 = 3;

pub struct Character {
    pub name: &'static str,
    pixels: [&'static str; 6],
    body: Color,
    accent: Color,
}

pub(super) fn profile_key(role: &str) -> String {
    let role = role.trim().to_lowercase().replace([' ', '-'], "_");
    match role.as_str() {
        "quality_gate" => "verifier".into(),
        _ => role,
    }
}

pub fn character(role: &str) -> Character {
    // Init receives profile names (BEE, Quality Gate), while telemetry uses IDs.
    // Normalize presentation only: routing and selection keep the original ID.
    let role = profile_key(role);
    let gold = Color::Rgb {
        r: 235,
        g: 174,
        b: 53,
    };
    let brown = Color::Rgb {
        r: 158,
        g: 107,
        b: 68,
    };
    let gray = Color::Rgb {
        r: 157,
        g: 166,
        b: 175,
    };
    match role.as_str() {
        "bee" | "abeja_reina" => Character {
            name: "Abeja Reina",
            body: gold,
            accent: CYAN,
            pixels: [
                "....C.C....",
                ".WW.AAA.WW.",
                "WWW.AEA.WWW",
                ".WW.ADADWW.",
                "....ADA....",
                "....L.L....",
            ],
        },
        "architecture" | "architect" | "planner" | "cóndor" => Character {
            name: "Cóndor",
            body: gray,
            accent: WHITE,
            pixels: [
                "....AAA....",
                "....EEN....",
                "WWWWAWAWWWW",
                ".WWWAAAWWW.",
                "...WAAAW...",
                "....L.L....",
            ],
        },
        "backend" => Character {
            name: "Topo",
            body: brown,
            accent: gold,
            pixels: [
                "....AA.....",
                "...AAAA....",
                "..AEAAN....",
                "..AAAAAN...",
                ".LAAAAAL...",
                "...L.L.....",
            ],
        },
        "frontend" => Character {
            name: "Quetzal",
            body: GREEN,
            accent: Color::Rgb {
                r: 240,
                g: 82,
                b: 103,
            },
            pixels: [
                "....C......",
                "...AAEN....",
                "..AAAWW....",
                "...AWAW....",
                "...L.LA....",
                "......AA...",
            ],
        },
        "data_scientist" => Character {
            name: "Tecolote",
            body: brown,
            accent: gold,
            pixels: [
                "..A.....A..",
                "..AAAAAAA..",
                "..AEANAEA..",
                "..AAAAAAA..",
                "...WAAAW...",
                "....L.L....",
            ],
        },
        "security" => Character {
            name: "Jaguar",
            body: gold,
            accent: brown,
            pixels: [
                "..A...A....",
                "..AAAAA....",
                "..AEAEA....",
                "...ANAAAA..",
                "..AADADAAW.",
                "..L.L..L...",
            ],
        },
        "product_manager" => Character {
            name: "Ocelote",
            body: brown,
            accent: gold,
            pixels: [
                "..A...A....",
                "..AAAAA....",
                "..AEAEA....",
                "...ANAAAA..",
                "..AWAWAAAW.",
                "..L.L..L...",
            ],
        },
        "test" => Character {
            name: "Chapulín",
            body: GREEN,
            accent: gold,
            pixels: [
                "....L.L....",
                "....AEA....",
                "...AAAAAA..",
                "..LAAAWAA..",
                ".L...L..L..",
                "L...L....L.",
            ],
        },
        "devops" | "scout" => Character {
            name: if role == "scout" {
                "Halcón"
            } else {
                "Águila"
            },
            body: brown,
            accent: WHITE,
            pixels: [
                "....WWW....",
                "....WEN....",
                "AAAAAWAAAAA",
                ".AAAAWAAAA.",
                "...AAAAA...",
                "....L.L....",
            ],
        },
        "quality" | "quality_gate" | "verifier" | "reviewer" => Character {
            name: "Puma",
            body: Color::Rgb {
                r: 197,
                g: 158,
                b: 117,
            },
            accent: brown,
            pixels: [
                "..A...A....",
                "..AAAAA....",
                "..AEAEA....",
                "...ANAAAA..",
                "..AAAAAAAW.",
                "..L.L..L...",
            ],
        },
        "forensic" | "forensic_agent" => Character {
            name: "Zorro",
            body: Color::Rgb {
                r: 242,
                g: 135,
                b: 58,
            },
            accent: WHITE,
            pixels: [
                "..A...A....",
                "..AAAAA....",
                "..AEAEA....",
                "...WNAAAA..",
                "..WAAAAAAWW",
                "..L.L..L...",
            ],
        },
        "librarian" => Character {
            name: "Armadillo",
            body: gray,
            accent: brown,
            pixels: [
                "....AAA....",
                "...ADADA...",
                "..ADADADA..",
                ".NAADADAAA.",
                "...AAAAAAW.",
                "...L...L...",
            ],
        },
        "spider" => Character {
            name: "Araña",
            body: PURPLE,
            accent: CYAN,
            pixels: [
                ".L.L...L.L.",
                "..LLAEALL..",
                "...AAAAA...",
                "..LLAAALL..",
                ".L.L...L.L.",
                "L.........L",
            ],
        },
        "tool" | "tool_worker" | "builder" => Character {
            name: "Cangrejo",
            body: Color::Rgb {
                r: 241,
                g: 117,
                b: 80,
            },
            accent: AMBER,
            pixels: [
                ".A.......A.",
                "AAA.E.E.AAA",
                ".A.AAAAA.A.",
                "...AAAAA...",
                "..L.L.L.L..",
                ".L.......L.",
            ],
        },
        role if role.starts_with("subagent")
            || role.starts_with("hormiga")
            || role.starts_with("spawn:")
            || role.starts_with("spawn_") =>
        {
            Character {
                name: "Hormiga",
                body: brown,
                accent: gold,
                pixels: [
                    "....L.L....",
                    "....AEA....",
                    "..L.AAA.L..",
                    "...L.A.L...",
                    "..L.AAA.L..",
                    "...L...L...",
                ],
            }
        }
        _ => Character {
            name: "Agente",
            body: CYAN,
            accent: WHITE,
            pixels: [
                "...AAAAA...",
                "..AWAEAWA..",
                "...AAAAA...",
                "....AAA....",
                "...LAAAL...",
                "....L.L....",
            ],
        },
    }
}

fn color(sprite: &Character, pixel: u8) -> Option<Color> {
    match pixel {
        b'A' => Some(sprite.body),
        b'W' => Some(sprite.accent),
        b'E' => Some(WHITE),
        b'C' | b'N' => Some(AMBER),
        b'D' | b'L' => Some(Color::Rgb {
            r: 70,
            g: 48,
            b: 40,
        }),
        _ => None,
    }
}

pub fn draw(
    canvas: &mut Canvas,
    x: u16,
    y: u16,
    role: &str,
    frame: u8,
    animate: bool,
    selected: bool,
) {
    let sprite = character(role);
    for row in 0..HEIGHT {
        for col in 0..WIDTH {
            let sample = |pixel_row: usize| {
                let mut pixel = sprite.pixels[pixel_row]
                    .as_bytes()
                    .get(col as usize)
                    .copied()
                    .unwrap_or(b'.');
                // Legs alternate and outer wing tips lift, preserving each species' silhouette.
                if animate && frame % 2 == 1 {
                    if pixel == b'L' && pixel_row == 5 && col % 2 == 0 {
                        pixel = b'.';
                    }
                    if pixel == b'W' && (col == 0 || col == WIDTH - 1) {
                        pixel = b'.';
                    }
                }
                color(&sprite, pixel)
            };
            let upper = sample(row as usize * 2);
            let lower = sample(row as usize * 2 + 1);
            if upper.is_none() && lower.is_none() {
                continue;
            }
            let background = canvas
                .cell_at(x + col, y + row)
                .map(|cell| cell.style.bg)
                .unwrap_or(Color::Reset);
            let (ch, foreground, background) = match (upper, lower) {
                (Some(a), Some(b)) => ('▀', a, b),
                (Some(a), None) => ('▀', a, background),
                (None, Some(b)) => ('▄', b, background),
                _ => unreachable!(),
            };
            canvas.print(
                x + col,
                y + row,
                &ch.to_string(),
                Style::new().fg(foreground).bg(background),
            );
        }
    }
    if selected {
        canvas.print(x, y + HEIGHT, "▔▔▔▔▔▔▔▔▔▔▔", Style::new().fg(AMBER));
    }
}

pub fn bounds(x: u16, y: u16) -> Rect {
    Rect::new(x, y, WIDTH, HEIGHT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_profile_names_use_the_same_cast_as_telemetry_ids() {
        for (profile, id) in [
            ("BEE", "bee"),
            ("Builder", "builder"),
            ("Planner", "planner"),
            ("Quality Gate", "verifier"),
            ("Scout", "scout"),
            ("Spider", "spider"),
        ] {
            assert_eq!(character(profile).pixels, character(id).pixels);
            assert_ne!(character(profile).name, "Agente");
        }
    }
    #[test]
    fn the_hive_cast_has_original_distinct_silhouettes() {
        let roles = [
            "bee",
            "architecture",
            "backend",
            "frontend",
            "data_scientist",
            "security",
            "product_manager",
            "test",
            "devops",
            "quality",
            "forensic",
            "librarian",
            "spider",
            "tool",
        ];
        let mut silhouettes = std::collections::HashSet::new();
        for role in roles {
            let sprite = character(role);
            assert!(sprite.pixels.iter().all(|row| row.len() == WIDTH as usize));
            assert!(
                silhouettes.insert((sprite.pixels, sprite.body)),
                "duplicate character {role}"
            );
        }
    }
}
