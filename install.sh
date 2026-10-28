#!/bin/sh
# bunker installer: a checkout at the latest vX.Y.Z tag, compiled to ~/.local/bin/bunker.
# Checks prerequisites (never installs them), prints the plan, asks, then installs.
#   --yes | BUNKER_INSTALL_YES=1   skip the prompt
#   --check                        only run the checks
#   --skip-runtime-check           don't require docker, gh and claude
#   --ref <ref>                    install this tag/branch/commit instead of the latest tag
#   --no-verify-tag | BUNKER_VERIFY_TAG=0   only warn when git verify-tag fails (default: refuse)
#   --uninstall                    remove the binary and checkout (never ~/.config/bunker)
# Env: BUNKER_HOME (checkout), BUNKER_BIN_DIR (binary dir), BUNKER_REPO (clone URL).
set -eu

REPO=${BUNKER_REPO:-https://github.com/dbggr/bunker.git}
HOME_DIR=${BUNKER_HOME:-$HOME/.local/share/bunker}
BIN_DIR=${BUNKER_BIN_DIR:-$HOME/.local/bin}
BIN=$BIN_DIR/bunker

yes=${BUNKER_INSTALL_YES:-0}
check_only=0
skip_runtime=0
uninstall=0
verify_tag=${BUNKER_VERIFY_TAG:-1}
ref=

while [ $# -gt 0 ]; do
  case $1 in
    --yes | -y) yes=1 ;;
    --check) check_only=1 ;;
    --skip-runtime-check) skip_runtime=1 ;;
    --verify-tag) verify_tag=1 ;;
    --no-verify-tag) verify_tag=0 ;;
    --uninstall) uninstall=1 ;;
    --ref)
      [ $# -ge 2 ] || { echo "bunker installer: --ref needs a value" >&2; exit 2; }
      ref=$2
      shift
      ;;
    -h | --help)
      sed -n '2,9p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
      exit 0
      ;;
    *) echo "bunker installer: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# confirm <question>: true if --yes, or the user answers y on the terminal.
