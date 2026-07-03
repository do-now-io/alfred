#!/bin/bash
# Build Alfred.app with Whisper local transcription
# Required: Xcode Command Line Tools, cmake

set -e

export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET=11.0
export CXXFLAGS="-mmacosx-version-min=11.0"
export CFLAGS="-mmacosx-version-min=11.0"
export SQLX_OFFLINE=true

npx tauri build -- --features whisper

APP="src-tauri/target/release/bundle/macos/Alfred.app"

echo ""
echo "✓ Built:  $APP"
echo "✓ DMG:    src-tauri/target/release/bundle/dmg/Alfred_*.dmg"
