//! Office geometry, furniture and routes shared by rendering and mouse input.
use super::office_art;
use crate::{
    state::AppState,
    term::{Canvas, Color, Rect, Style, AMBER_DIM, CYAN, GREEN, SECONDARY},
    ui::truncate_cells,
};
use std::collections::{HashMap, VecDeque};

pub const FLOOR: Color = Color::Rgb {
    r: 29,
    g: 29,
    b: 25,
};
const WOOD: Color = Color::Rgb {
    r: 164,
    g: 119,
    b: 68,
};
const EDGE: Color = Color::Rgb {
    r: 65,
    g: 77,
    b: 78,
};
const RUG: Color = Color::Rgb {
    r: 30,
    g: 45,
    b: 42,
};

pub struct Scene {
    pub area: Rect,
    pub shared: bool,
    pub stations: Vec<(usize, Rect)>,
    pub obstacles: Vec<Rect>,
}

impl Scene {
    pub fn new(area: Rect, state: &AppState, count: usize, compact: bool) -> Self {
        let shared = !compact && area.w >= 100 && area.h >= 16;
        let side = if shared {
            if area.w >= 140 {
                20
            } else {
                16
            }
        } else {
            0
        };
        let header = if compact { u16::from(area.h >= 4) } else if area.h < 18 { 1 } else { 2 };
        let footer = if compact { u16::from(area.h >= 4) } else if area.h < 18 { 1 } else { 2 };
        let station_h = if compact {
            if area.h >= 4 {
                2
            } else {
                1
            }
        } else {
            if area.h >= 18 {
                7
            } else {
                6
            }
        };
        let body = Rect::new(
            area.x + 1 + side,
            area.y + header,
            area.w.saturating_sub(2 + side * 2),
            area.h.saturating_sub(header + footer),
        );
        let max_columns = if compact {
            1
        } else {
            (body.w / 28).clamp(1, 4)
        };
        // Balance the last row: six live profiles form two rows of three.
        let columns = if compact || count == 0 {
            max_columns
        } else {
            let needed_rows = count.div_ceil(max_columns as usize);
            (count.div_ceil(needed_rows) as u16).min(max_columns).max(1)
        };
        let rows = body.h / station_h;
        let capacity = rows as usize * columns as usize;
        let start = state
            .dashboard_scroll
            .min(count.saturating_sub(capacity.max(1)));
        let stations: Vec<_> = (start..count)
            .take(capacity)
            .enumerate()
            .map(|(slot, index)| {
                let width = body.w / columns;
                (
                    index,
                    Rect::new(
                        body.x + slot as u16 % columns * width,
                        body.y + slot as u16 / columns * station_h,
                        width,
                        station_h,
                    ),
                )
            })
            .collect();
        let mut obstacles: Vec<Rect> = if compact {
            Vec::new()
        } else {
            stations
                .iter()
                .map(|(_, station)| Self::desk(*station))
                .collect()
        };
        if shared {
            obstacles.push(Rect::new(area.x + 2, area.y + 3, 12, 3));
            obstacles.push(Rect::new(area.right() - 14, area.y + 3, 12, 3));
            obstacles.push(Rect::new(area.right() - 14, area.bottom() - 6, 12, 3));
        }
        Self {
            area,
            shared,
            stations,
            obstacles,
        }
    }

    pub fn desk(station: Rect) -> Rect {
        Rect::new(station.x + 1, station.y, 12.min(station.w), 3)
    }
    pub fn chair(station: Rect) -> (u16, u16) {
        (
            station.x + 15.min(station.w.saturating_sub(office_art::WIDTH)),
            station.y,
        )
    }

    pub fn target(&self, index: usize, station: Rect, zone: u16) -> (u16, u16) {
        if !self.shared {
            // Smaller offices have a reading nook beside each desk.
            return match zone {
                8 => (station.x + 1, station.y + 3),
                70 => (
                    station.x + station.w.saturating_sub(office_art::WIDTH),
                    station.y + 3,
                ),
                92 => (
                    station.x + 14.min(station.w.saturating_sub(office_art::WIDTH)),
                    station.y + 3,
                ),
                _ => Self::chair(station),
            };
        }
        let available = self.area.h.saturating_sub(9);
        let slot = index as u16 % (available / 3).max(1);
        match zone {
            8 => (self.area.x + 3, self.area.y + 6 + slot * 3),
            70 => (
                self.area.right() - 14,
                self.area.y + 6 + (index as u16 % 2) * 3,
            ),
            92 => (
                self.area.right() - 14,
                self.area.bottom().saturating_sub(10),
            ),
            _ => Self::chair(station),
        }
    }

