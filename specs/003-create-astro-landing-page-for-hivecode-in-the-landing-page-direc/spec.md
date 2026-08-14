# Feature Specification: Astro Landing Page for HiveCode

## 1. Overview & Context
This specification defines the landing page for **HiveCode**—a Multi-AI Coding Swarm console-first harness built on Bun, SQLite (HiveDB WAL), and a Rust-compiled TUI. The landing page will be built using the **Astro** framework, styled beautifully with a modern and interactive design, highlighting the cooperative intelligence swarm of specialist agents (BEE, Scout, Builder, Verifier, Reviewer).

Due to workspace sandbox restrictions, all files will be generated inside the workspace at `/home/johnpaez/Documentos/Agents/Hive/hiveCode/landing-page`. We will provide the user with clear instructions to copy or move this project to their desired directory `/home/johnpaez/Documentos/Bee/landing page`.

## 2. Requirements & User Stories

### User Stories
- **US-1**: As a developer, I want to immediately understand what HiveCode is and its core benefits (Multi-AI Swarm, TUI-first, multi-provider).
- **US-2**: As a developer, I want to explore the different specialist agents in the swarm (BEE, Scout, Builder, Verifier, Reviewer) and see how they collaborate.
- **US-3**: As an adopter, I want to see how the durable lifecycle of Spec Kit works (Specification -> Plan -> Execution -> Verification -> Review -> Convergence).
- **US-4**: As a user, I want to easily copy the installation commands and find the getting started steps.

### Functional Requirements
- **FR-001: Astro Framework Structure**: The project must use Astro (v4+) layout-page structure, separating common layouts from pages and components.
- **FR-002: Dynamic Content & Swarm Profiles**: An interactive profile switcher or detailed showcase displaying BEE, Scout, Builder, Verifier, and Reviewer.
- **FR-003: Core Features Showcase**: Interactive cards for the TUI, multi-provider backend, HiveDB memory database, and Spec Kit engine.
- **FR-004: Clean UI & Design System**: Modern dark-themed design with neon accent colors matching each agent's identity.
- **FR-005: Fully Responsive**: Excellent presentation across mobile, tablet, and desktop viewports.

### Non-Functional Requirements
- **NFR-001: Performance**: Fast loading speed, low JS footprint by leveraging Astro's zero-JS-by-default architecture.
- **NFR-002: Modular Components**: High-quality component structures (`Layout.astro`, `AgentCard.astro`, `FeatureCard.astro`, etc.).

# User Scenarios
- **Scenario 1: Landing Page Discovery**: A developer arrives on the page. They are greeted by an elegant, animated terminal hero showing a swarm interaction. They scroll down to find the five agent cards glowing in their signature colors, clicking on each to see their specific roles and prompts.
- **Scenario 2: Understanding Spec Kit**: An architect reads the Spec Kit section. They interact with a visual timeline demonstrating how Spec Kit orchestrates features from drafting to convergence.
- **Scenario 3: Integration and Quick-Start**: A developer copies the command `npm install -g hivecode` and `hivecode init` from the CTA block to install and run the project locally.

## 3. Architecture & Components

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

### Swarm Accents Matrix
- **BEE (Coordinator)**: Yellow (`#F59E0B`, Amber-500)
- **Scout (Researcher)**: Sky Blue (`#0EA5E9`, Sky-500)
- **Builder (Mutator)**: Emerald Green (`#10B981`, Emerald-500)
- **Verifier (Aceptación)**: Purple (`#8B5CF6`, Violet-500)
- **Reviewer (Gate)**: Red (`#EF4444`, Red-500)

## 4. Success Criteria & Verification
- **SC-001**: A complete, working Astro project structure in `/home/johnpaez/Documentos/Agents/Hive/hiveCode/landing-page`.
- **SC-002**: Index page features a rich hero, agent profile showcase, feature list, Spec Kit lifecycle timeline, and footer.
- **SC-003**: Fully styled layout using clean, standard Tailwind CSS-compatible CSS or modern styling.
- **SC-004**: Comprehensive instruction set explaining how the user can boot up, build, and copy the landing page.
