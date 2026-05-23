use std::io::Write;

use unicode_width::UnicodeWidthChar;
use crossterm::{
    cursor::MoveTo,
    queue,
    style::{
        Attribute, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor,
    },
};

use super::{cell::Cell, rect::Rect, style::Style};

pub struct Canvas {
    pub w: u16,
    pub h: u16,
    front: Vec<Cell>,
    back: Vec<Cell>,
}

impl Canvas {
    pub fn new(w: u16, h: u16) -> Self {
        let n = w as usize * h as usize;
        Self {
            w,
            h,
            front: vec![Cell::default(); n],
            back: vec![Cell::default(); n],
        }
    }

    pub fn area(&self) -> Rect {
        Rect::new(0, 0, self.w, self.h)
    }

    pub fn clear(&mut self) {
        for cell in &mut self.back {
            *cell = Cell::default();
        }
    }

    pub fn resize(&mut self, w: u16, h: u16) {
        self.w = w;
        self.h = h;
        let n = w as usize * h as usize;
        self.front = vec![
            Cell {
                ch: '\0',
                style: Style::default(),
            };
            n
        ];
        self.back = vec![Cell::default(); n];
    }

    pub fn put(&mut self, x: u16, y: u16, cell: Cell) {
        if x < self.w && y < self.h {
            self.back[y as usize * self.w as usize + x as usize] = cell;
        }
    }

    pub fn print(&mut self, x: u16, y: u16, text: &str, style: Style) {
        let mut col = 0u16;
        for ch in text.chars() {
            let w = UnicodeWidthChar::width(ch).unwrap_or(1) as u16;
            let cx = x.saturating_add(col);
            self.put(cx, y, Cell::new(ch, style));
            // Mark right-half of wide chars as placeholder so flush never overwrites them
            if w == 2 && cx + 1 < self.w {
                self.put(cx + 1, y, Cell::new('\0', style));
            }
            col += w;
        }
    }

    pub fn hline(&mut self, x: u16, y: u16, len: u16, ch: char, style: Style) {
        for i in 0..len {
            self.put(x + i, y, Cell::new(ch, style));
        }
    }

    /// Rellena un rectángulo con el carácter dado.
    pub fn fill_rect(&mut self, r: Rect, ch: char, style: Style) {
        for y in r.y..r.bottom() {
            self.hline(r.x, y, r.w, ch, style);
        }
    }

    /// Imprime texto centrado horizontalmente dentro de un ancho dado.
    pub fn print_centered(&mut self, x: u16, y: u16, w: u16, text: &str, style: Style) {
        let len = text.chars().count() as u16;
        let offset = w.saturating_sub(len) / 2;
        self.print(x + offset, y, text, style);
    }

    /// Serializes every row to a plain-text string (wide-char placeholders stripped).
    /// Used by the headless runner to emit frame snapshots for E2E tests.
    pub fn to_text_rows(&self) -> Vec<String> {
        (0..self.h)
            .map(|y| {
                (0..self.w)
                    .filter_map(|x| self.cell_at(x, y))
                    .filter(|c| c.ch != '\0')
                    .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
                    .collect()
            })
            .collect()
    }

    /// Returns the character at (x, y) in the back (pending) buffer.
    /// Used by tests to inspect rendered output without flushing to a real terminal.
    pub fn cell_at(&self, x: u16, y: u16) -> Option<&Cell> {
        if x < self.w && y < self.h {
            Some(&self.back[y as usize * self.w as usize + x as usize])
        } else {
            None
        }
    }

    pub fn draw_border(&mut self, r: Rect, style: Style) {
        if r.w < 2 || r.h < 2 {
            return;
        }

        let (x0, y0, x1, y1) = (r.x, r.y, r.right() - 1, r.bottom() - 1);
        self.put(x0, y0, Cell::new('┌', style));
        self.put(x1, y0, Cell::new('┐', style));
        self.put(x0, y1, Cell::new('└', style));
        self.put(x1, y1, Cell::new('┘', style));

        for x in (x0 + 1)..x1 {
            self.put(x, y0, Cell::new('─', style));
            self.put(x, y1, Cell::new('─', style));
        }
        for y in (y0 + 1)..y1 {
            self.put(x0, y, Cell::new('│', style));
            self.put(x1, y, Cell::new('│', style));
        }
    }

    pub fn flush(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        let mut last_fg = crossterm::style::Color::Reset;
        let mut last_bg = crossterm::style::Color::Reset;
        let mut last_bold = false;
        let mut last_dim = false;
        let mut cur_x: u16 = u16::MAX;
        let mut cur_y: u16 = u16::MAX;

        for y in 0..self.h {
            for x in 0..self.w {
                let idx = y as usize * self.w as usize + x as usize;
                let new = &self.back[idx];
                let old = &self.front[idx];
                if new == old {
                    if cur_x == x && cur_y == y {
                        cur_x = u16::MAX;
                    }
                    continue;
                }

                // Right-half placeholder for wide chars: update front but never render
                if new.ch == '\0' {
                    self.front[idx] = new.clone();
                    continue;
                }

                if cur_y != y || cur_x != x {
                    queue!(out, MoveTo(x, y))?;
                }

                let s = new.style;
                if last_bold && !s.bold {
                    queue!(out, SetAttribute(Attribute::Reset))?;
                    last_bold = false;
                    last_dim = false;
                    last_fg = crossterm::style::Color::Reset;
                    last_bg = crossterm::style::Color::Reset;
                }
                if !last_bold && s.bold {
                    queue!(out, SetAttribute(Attribute::Bold))?;
                    last_bold = true;
                }
                if last_dim && !s.dim {
                    queue!(out, SetAttribute(Attribute::Reset))?;
                    last_dim = false;
                    last_bold = false;
                    last_fg = crossterm::style::Color::Reset;
                    last_bg = crossterm::style::Color::Reset;
                }
                if !last_dim && s.dim {
                    queue!(out, SetAttribute(Attribute::Dim))?;
                    last_dim = true;
                }
                if s.fg != last_fg {
                    queue!(out, SetForegroundColor(s.fg))?;
                    last_fg = s.fg;
                }
                if s.bg != last_bg {
                    queue!(out, SetBackgroundColor(s.bg))?;
                    last_bg = s.bg;
                }

                queue!(out, Print(new.ch))?;
                self.front[idx] = new.clone();
                let ch_w = UnicodeWidthChar::width(new.ch).unwrap_or(1) as u16;
                cur_x = x.wrapping_add(ch_w);
                cur_y = y;
            }
        }

        queue!(out, ResetColor)?;
        queue!(out, SetAttribute(Attribute::Reset))?;
        out.flush()
    }
}
