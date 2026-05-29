# chord_macro

Human readable input chord construction and pattern matching.

```rust
use chord_macro::chord;

match event {
    chord!(Ctrl + a) => {}
    chord!(Enter) => {}
    chord!(LeftClick) => {}
    _ => {}
}
```

Part of the [tuie](https://github.com/jake-stewart/tuie) toolkit.
