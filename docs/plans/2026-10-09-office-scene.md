# Oficina animada del enjambre

## Referencias investigadas

- [Ratatui: HalfBlock](https://ratatui.rs/highlights/v024/): dos píxeles cuadrados por celda usando los colores de primer plano y fondo. Es adecuado para personajes con siluetas y paletas propias.
- [Canvas de Ratatui](https://docs.rs/ratatui/latest/ratatui/widgets/canvas/struct.Canvas.html): capas, coordenadas de escena y distintos marcadores para gráficos de terminal.
- [asciiquarium-rs](https://github.com/cablehead/asciiquarium-rs): composición de sprites transparentes sobre un buffer de celdas, ordenados por profundidad; actualización de animaciones y entrada en un bucle de eventos con Crossterm.

La implementación adapta esas técnicas al Canvas existente de Hive. El arte de los personajes es original; no se incorporaron sprites ni dependencias de esas referencias.

## Personajes y dibujo

La identidad procede del roster real y de las tablas canónicas de `agent-identity.ts` y `agent_graph.rs`: Abeja Reina, Cóndor, Topo, Quetzal, Tecolote, Jaguar, Ocelote, Chapulín, Águila, Puma, Zorro, Armadillo, Araña, Halcón, Cangrejo y Hormiga.

`office_art` define las siluetas y paletas. Cada sprite tiene 11×6 píxeles y ocupa 11×3 celdas. `▀` y `▄` permiten combinar dos colores por celda; los píxeles transparentes conservan el fondo de la oficina. Las alas y patas alternan solamente cuando hay movimiento o actividad. Los roles personalizados conservan su alias y usan un sprite de reserva.

La escena compone suelo, alfombras, paredes, estanterías, monitores, escritorios, sillas, plantas y descanso. Luego dibuja personajes ordenados por su coordenada vertical, accesorios de lectura/escritura/ejecución y el inspector. La vista compacta conserva selección y actividad cuando no hay espacio para la escena.

## Movimiento y actividad

`office_scene` comparte geometría entre dibujo, puestos, destinos y rutas. Una búsqueda en anchura sobre celdas calcula caminos alrededor de las superficies sólidas de escritorios y muebles. El tick existente de 120 ms avanza hasta tres celdas de la ruta; la ejecución de herramientas continúa independientemente de esa representación visual.

Las herramientas activas determinan el destino: lectura/búsqueda hacia archivo, ejecución hacia laboratorio, escritura/pensamiento hacia el puesto. Las dependencias y MCP apagados llevan a espera. HALT congela el movimiento. Completar una llamada devuelve al personaje a su puesto.

Las posiciones son locales al suelo. El desplazamiento respecto al puesto propio se transforma al cambiar la geometría; las rutas se recalculan. Los eventos pueden identificar al agente por rol o por ID del roster.

## Interacción y comprobación

Clic en puesto o personaje selecciona al agente dentro de Enjambre. Las regiones de los personajes tienen prioridad sobre las del suelo. Alt+↑/↓ recorre agentes, Enter abre Código y Esc cierra la selección; las confirmaciones pendientes y el texto del input mantienen prioridad.

Las pruebas cubren las siluetas, rutas que rodean obstáculos, destinos por actividad, HALT, identidades, reemplazos, selección, clics y terminales de 160×40, 100×24, 80×24 y 40×12.

Para exportar una escena ilustrativa con el renderer de producción:

```sh
cargo run --manifest-path packages/hivetui/Cargo.toml --example office_preview > /tmp/hivecode-office.svg
```

`HIVE_OFFICE_PREVIEW_TICKS` elige el instante de la animación. La vista previa utiliza actividad de demostración; la TUI utiliza la telemetría de la sesión.

La segunda revisión equilibra los seis perfiles en dos filas de tres, con suelo cálido, alfombras bajo los puestos, monitores iluminados, teclados, biblioteca y mesa de equipo. Mantiene el nombre del rol junto al personaje cuando hay espacio. Los nombres iniciales (`BEE`, `Quality Gate`) resuelven los mismos sprites y puestos que los identificadores de ejecución (`bee`, `verifier`), sin cambiar los IDs utilizados para abrir Código. Los alias personalizados del roster se conservan. La fila general de checkpoints se oculta en Enjambre porque el dashboard ya muestra sus checkpoints; permanece visible cuando hay recuperación pendiente.

La vista previa usa por defecto los seis nombres reales de inicio en 160×40. `HIVE_OFFICE_PREVIEW_IDLE=1` muestra reposo y `HIVE_OFFICE_PREVIEW_FULL=1` muestra el elenco completo.
