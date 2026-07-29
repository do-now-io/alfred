# Alfred

Alfred — personal assistant desktop app (Tauri 2 + React/TypeScript).

## Running on Windows

Whisper (local transcription, CPU) is **on by default** (spec/04) — the app
builds `whisper.cpp` via the `whisper` Cargo feature, which is now part of
`default`. Everything else (calendar, notes/vault, todos, suggestions, chat)
runs normally regardless.

### Prerequisites

- **Rust** (MSVC toolchain) — install via [rustup](https://rustup.rs). Accept the
  default `x86_64-pc-windows-msvc` toolchain.
- **Visual Studio Build Tools** with the **"Desktop development with C++"**
  workload (provides the MSVC linker Rust needs).
- **WebView2 runtime** — preinstalled on Windows 11. If missing, install the
  Evergreen runtime from Microsoft.
- **Node.js** 18+.
- **CMake** — `winget install Kitware.CMake` (builds `whisper.cpp`).
- **libclang** (for `bindgen`) — easiest without admin: `pip install --user libclang`.
  Alternatively install LLVM (`winget install LLVM.LLVM`, requires admin).

Don't want to install CMake/libclang right now? Skip Whisper for a session with
`./scripts/dev-windows.ps1 -NoWhisper` (recording still works, no transcription).

### Setup

From the repo root, in PowerShell:

```powershell
./scripts/setup-windows.ps1   # installs sqlx-cli, creates the compile-time dev DB + migrations
npm install
./scripts/dev-windows.ps1     # auto-discovers libclang.dll, runs `tauri dev`
```

`setup-windows.ps1` creates `src-tauri/alfred_dev.db` and runs the migrations so
the compile-time `sqlx::query!` macros can verify against the schema. That DB is
used only at build time — at runtime the app creates its own database in the
Windows app-data directory (`%APPDATA%\com.alfred.app`).

The first build is slow (it compiles whisper.cpp). The CPU backend works on any
machine. To use your GPU instead (CUDA/Vulkan), enable the matching `whisper-rs`
feature in `src-tauri/Cargo.toml` and install that SDK — not covered here.

### Model

The `small` model is **bundled into release builds** (see "Packaging" below) —
it works offline from the first launch, no download needed. In dev, if it's not
already fetched, download it from **Settings → Transcription** (or run
`./scripts/fetch-whisper-model.ps1` to fetch it into `src-tauri/models/` ahead of
time). Models are cached in `%APPDATA%\com.alfred.app\models\`.

### Packaging (release build)

```powershell
./scripts/build-windows.ps1
```

Fetches the `small` model into `src-tauri/models/` (skipped if already present —
that path is gitignored, so every machine fetches it once), then runs
`tauri build`. Installers land in `src-tauri\target\release\bundle\` (`msi\`
and/or `nsis\`). Authenticode signing is not set up yet (spec/12/ROADMAP Phase E).

## Running on macOS

Whisper is on by default here too (needs cmake + Xcode CLT, both already
required for macOS builds).

```bash
npm install
npm run tauri:dev                 # dev, with Whisper
./scripts/fetch-whisper-model.sh  # optional: pre-fetch the `small` model into src-tauri/models/
./build-macos.sh                  # release build (.app + .dmg), fetches + bundles `small`, then builds
```

## Audio system capture (spec/03)

- **Windows:** `system_only` / `mixed` recording sources are implemented via
  WASAPI loopback — no extra setup needed.
- **macOS:** not implemented yet (ScreenCaptureKit helper, tracked separately).
  `system_only`/`mixed` return an error; use `mic_only`.

## Known Windows follow-ups

- **Ingest ("run Claude" feature):** resolves the `claude` CLI from PATH; a
  `.cmd` shim may not resolve. Only affects the manual ingest action.
