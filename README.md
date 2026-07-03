# Alfred

Alfred — personal assistant desktop app (Tauri 2 + React/TypeScript).

## Running on Windows

The base app runs on Windows. Local Whisper transcription is **optional** and off
by default (see "Local transcription" below); without it, audio recording works
but recordings are not transcribed. Everything else (calendar, notes/vault,
todos, suggestions, chat) runs normally.

### Prerequisites

- **Rust** (MSVC toolchain) — install via [rustup](https://rustup.rs). Accept the
  default `x86_64-pc-windows-msvc` toolchain.
- **Visual Studio Build Tools** with the **"Desktop development with C++"**
  workload (provides the MSVC linker Rust needs).
- **WebView2 runtime** — preinstalled on Windows 11. If missing, install the
  Evergreen runtime from Microsoft.
- **Node.js** 18+.

### Setup

From the repo root, in PowerShell:

```powershell
./scripts/setup-windows.ps1   # installs sqlx-cli, creates the compile-time dev DB + migrations
npm install
npm run tauri:dev             # or ./scripts/dev-windows.ps1
```

`setup-windows.ps1` creates `src-tauri/alfred_dev.db` and runs the migrations so
the compile-time `sqlx::query!` macros can verify against the schema. That DB is
used only at build time — at runtime the app creates its own database in the
Windows app-data directory (`%APPDATA%\com.alfred.app`).

### Local transcription (Whisper, CPU) on Windows

Whisper is compiled in via the `whisper` Cargo feature, which builds `whisper.cpp`.
Extra prerequisites:

- **CMake** — `winget install Kitware.CMake`
- **libclang** (for `bindgen`) — easiest without admin: `pip install --user libclang`.
  Alternatively install LLVM (`winget install LLVM.LLVM`, requires admin).

Then run:

```powershell
./scripts/dev-whisper-windows.ps1
```

The script auto-discovers `libclang.dll` (via `LIBCLANG_PATH`, a `pip`-installed
`libclang`, or an LLVM install), sets `LIBCLANG_PATH`, and runs
`tauri dev --features whisper`. The first build is slow (it compiles whisper.cpp).

Once running, download a model in **Settings → (transcription)** — the default is
`small`. Models are cached in `%APPDATA%\com.alfred.app\models\`.

The CPU backend works on any machine. To use your GPU instead (CUDA/Vulkan),
enable the matching `whisper-rs` feature in `src-tauri/Cargo.toml` and install
that SDK — not covered here.

### Google OAuth (optional)

To enable "Sign in with Google", provide OAuth client credentials at build time
(see `.env.example`). Without them, sign-in is unavailable but the rest of the
app runs.

## Running on macOS

```bash
npm install
npm run tauri:dev                 # without Whisper
npm run tauri:dev:whisper         # with local Whisper transcription (needs cmake, Xcode CLT)
./build-macos.sh                  # release build (.app + .dmg) with Whisper
```

## Known Windows follow-ups

- **Recording robustness:** the audio capture path assumes the input device
  delivers `f32` samples; some WASAPI devices report `i16`, which would fail at
  runtime. To be hardened later.
- **Ingest ("run Claude" feature):** resolves the `claude` CLI from PATH; a
  `.cmd` shim may not resolve. Only affects the manual ingest action.