    fn passable(&self, point: (u16, u16), target: (u16, u16)) -> bool {
        point == target
            || (point.0 > self.area.x
                && point.0 + office_art::WIDTH < self.area.right()
                && point.1 >= self.area.y + 2
                && point.1 + office_art::HEIGHT < self.area.bottom() - 1
                && !self
                    .obstacles
                    .iter()
                    .any(|desk| desk.contains(point.0, point.1)))
    }

    /// Breadth-first routing on terminal cells, around the solid desk footprints.
    pub fn route(&self, start: (u16, u16), target: (u16, u16)) -> VecDeque<(u16, u16)> {
        let mut queue = VecDeque::from([start]);
        let mut previous = HashMap::from([(start, start)]);
        while let Some(point) = queue.pop_front() {
            if point == target {
                let mut route = VecDeque::new();
                let mut cursor = target;
                while cursor != start {
                    route.push_front(cursor);
                    cursor = previous[&cursor];
                }
                return route;
            }
            for next in [
                (point.0.saturating_sub(1), point.1),
                (point.0.saturating_add(1), point.1),
                (point.0, point.1.saturating_sub(1)),
                (point.0, point.1.saturating_add(1)),
            ] {
                if !previous.contains_key(&next) && self.passable(next, target) {
                    previous.insert(next, point);
                    queue.push_back(next);
                }
            }
        }
        VecDeque::new()
    }

    pub fn draw(&self, canvas: &mut Canvas) {
        let area = self.area;
        if area.w < 2 || area.h < 2 {
            return;
        }
        let room = Rect::new(area.x, area.y + 1, area.w, area.h - 2);
        canvas.fill_rect(room, ' ', Style::new().bg(FLOOR));
        for row in room.y + 1..room.bottom().saturating_sub(1) {
            for col in room.x + 1..room.right().saturating_sub(1) {
                if (col - room.x + (row - room.y) / 3 * 4) % 12 == 0 && (row - room.y) % 3 == 0 {
                    canvas.print(
                        col,
                        row,
                        "─",
                        Style::new()
                            .fg(Color::Rgb {
                                r: 43,
                                g: 42,
                                b: 34,
                            })
                            .bg(FLOOR),
                    );
                }
            }
        }
        canvas.draw_border(room, Style::new().fg(EDGE).bg(FLOOR));
        if self.shared {
            let side = if area.w >= 140 { 18 } else { 14 };
            let left = Rect::new(room.x + 1, room.y + 1, side, room.h.saturating_sub(2));
            let right = Rect::new(
                room.right() - side - 1,
                room.y + 1,
                side,
                room.h.saturating_sub(2),
            );
            canvas.fill_rect(left, ' ', Style::new().bg(RUG));
            canvas.fill_rect(
                right,
                ' ',
                Style::new().bg(Color::Rgb {
                    r: 27,
                    g: 35,
                    b: 47,
                }),
            );
            art(
                canvas,
                left.x + 1,
                left.y,
                &[
                    " BIBLIOTECA",
                    "┌──────────┐",
                    "│▌▌▌ ▌▌▌▌ ▌│",
                    "└──────────┘",
                ],
                GREEN,
            );
            for (offset, color) in [(1, GREEN), (3, WOOD), (6, CYAN), (9, SECONDARY)] {
                canvas.print(left.x + 1 + offset, left.y + 2, "▌", Style::new().fg(color));
            }
            art(
                canvas,
                right.x + 1,
                right.y,
                &[
                    " LAB / TESTS",
                    "┌──────────┐",
                    "│ >_  ▂▄▆  │",
                    "└──────────┘",
                ],
                CYAN,
            );
            if room.h >= 15 {
                art(
                    canvas,
                    right.x + 1,
                    right.bottom() - 5,
                    &[" DESCANSO", "╭──────────╮", "│ ░░░░░░░░ │", "╰──┬────┬──╯"],
                    SECONDARY,
                );
                art(
                    canvas,
                    left.x + 3,
                    left.bottom() - 3,
                    &[" \\│/", " ╲│╱", " ▐█▌"],
                    GREEN,
                );
            }
        }
        // Windows and a honeycomb plaque belong to the room, not to status cards.
        if room.w > 55 {
            canvas.print(
                room.x + room.w / 2 - 9,
                room.y,
                "┤ ░░ COLMENA ░░ ├",
                Style::new().fg(AMBER_DIM).bg(FLOOR),
            );
        }
        for (_, station) in &self.stations {
            let desk = Self::desk(*station);
            canvas.fill_rect(
                Rect::new(station.x, station.y, station.w.saturating_sub(2), 4),
                ' ',
                Style::new().bg(Color::Rgb {
                    r: 39,
                    g: 37,
                    b: 30,
                }),
            );
            art(
                canvas,
                desk.x,
                desk.y,
                &["╭──────╮    ", "│ >_   │ ▗▖ ", "╘══╤═══╛━▀▀━"],
                WOOD,
            );
            canvas.print(
                desk.x + 1,
                desk.y + 1,
                " >_   ",
                Style::new().fg(CYAN).bg(Color::Rgb {
                    r: 16,
                    g: 29,
                    b: 30,
                }),
            );
            canvas.print(desk.x + 2, desk.y + 3, "▱▱▱▱", Style::new().fg(SECONDARY));
            canvas.print(desk.x + 9, desk.y + 1, "▗▖", Style::new().fg(SECONDARY));
            let chair = Self::chair(*station);
            canvas.print(chair.0 + 3, chair.1 + 3, "╰─┬─╯", Style::new().fg(WOOD));
        }
        let bottom = self
            .stations
            .iter()
            .map(|(_, station)| station.bottom())
            .max()
            .unwrap_or(room.y + 3);
        if self.shared && bottom + 2 < room.bottom() {
            art(
                canvas,
                room.x + room.w / 2 - 10,
                bottom,
                &["╭─────── ◇ ───────╮", "╰─ MESA DE EQUIPO ─╯"],
                WOOD,
            );
            canvas.print(
                room.x + room.w / 2 - 5,
                bottom,
                "▤  ◇  ▤",
                Style::new().fg(SECONDARY),
            );
        }
    }
}

