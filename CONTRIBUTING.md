# Contributing to Alfred

Thanks for your interest in Alfred! This document covers how to set up your
environment, the project's workflow, and how to submit changes.

## Before you start

- **`spec/`** is the functional and technical source of truth — one file per
  module, indexed in [`spec/README.md`](spec/README.md) with a status per
  module (built, in progress, out of scope for v1, etc.).
- **`ROADMAP.md`** tracks what's left to do for v1.
- Check both before starting work — a feature marked **"Hors v1" / "out of
  scope"** in a spec is intentionally not being built right now; please open an
  issue to discuss it before submitting a PR for it.
- For anything that isn't a small fix (a new feature, a behavior change), please
  **open an issue first** to discuss the approach before writing code. This
  avoids wasted work if the direction doesn't fit the project.
- The **AlfredIA backend** (Claude proxy + optional managed subscription,
  metrics) lives in a separate private repository and is out of scope for
  contributions here — this repo is the desktop app only.

## Development setup

See [`README.md`](README.md#building-from-source) for the full Windows/macOS
setup (prerequisites, dev server, packaging).

Quick start:

```bash
npm install
# Windows
./scripts/setup-windows.ps1
./scripts/dev-windows.ps1
# macOS
npm run tauri:dev
```

## Architecture principles (please respect these)

These are deliberate, locked-in decisions (see [`spec/00-architecture.md`](spec/00-architecture.md)):

- **The Rust backend owns all OS and network I/O** (files, audio, HTTP,
  secrets). The **frontend only handles display and UI state** — no business
  logic, no secrets, no direct network calls from the frontend.
- **The vault (Markdown files) is the source of truth for content**
  (`alfred-raw/`, `alfred-intelligence/`, `Todo.md`). SQLite is for local
  config/state only, never for user content.
- **AI access is 100% via the Claude API (HTTP)** — never a local CLI.
- The app is **cross-platform**: Windows (10 1809+/11) and macOS (13+). Please
  keep platform-specific code isolated and behind the existing abstractions
  (e.g. `src-tauri/src/audio/`) rather than branching UI logic on OS.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep commits focused — one logical change per commit.
3. Commit messages follow a light `type(scope): summary` convention (see
   `git log` for examples: `feat`, `fix`, `docs`, `chore`, `refactor`), in the
   imperative mood, referencing the relevant `spec/NN` when useful.
4. Open a pull request against `main`. Describe **what** changed and **why**,
   and link the issue/spec section it relates to.

By submitting a pull request, you agree that your contribution is licensed
under the project's [Apache License, Version 2.0](LICENSE).

## Testing

- **Rust**: unit tests live next to the code (`#[cfg(test)]`). Run with:
  ```bash
  cd src-tauri
  cargo test
  ```
- **Manual QA**: [`TESTS.md`](TESTS.md) is the manual end-to-end test
  checklist covering every v1 feature. If you touch a feature, please run
  through its section before opening the PR.
- There is currently no automated frontend test suite — `tsc` (via `npm run
  build`) is the only automated frontend check.

## Code style

- **Rust**: format with `cargo fmt` and check with `cargo clippy` before
  submitting.
- **TypeScript/React**: no enforced linter yet — please match the existing
  style (functional components, Zustand for state, Tailwind for styling).

## Questions

Open an issue — happy to help you get oriented.
