#!/bin/bash
set -e

export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
export MACOSX_DEPLOYMENT_TARGET=11.0
export CXXFLAGS="-mmacosx-version-min=11.0"
export CFLAGS="-mmacosx-version-min=11.0"
export SQLX_OFFLINE=true

npx tauri dev -f whisper
