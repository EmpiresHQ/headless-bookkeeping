#!/usr/bin/env bash
# Host test runner for the AccountingHelper library (macOS host build).
#
# Why this exists: the environment has Command Line Tools (Swift 6.3) but NOT full
# Xcode. swift-testing's Testing.framework + lib_TestingInterop.dylib ship with CLT
# but are NOT on the default framework/rpath search path, so a bare `swift test`
# fails to dlopen Testing at runtime. This wrapper injects the search paths.
#
# CI (full Xcode / iOS simulator) should use `xcodebuild test` instead; there the
# iOS-only (#if os(iOS)) code and the SIMULATOR-ONLY tests are exercised.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FWK="/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
LIB="/Library/Developer/CommandLineTools/Library/Developer/usr/lib"
cd "$HERE"
exec swift test \
  -Xswiftc -F -Xswiftc "$FWK" \
  -Xlinker -F -Xlinker "$FWK" \
  -Xlinker -rpath -Xlinker "$FWK" \
  -Xlinker -rpath -Xlinker "$LIB" \
  "$@"
