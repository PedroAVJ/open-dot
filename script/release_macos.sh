#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --tag vX.Y.Z-preview.N --identity <Developer-ID-name-or-SHA1> --notary-profile <keychain-profile> [--keychain <path>] [--publish]"
}
tag=""
identity=""
notary_profile=""
signing_keychain=""
publish=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag|--identity|--notary-profile|--keychain)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --tag) tag="$2" ;;
        --identity) identity="$2" ;;
        --notary-profile) notary_profile="$2" ;;
        --keychain) signing_keychain="$2" ;;
      esac
      shift 2 ;;
    --publish) publish=true; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-preview\.[0-9]+$ ]] || [ -z "$identity" ] || [ -z "$notary_profile" ]; then
  usage >&2
  exit 2
fi
short_version="${BASH_REMATCH[1]}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
bun ./script/check_dependencies.ts

# Apple Development and Apple Distribution signatures cannot pass this release gate.
identity_args=(find-identity -v -p codesigning)
if [ -n "$signing_keychain" ]; then identity_args+=("$signing_keychain"); fi
signing_sha="$(security "${identity_args[@]}" | python3 -c '
import re, sys
matches = [(sha, name) for sha, name in re.findall(r"([A-F0-9]{40}) \"([^\"]+)\"", sys.stdin.read())
           if name.startswith("Developer ID Application:") and sys.argv[1] in (sha, name)]
if len(matches) != 1:
    sys.exit("A valid Developer ID Application certificate and private key matching --identity are required.")
print(matches[0][0])
' "$identity")"
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or set aside Open Dot changes before releasing." >&2
  exit 1
fi
source_commit="$(git rev-parse HEAD)"
fork_commit="$(git -C ../f rev-parse HEAD)"
platform_commit="$(git -C ../f/bend2/std/F rev-parse HEAD)"
if $publish; then
  if [ "$source_commit" != "$(git ls-remote origin refs/heads/main | cut -f1)" ] ||
     [ "$fork_commit" != "$(git -C ../f ls-remote origin refs/heads/main | cut -f1)" ]; then
    echo "Push both source commits to main before publishing." >&2
    exit 1
  fi
  if [ -n "$(git ls-remote origin "refs/tags/$tag")" ]; then
    echo "Use a new release tag; $tag already exists." >&2
    exit 1
  fi
fi
xcrun notarytool history --keychain-profile "$notary_profile" --output-format json >/dev/null
mkdir -p dist
release_dir="$(mktemp -d "$project_root/dist/release-${tag}.XXXXXX")"
build_root="$release_dir/work/open-dot"
mkdir -p "$build_root" "$release_dir/work/f"
# Build committed snapshots so unrelated local fork edits cannot enter a release.
git archive "$source_commit" | tar -x -C "$build_root"
git -C ../f archive "$fork_commit" | tar -x -C "$release_dir/work/f"
mkdir -p "$release_dir/work/f/bend2/std/F"
git -C ../f/bend2/std/F archive "$platform_commit" | tar -x -C "$release_dir/work/f/bend2/std/F"
(cd "$build_root" && BEND="$release_dir/work/f/bend2/main.ts" bun ../f/bend2/main.ts macos_system build)
app_bundle="$release_dir/Dot.app"
ditto "$build_root/dist/mac.macos/Dot.app" "$app_bundle"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $short_version" "$app_bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date +%s)" "$app_bundle/Contents/Info.plist"
signing_args=(--force --options runtime --timestamp --sign "$signing_sha")
if [ -n "$signing_keychain" ]; then
  signing_args+=(--keychain "$signing_keychain")
  original_keychains="$(security list-keychains -d user)"
  restore_args=(list-keychains -d user -s)
  search_args=(list-keychains -d user -s "$signing_keychain")
  while IFS= read -r chain; do
    restore_args+=("$chain")
    if [ "$chain" != "$signing_keychain" ]; then search_args+=("$chain"); fi
  done < <(printf '%s\n' "$original_keychains" | sed 's/^[[:space:]]*"//;s/"$//')
  restore_keychains() { security "${restore_args[@]}"; }
  trap restore_keychains EXIT
  # codesign needs the private key's keychain in the search list even with --keychain.
  security "${search_args[@]}"
fi
codesign "${signing_args[@]}" "$app_bundle"
if [ -n "$signing_keychain" ]; then restore_keychains; trap - EXIT; fi
codesign --verify --deep --strict "$app_bundle"
codesign --display --verbose=4 "$app_bundle" 2>"$release_dir/signature.txt"
rg -q '^Authority=Developer ID Application:' "$release_dir/signature.txt"
rg -q '^Timestamp=' "$release_dir/signature.txt"
rg -q 'flags=.*\(runtime\)' "$release_dir/signature.txt"
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$release_dir/notary-submission.zip"
xcrun notarytool submit "$release_dir/notary-submission.zip" \
  --keychain-profile "$notary_profile" --wait --timeout 15m --output-format json >"$release_dir/notary-result.json"
python3 - "$release_dir/notary-result.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
print("Notarization:", result.get("id"), result.get("status"))
if result.get("status") != "Accepted":
    sys.exit("Apple did not accept this submission. Inspect the notarytool log before releasing.")
PY
xcrun stapler staple "$app_bundle"
xcrun stapler validate "$app_bundle"
codesign --verify --deep --strict "$app_bundle"
spctl --assess --type execute --verbose=4 "$app_bundle" 2>"$release_dir/gatekeeper.txt"
rg -q '^source=Notarized Developer ID$' "$release_dir/gatekeeper.txt"
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$release_dir/Dot-macOS-arm64.zip"
(cd "$release_dir" && shasum -a 256 Dot-macOS-arm64.zip >SHA256SUMS)
cat >"$release_dir/release-notes.md" <<EOF
Native macOS preview with a resizable window, the conversation UI and native text editing.

Download \`Dot-macOS-arm64.zip\`, unzip it, move \`Dot.app\` into Applications and open it. Requires Apple silicon and macOS 14 or later.

Signed with Developer ID, notarized by Apple, and verified by Gatekeeper. The notarization ticket is included in the app.

Replies remain the placeholder \`…\`. Codex/Claude transport is not connected. Calls, attachments and dictation show availability notices. Conversation state lasts for the current run.

Built from [Open Dot ${source_commit:0:7}](https://github.com/PedroAVJ/open-dot/commit/$source_commit) using [Bend2 fork ${fork_commit:0:8}](https://github.com/PedroAVJ/f/commit/$fork_commit). \`SHA256SUMS\` contains the ZIP checksum.
EOF
echo "Verified release files: $release_dir"
if $publish; then
  gh release create "$tag" "$release_dir/Dot-macOS-arm64.zip" "$release_dir/SHA256SUMS" \
    --repo PedroAVJ/open-dot --target "$source_commit" --title "Open Dot $short_version macOS preview" \
    --notes-file "$release_dir/release-notes.md" --prerelease
fi
