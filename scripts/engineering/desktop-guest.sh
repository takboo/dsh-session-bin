#!/usr/bin/env bash
set -euo pipefail

plugin_sha=$1
desktop_sha=$2
project_sha=$3
expected_version=$4
inputs='/Volumes/My Shared Files/dsh-inputs'
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
scratch=$(cd "$scratch" && pwd -P)
umask 077
hash256() { shasum -a 256 "$1" | awk '{print $1}'; }

[[ "$(uname -m)" == arm64 ]]
[[ "$(hash256 "$inputs/plugin.tgz")" == "$plugin_sha" ]]
[[ "$(hash256 "$inputs/project.tar.gz")" == "$project_sha" ]]
[[ "$(openssl dgst -sha512 -binary "$inputs/desktop.zip" | openssl base64 -A)" == "$desktop_sha" ]]

mkdir "$scratch/project" "$scratch/package" "$scratch/dsh-home" "$scratch/home"
tar -xzf "$inputs/project.tar.gz" -C "$scratch/project"
tar -xzf "$inputs/plugin.tgz" --strip-components 1 -C "$scratch/package"
# Run the existing native assertions against the exact packed dist.
mv "$scratch/package/dist" "$scratch/project/dist"
ditto -x -k "$inputs/desktop.zip" "$scratch"
app="$scratch/DeepSeek Harness.app"
codesign --verify --deep --strict "$app"
[[ "$(codesign -dv --verbose=4 "$app" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}')" == NAN929V4UM ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$expected_version" ]]

printf 'guestOS=%s guestBuild=%s arch=%s pluginSha256=%s desktopSha512=%s\n' \
  "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)" "$(uname -m)" "$plugin_sha" "$desktop_sha"
cd "$scratch/project"
export HOME="$scratch/home" DSH_HOME="$scratch/dsh-home" DSH_TELEMETRY_DISABLED=1
export DSH_SESSION_BIN_DESKTOP_SDK="$app/Contents/Resources/app.asar/dsh"
export ELECTRON_RUN_AS_NODE=1 NARB_NATIVE_CACHE_DIR="$scratch/native-cache" NARB_DISABLE_NATIVE_CACHE=0
unset NODE_OPTIONS DSH_SESSION_BIN_DESKTOP_VERIFY DSH_SESSION_BIN_PLATFORM_VERIFY
electron="$app/Contents/MacOS/DeepSeek Harness"
"$electron" --expose-internals --input-type=module -e '
  import assert from "node:assert/strict";
  import { filesystemEvidence } from "./scripts/filesystem-evidence.mjs";
  const filesystem = await filesystemEvidence(process.env.DSH_HOME);
  assert.equal(filesystem.name, "apfs");
  console.log(JSON.stringify({ fixtureFilesystem: filesystem }));
'
"$electron" --expose-internals --import ./scripts/desktop-sdk-bootstrap.mjs ./tests/helpers/desktop-runtime-worker.mjs
"$electron" --expose-internals --import ./scripts/desktop-sdk-bootstrap.mjs --test --test-concurrency=1 \
  tests/native-deletion-host.test.mjs tests/native-deletion-crash.test.mjs