fn art(canvas: &mut Canvas, x: u16, y: u16, rows: &[&str], color: Color) {
    for (row, text) in rows.iter().enumerate() {
        canvas.print(x, y + row as u16, text, Style::new().fg(color));
    }
}

pub fn label(canvas: &mut Canvas, area: Rect, row: u16, value: &str, color: Color) {
    if row < area.h {
        canvas.print(
            area.x,
            area.y + row,
            &truncate_cells(value, area.w as usize),
            Style::new().fg(color),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn six_profiles_have_two_balanced_rows_and_reachable_shared_areas() {
        let scene = Scene::new(Rect::new(0, 0, 160, 20), &AppState::default(), 6, false);
        assert_eq!(scene.stations.len(), 6);
        assert_eq!(scene.stations[0].1.y, scene.stations[2].1.y);
        assert_eq!(scene.stations[3].1.y, scene.stations[5].1.y);
        assert!(scene.stations[3].1.y > scene.stations[2].1.y);
        for (index, station) in &scene.stations {
            for zone in [8, 70, 92] {
                let target = scene.target(*index, *station, zone);
                assert_eq!(
                    scene.route(Scene::chair(*station), target).back(),
                    Some(&target)
                );
            }
        }
    }
    #[test]
    fn walking_paths_go_around_desks() {
        let state = AppState::default();
        let scene = Scene::new(Rect::new(0, 0, 160, 26), &state, 6, false);
        let (_, station) = scene.stations[0];
        let start = Scene::chair(station);
        let target = scene.target(0, station, 8);
        let route = scene.route(start, target);
        assert!(!route.is_empty());
        assert_eq!(route.back(), Some(&target));
        let mut previous = start;
        for point in route {
            assert_eq!(
                previous.0.abs_diff(point.0) + previous.1.abs_diff(point.1),
                1
            );
            assert!(!scene
                .obstacles
                .iter()
                .any(|desk| desk.contains(point.0, point.1)));
            previous = point;
        }
    }
}
