# Skills

Una skill es un `SKILL.md`: encabezado YAML y, debajo, instrucciones. Solo añade texto al prompt;
cargarla no ejecuta nada.

```markdown
---
name: despliegue_local
description: Cómo desplegar este proyecto
triggers: ["desplegar a produccion", "deploy"]
rules: ["Nunca despliegues un viernes"]
steps:
  - step: 1
    action: probar
    instruction: "Corre las pruebas"
---
Usa ./scripts/deploy.sh
```

Orígenes (la posterior reemplaza a la anterior por nombre): las incluidas en el binario (`skills/`
del repositorio), las tuyas (`<home>/skills/<nombre>/SKILL.md`) y las del proyecto
(`.hivecode/skills/<nombre>/SKILL.md`).

**Selección:** una skill aplica si alguno de sus `triggers` aparece en la tarea como palabra o
frase completa; gana la de triggers más largos; como máximo 2 y 6000 caracteres por tarea.

Comandos: `hivecode skill list`, `show NOMBRE`, `match TEXTO`, `check` (muestra los archivos rotos).
Muchas skills incluidas nombran herramientas de la versión anterior; son guías, y el agente usa las
que tiene.