confirm() {
  [ "$yes" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  answer=
  # Under `curl | sh` stdin is the script, so ask on the terminal.
  if { read -r answer < /dev/tty; } 2> /dev/null; then :; else echo; echo "no terminal to ask on; re-run with --yes to skip the prompt."; fi
  case $answer in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

watch_blocker() {
  lock=$HOME_DIR/.bunker/watch.lock
  [ -f "$lock" ] || return 0
  pid=$(tr -dc '0-9' < "$lock")
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
    echo "bunker installer: refused: a bunker watch (pid $pid) is running for $HOME_DIR" >&2
    exit 2
  fi
}

if [ "$uninstall" = 1 ]; then
  echo "bunker installer: this will remove"
  echo "  $BIN"
  echo "  $HOME_DIR"
  echo "and leave ~/.config/bunker alone."
  confirm "remove them?" || { echo "aborted."; exit 1; }
  watch_blocker
  rm -f "$BIN"
  rm -rf "$HOME_DIR"
  echo "removed."
  exit 0
fi

# ---- checks (read-only) ----
fail_build=0
fail_run=0
missing=

ver() { sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p' | head -n 1; }

echo "bunker installer"
# row <ok> <name> <detail> <url>
row() {
  if [ "$1" = 1 ]; then
    printf '  ✓ %s\n' "$2${3:+ $3}"
  else
    printf '  ✗ %-12s %s\n' "$2" "$4"
  fi
}

if command -v git > /dev/null 2>&1; then row 1 git "$(git --version 2> /dev/null | ver)"
else row 0 git "" https://git-scm.com/downloads; fail_build=1; missing="$missing git"; fi

if command -v bun > /dev/null 2>&1; then row 1 bun "$(bun --version 2> /dev/null | ver)"
else row 0 bun "" https://bun.sh/docs/installation; fail_build=1; missing="$missing bun"; fi

if command -v docker > /dev/null 2>&1; then
  if docker info > /dev/null 2>&1; then note="(daemon reachable)"; else note="(daemon NOT reachable)"; fi
  row 1 docker "$(docker --version 2> /dev/null | ver) $note"
  case $note in *NOT*) fail_run=1; missing="$missing a running docker daemon" ;; esac
else row 0 docker "" https://docs.docker.com/get-docker/; fail_run=1; missing="$missing docker"; fi

if command -v gh > /dev/null 2>&1; then
  if gh auth status > /dev/null 2>&1; then note="(logged in)"; else note="(NOT logged in: run gh auth login)"; fi
  row 1 gh "$(gh --version 2> /dev/null | ver) $note"
  case $note in *NOT*) fail_run=1; missing="$missing gh login" ;; esac
else row 0 gh "" https://cli.github.com/; fail_run=1; missing="$missing gh"; fi

if command -v claude > /dev/null 2>&1; then row 1 claude "$(claude --version 2> /dev/null | ver)"
else row 0 claude "" https://docs.claude.com/en/docs/claude-code/setup; fail_run=1; missing="$missing claude"; fi

if [ "$fail_build" = 1 ] || { [ "$fail_run" = 1 ] && [ "$skip_runtime" = 0 ]; }; then
  list=$(echo "$missing" | sed 's/^ //; s/ /, /g; s/\(.*\), /\1 and /')
  echo "install $list, then re-run."
  [ "$fail_build" = 0 ] && echo "(or pass --skip-runtime-check to install anyway)"
  exit 1
fi
[ "$check_only" = 1 ] && exit 0

# ---- plan ----
echo
echo "this will put a checkout of bunker (${ref:-latest release tag}) in $HOME_DIR and a compiled binary at $BIN."
echo "it creates those directories if needed, and does not edit your shell rc files."
confirm "continue?" || { echo "aborted."; exit 1; }

# ---- install ----
watch_blocker

if [ -d "$HOME_DIR/.git" ]; then
  git -C "$HOME_DIR" fetch --tags --force -q origin || echo "bunker installer: couldn't fetch from origin; using local tags" >&2
elif [ -e "$HOME_DIR" ] && [ -n "$(ls -A "$HOME_DIR" 2> /dev/null)" ]; then
  echo "bunker installer: $HOME_DIR exists and is not a git checkout (set BUNKER_HOME or remove it)" >&2
  exit 2
else
  mkdir -p "$(dirname "$HOME_DIR")"
  git clone -q "$REPO" "$HOME_DIR"
  git -C "$HOME_DIR" fetch --tags -q origin 2> /dev/null || true
fi

if [ -n "$ref" ]; then
  tag=$ref
else
  tag=$(git -C "$HOME_DIR" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 || true)
  [ -n "$tag" ] || { echo "bunker installer: no vX.Y.Z release tags found (use --ref)" >&2; exit 2; }
fi

# Release tags are signed (docs/release.md), so by default a tag without a good signature
# (git verify-tag, needs the signer's key in gpg) is refused; --no-verify-tag only warns.
if ! git -C "$HOME_DIR" verify-tag "$tag" > /dev/null 2>&1; then
  echo "bunker installer: $tag has no valid signature (git verify-tag failed)" >&2
  [ "$verify_tag" = 1 ] && { echo "bunker installer: refusing to install an unverified tag (--no-verify-tag to override)" >&2; exit 1; }
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/bunker-install.XXXXXX")
cleanup() {
  git -C "$HOME_DIR" worktree remove --force "$tmp/src" > /dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

git -C "$HOME_DIR" worktree add -q --detach "$tmp/src" "$tag" || { echo "bunker installer: couldn't check out $tag" >&2; exit 1; }
(
  cd "$tmp/src"
  bun install --frozen-lockfile
  BUNKER_BUILD_HOME=$HOME_DIR bun run build
) || { echo "bunker installer: build failed" >&2; exit 1; }
[ -f "$tmp/src/dist/bunker" ] || { echo "bunker installer: build produced no binary" >&2; exit 1; }

version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$tmp/src/package.json" | head -n 1)
mkdir -p "$BIN_DIR"
# Rename over the target: a running binary can't be overwritten, but it can be replaced.
cp "$tmp/src/dist/bunker" "$BIN.new.$$"
chmod 755 "$BIN.new.$$"
mv -f "$BIN.new.$$" "$BIN"

echo
echo "installed bunker ${version:-unknown} ($tag) at $BIN"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "$BIN_DIR is not on your PATH. add this to your shell rc file (not edited by this installer):"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo "next: cd <repo> && bunker init"
