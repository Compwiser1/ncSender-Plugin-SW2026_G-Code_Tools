#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required (https://stedolan.github.io/jq/)." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

CURRENT_VERSION=$(jq -r '.version' manifest.json)
PLUGIN_ID=$(jq -r '.id' manifest.json)

BUMP_ARG="${1:-patch}"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_ARG" in
  major)
    NEW_VERSION="$((MAJOR + 1)).0.0"
    ;;
  minor)
    NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"
    ;;
  patch)
    NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
    ;;
  *[0-9]*.*[0-9]*.*[0-9]*)
    NEW_VERSION="$BUMP_ARG"
    ;;
  *)
    echo "Error: unrecognized argument '$BUMP_ARG'. Use patch, minor, major, or X.Y.Z." >&2
    exit 1
    ;;
esac

echo "Plugin:  $PLUGIN_ID"
echo "Current: $CURRENT_VERSION"
echo "New:     $NEW_VERSION"
read -r -p "Proceed? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

TMP_MANIFEST=$(mktemp)
jq --arg v "$NEW_VERSION" '.version = $v' manifest.json > "$TMP_MANIFEST"
mv "$TMP_MANIFEST" manifest.json

if [ ! -f latest_release.md ]; then
  echo "## v${NEW_VERSION}" > latest_release.md
  echo "" >> latest_release.md
  echo "- " >> latest_release.md
else
  {
    echo "## v${NEW_VERSION}"
    echo ""
    echo "- "
    echo ""
    cat latest_release.md
  } > latest_release.md.tmp
  mv latest_release.md.tmp latest_release.md
fi

"${EDITOR:-nano}" latest_release.md

git add manifest.json latest_release.md
git commit -m "chore: create new release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo ""
echo "Ready to push. This will trigger the release-build.yml workflow."
read -r -p "Push commit and tag now? [y/N] " PUSH_CONFIRM
if [ "$PUSH_CONFIRM" = "y" ] || [ "$PUSH_CONFIRM" = "Y" ]; then
  git push
  git push origin "v${NEW_VERSION}"
  echo "Pushed. Check the Actions tab on GitHub for the release build."
else
  echo "Not pushed. Run 'git push && git push origin v${NEW_VERSION}' when ready."
fi
