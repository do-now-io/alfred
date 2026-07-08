#!/bin/bash
# Deprecated: Whisper is on by default now (spec/04) — this is equivalent to
# `npm run tauri:dev`, kept for muscle memory / older docs.
set -e

export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET=11.0
export CXXFLAGS="-mmacosx-version-min=11.0"
export CFLAGS="-mmacosx-version-min=11.0"
export SQLX_OFFLINE=true

npx tauri dev
