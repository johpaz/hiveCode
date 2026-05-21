/// Una región rectangular del terminal (coordenadas de celdas, no píxeles).
///
/// `x`, `y` = esquina superior izquierda (0-based).
/// `w`, `h` = ancho y alto en celdas.
///
/// Por qué `Copy` además de `Clone`:
/// ────────────────────────────────
/// `Clone` requiere llamar a `.clone()` explícitamente. `Copy` hace que el
/// compilador copie automáticamente cuando pasamos un Rect por valor — sin mover
/// la propiedad. Como Rect solo contiene cuatro `u16` (8 bytes), copiar es gratis.
/// Las structs derivadas solo pueden ser `Copy` si TODOS sus campos también lo son.
/// `u16` implementa `Copy`, así que podemos hacerlo.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    pub fn new(x: u16, y: u16, w: u16, h: u16) -> Self {
        Self { x, y, w, h }
    }

    /// Columna derecha exclusiva (x + w).
    pub fn right(&self) -> u16 { self.x + self.w }

    /// Fila inferior exclusiva (y + h).
    pub fn bottom(&self) -> u16 { self.y + self.h }

    /// Cantidad total de celdas.
    pub fn area(&self) -> usize { self.w as usize * self.h as usize }

    /// Devuelve true si (x, y) está dentro de este rectángulo.
    pub fn contains(&self, x: u16, y: u16) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    // ── Helpers de división ───────────────────────────────────────────────────

    /// Divide verticalmente (de arriba a abajo) según las alturas dadas.
    ///
    /// Ejemplo: `rect.vsplit(&[3, 0, 1])` con altura total 20 produce:
    ///   [Rect h=3, Rect h=16 (Fill), Rect h=1]
    ///
    /// `0` significa "ocupa el espacio restante" (equivale a Fill en ratatui).
    /// Si hay más de un Fill, el espacio se reparte igualmente.
    pub fn vsplit(self, heights: &[u16]) -> Vec<Rect> {
        split(self, heights, true)
    }

    /// Divide horizontalmente (de izquierda a derecha) según los anchos dados.
    /// `0` = Fill, igual que `vsplit`.
    pub fn hsplit(self, widths: &[u16]) -> Vec<Rect> {
        split(self, widths, false)
    }
}

/// Implementación genérica de split usada por vsplit/hsplit.
fn split(r: Rect, sizes: &[u16], vertical: bool) -> Vec<Rect> {
    let total = if vertical { r.h } else { r.w };

    // Cuenta cuántos "Fill" (tamaño 0) hay y cuánto espacio fijo se usa
    let fixed: u16 = sizes.iter().sum();
    let fills = sizes.iter().filter(|&&s| s == 0).count() as u16;
    let fill_size = if fills > 0 {
        total.saturating_sub(fixed) / fills
    } else {
        0
    };

    let mut rects = Vec::with_capacity(sizes.len());
    let mut offset = 0u16;

    for &size in sizes {
        let actual = if size == 0 { fill_size } else { size };
        let rect = if vertical {
            Rect::new(r.x, r.y + offset, r.w, actual.min(total.saturating_sub(offset)))
        } else {
            Rect::new(r.x + offset, r.y, actual.min(total.saturating_sub(offset)), r.h)
        };
        rects.push(rect);
        offset += actual;
        if offset >= total { break; }
    }

    rects
}
