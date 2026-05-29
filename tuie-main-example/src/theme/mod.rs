//! Color palettes and theming.

use crate::util::rgb::Rgb;

#[cfg(feature = "harmonious")]
pub mod harmonious;

/// Minimal 8-color theme specification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Theme {
    /// Background color.
    pub bg: Rgb,
    /// Foreground color.
    pub fg: Rgb,
    /// Red accent.
    pub red: Rgb,
    /// Green accent.
    pub green: Rgb,
    /// Yellow accent.
    pub yellow: Rgb,
    /// Blue accent.
    pub blue: Rgb,
    /// Magenta accent.
    pub magenta: Rgb,
    /// Cyan accent.
    pub cyan: Rgb,
}

impl Theme {
    /// One Dark color scheme.
    pub const ONE_DARK: Self = Self {
        bg: Rgb::from_hex(0x282c34),
        fg: Rgb::from_hex(0xabb2bf),
        red: Rgb::from_hex(0xe06c75),
        green: Rgb::from_hex(0x98c379),
        yellow: Rgb::from_hex(0xe5c07b),
        blue: Rgb::from_hex(0x61afef),
        magenta: Rgb::from_hex(0xc678dd),
        cyan: Rgb::from_hex(0x56b6c2),
    };

    /// One Light color scheme.
    pub const ONE_LIGHT: Self = Self {
        bg: Rgb::from_hex(0xfafafa),
        fg: Rgb::from_hex(0x383a42),
        red: Rgb::from_hex(0xe06c75),
        green: Rgb::from_hex(0x98c379),
        yellow: Rgb::from_hex(0xe5c07b),
        blue: Rgb::from_hex(0x61afef),
        magenta: Rgb::from_hex(0xc678dd),
        cyan: Rgb::from_hex(0x56b6c2),
    };

    /// Gruvbox Dark color scheme.
    pub const GRUVBOX_DARK: Self = Self {
        bg: Rgb::from_hex(0x282828),
        fg: Rgb::from_hex(0xebdbb2),
        red: Rgb::from_hex(0xcc241d),
        green: Rgb::from_hex(0x98971a),
        yellow: Rgb::from_hex(0xd79921),
        blue: Rgb::from_hex(0x458588),
        magenta: Rgb::from_hex(0xb16286),
        cyan: Rgb::from_hex(0x689d6a),
    };

    /// Gruvbox Light color scheme.
    pub const GRUVBOX_LIGHT: Self = Self {
        bg: Rgb::from_hex(0xfcf1c7),
        fg: Rgb::from_hex(0x3d3836),
        red: Rgb::from_hex(0xcc241d),
        green: Rgb::from_hex(0x98971a),
        yellow: Rgb::from_hex(0xd79921),
        blue: Rgb::from_hex(0x458588),
        magenta: Rgb::from_hex(0xb16286),
        cyan: Rgb::from_hex(0x689d6a),
    };

    /// Solarized Dark color scheme.
    pub const SOLARIZED_DARK: Self = Self {
        bg: Rgb::from_hex(0x002b36),
        fg: Rgb::from_hex(0x93a1a1),
        red: Rgb::from_hex(0xdc322f),
        green: Rgb::from_hex(0x859900),
        yellow: Rgb::from_hex(0xb58900),
        blue: Rgb::from_hex(0x268bd2),
        magenta: Rgb::from_hex(0x6c71c4),
        cyan: Rgb::from_hex(0x2aa198),
    };

    /// Solarized Light color scheme.
    pub const SOLARIZED_LIGHT: Self = Self {
        bg: Rgb::from_hex(0xfdf6e3),
        fg: Rgb::from_hex(0x586e75),
        red: Rgb::from_hex(0xdc322f),
        green: Rgb::from_hex(0x859900),
        yellow: Rgb::from_hex(0xb58900),
        blue: Rgb::from_hex(0x268bd2),
        magenta: Rgb::from_hex(0x6c71c4),
        cyan: Rgb::from_hex(0x2aa198),
    };

    /// Everforest Dark color scheme.
    pub const EVERFOREST_DARK: Self = Self {
        bg: Rgb::from_hex(0x2d353b),
        fg: Rgb::from_hex(0xd3c6aa),
        red: Rgb::from_hex(0xe67e80),
        green: Rgb::from_hex(0xa7c080),
        yellow: Rgb::from_hex(0xdbbc7f),
        blue: Rgb::from_hex(0x7fbbb3),
        magenta: Rgb::from_hex(0xd699b6),
        cyan: Rgb::from_hex(0x83c092),
    };

    /// Everforest Light color scheme.
    pub const EVERFOREST_LIGHT: Self = Self {
        bg: Rgb::from_hex(0xfdf6e3),
        fg: Rgb::from_hex(0x5c6a72),
        red: Rgb::from_hex(0xe67e80),
        green: Rgb::from_hex(0xa7c080),
        yellow: Rgb::from_hex(0xdbbc7f),
        blue: Rgb::from_hex(0x7fbbb3),
        magenta: Rgb::from_hex(0xd699b6),
        cyan: Rgb::from_hex(0x83c092),
    };

    /// Century Dark color scheme.
    pub const CENTURY_DARK: Self = Self {
        bg: Rgb::from_hex(0x2d323b),
        fg: Rgb::from_hex(0xa1a1a1),
        red: Rgb::from_hex(0xc18181),
        green: Rgb::from_hex(0x91b191),
        yellow: Rgb::from_hex(0xc9a989),
        blue: Rgb::from_hex(0x81a1c1),
        magenta: Rgb::from_hex(0xb191b1),
        cyan: Rgb::from_hex(0x91b1b1),
    };

    /// Century Light color scheme.
    pub const CENTURY_LIGHT: Self = Self {
        bg: Rgb::from_hex(0xd4d8dc),
        fg: Rgb::from_hex(0x6a6a6a),
        red: Rgb::from_hex(0xe05661),
        green: Rgb::from_hex(0x599a54),
        yellow: Rgb::from_hex(0xbc8f2f),
        blue: Rgb::from_hex(0x3d92cc),
        magenta: Rgb::from_hex(0x8a69b8),
        cyan: Rgb::from_hex(0x50a5a2),
    };
}
