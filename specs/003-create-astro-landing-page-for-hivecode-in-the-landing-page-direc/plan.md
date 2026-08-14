# Implementation Plan: Astro Landing Page for HiveCode

This plan details the step-by-step creation of the HiveCode landing page. Since we cannot execute arbitrary command lines on the host outside our workspace, we will write all the files representing a complete Astro project in `/home/johnpaez/Documentos/Agents/Hive/hiveCode/landing-page` and provide the user with high-quality instructions.

# Technical Context
The landing page will be built using Astro (v4+). It will contain a modern developer-centric design utilizing responsive HTML5/CSS3. Because the user workspace is strictly isolated at `/home/johnpaez/Documentos/Agents/Hive/hiveCode`, we will output the entire Astro project inside a subfolder `landing-page/` and deliver copy/paste scripts so the user can easily synchronize it with `/home/johnpaez/Documentos/Bee/landing page`.

# Project Structure
The folder layout is designed to conform to standard Astro conventions:
```
landing-page/
├── astro.config.mjs
├── package.json
├── tsconfig.json
├── public/
│   └── favicon.svg
└── src/
    ├── components/
    │   ├── AgentCard.astro
    │   ├── FeatureCard.astro
    │   ├── Footer.astro
    │   └── Navbar.astro
    ├── layouts/
    │   └── Layout.astro
    └── pages/
        └── index.astro
```

# Constitution Check
- **Principle 1 (Evidence before claims)**: The landing page must accurately reflect the real codebase and components of HiveCode (BEE, Scout, Builder, Verifier, Reviewer). We will base the content on the real `README.md`.
- **Principle 2 (Clean Design)**: Avoid bloat. The page should load in milliseconds, matching Astro's static site generation philosophy.
- **Principle 3 (Sandbox adherence)**: Strictly work within the workspace boundary and empower the user to do the final export cleanly.

## Step-by-Step Execution Path

### Phase 1: Project Scaffolding
- **Task 1.1**: Create `landing-page/package.json` with Astro and dependencies.
- **Task 1.2**: Create `landing-page/astro.config.mjs` configuring the basic layout.
- **Task 1.3**: Create `landing-page/tsconfig.json` for TypeScript support.

### Phase 2: Core Shell (Layout & Shared Components)
- **Task 2.1**: Create `landing-page/src/layouts/Layout.astro` with full HTML5 shell, dark-themed styling, custom scrollbars, and google font integrations (Space Grotesk or Inter).
- **Task 2.2**: Create `landing-page/src/components/Navbar.astro` with logo and quick links.
- **Task 2.3**: Create `landing-page/src/components/Footer.astro` with copyright and swarm description.

### Phase 3: Content Components
- **Task 3.1**: Create `landing-page/src/components/AgentCard.astro` showing agents with custom colors, symbols, badges, and roles.
- **Task 3.2**: Create `landing-page/src/components/FeatureCard.astro` showing general highlights (TUI, HiveDB, etc.).

### Phase 4: Main Page (`index.astro`)
- **Task 4.1**: Build `landing-page/src/pages/index.astro`.
- **Task 4.2**: Implement Hero section with multi-agent terminal animations (simulated in CSS/HTML).
- **Task 4.3**: Integrate the Agent Showcase with neon glows.
- **Task 4.4**: Implement the Spec Kit Lifecycle flow (interactive visual timeline).
- **Task 4.5**: Add install section (`bun install hivecode`, `hivecode init`).

### Phase 5: Gaps, Copying and Assets
- **Task 5.1**: Generate `favicon.svg` with the beehive logo inside `public/`.
- **Task 5.2**: Provide direct terminal command instructions so the user can easily move `/home/johnpaez/Documentos/Agents/Hive/hiveCode/landing-page` to `/home/johnpaez/Documentos/Bee/landing page` and test it locally using bun/npm/pnpm.

## Risks & Mitigations
- **Workspace Sandbox Lock**: Operative block on file writes outside workspace is fully avoided by packaging everything cleanly inside `landing-page/` and generating explicit move scripts.
- **Tailwind Version Mismatch**: We will structure the styling with highly semantic CSS and modern design systems, making it robust and fully integrated with Astro.
