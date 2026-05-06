#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# glnc CLI installer
# ------------------------------------------------------------------------------
# What:    Downloads, verifies, and installs the `glnc` CLI binary.
# Use:     curl -fsSL https://.../install.sh | bash
#          (or: bash install.sh)
#
# Supported platforms:
#   - macOS (darwin) on arm64 or x64
#   - Linux on arm64 or x64
#
# Environment variables:
#   GLNC_VERSION       Pin a release (e.g. v1.2.3). Default: latest.
#   GLNC_INSTALL_DIR   Install dir override. Default: ~/.local/bin or
#                      /usr/local/bin (if writable).
#   GLNC_HELP=1        Print this help text and exit.
#   NO_COLOR=1         Disable colored output.
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  unsupported platform
#   3  missing required tool
#   4  download failure
#   5  checksum verification failure
#   6  install/verification failure
#
# Audit:
#   Always inspect this script before piping it into a shell:
#     curl -fsSL <url>/install.sh -o install.sh
#     less install.sh
#     bash install.sh
#
# Security:
#   - HTTPS-only downloads with TLS >= 1.2
#   - Mandatory SHA256 verification via `shasum -c` / `sha256sum -c`
#   - No sudo auto-elevation
#   - No mutation of shell rc files
# ------------------------------------------------------------------------------

set -euo pipefail

# ---- Constants ---------------------------------------------------------------
REPO_OWNER="aryarahimi1"
REPO_NAME="glnc"
RELEASES_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
LATEST_API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
DOCS_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}#readme"

# ---- Output helpers ----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET="$(printf '\033[0m')"
    C_BLUE="$(printf '\033[34m')"
    C_YELLOW="$(printf '\033[33m')"
    C_RED="$(printf '\033[31m')"
    C_GREEN="$(printf '\033[32m')"
else
    C_RESET=""; C_BLUE=""; C_YELLOW=""; C_RED=""; C_GREEN=""
fi

info()  { printf '%s[info]%s  %s\n'  "$C_BLUE"   "$C_RESET" "$*"; }
warn()  { printf '%s[warn]%s  %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
error() { printf '%s[error]%s %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; }
ok()    { printf '%s[ok]%s    %s\n'  "$C_GREEN"  "$C_RESET" "$*"; }

print_help() {
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- Banner ------------------------------------------------------------------
if [ -t 1 ]; then
    printf '%s\n' "  glnc installer"
    printf '%s\n' "  ---------------"
fi

# ---- argv / help -------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        -h|--help|help) GLNC_HELP=1 ;;
    esac
done
if [ "${GLNC_HELP:-0}" = "1" ]; then
    print_help
    exit 0
fi

# ---- Required tools ----------------------------------------------------------
need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        error "required command not found: $1"
        exit 3
    fi
}
need_cmd curl
need_cmd tar
need_cmd uname
need_cmd mktemp

SHA_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
else
    error "neither sha256sum nor shasum is installed; cannot verify download"
    exit 3
fi

# ---- Workdir + cleanup -------------------------------------------------------
WORKDIR="$(mktemp -d 2>/dev/null || mktemp -d -t glnc-install)"
cleanup() {
    if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then
        rm -rf "$WORKDIR"
    fi
}
trap cleanup EXIT INT TERM HUP

# ---- Detect OS / arch --------------------------------------------------------
uname_s="$(uname -s)"
case "$uname_s" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux"  ;;
    *)
        error "unsupported OS: $uname_s (only darwin and linux are supported)"
        exit 2
        ;;
esac

uname_m="$(uname -m)"
case "$uname_m" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64"   ;;
    *)
        error "unsupported architecture: $uname_m (need arm64 or x64)"
        exit 2
        ;;
esac

info "platform: ${OS}-${ARCH}"

# Intel macOS support is planned for v1.1; v1.0.x ships only darwin-arm64.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
    error "Intel macOS isn't supported in v1.0.x. Apple Silicon (M1+) only."
    error "Track v1.1 progress: https://github.com/aryarahimi1/glnc/issues"
    exit 2
fi

# ---- curl wrapper ------------------------------------------------------------
CURL_OPTS=(--fail --location --proto =https --tlsv1.2 --silent --show-error)
fetch() {
    # fetch URL OUTPUT_FILE [MAX_BYTES]
    if [ -n "${3:-}" ]; then
        if ! curl "${CURL_OPTS[@]}" --max-filesize "$3" -o "$2" "$1"; then
            error "download failed: $1"
            exit 4
        fi
    else
        if ! curl "${CURL_OPTS[@]}" -o "$2" "$1"; then
            error "download failed: $1"
            exit 4
        fi
    fi
}

# ---- Resolve version ---------------------------------------------------------
VERSION="${GLNC_VERSION:-}"
if [ -z "$VERSION" ]; then
    info "resolving latest release..."
    api_response="$WORKDIR/release.json"
    fetch "$LATEST_API_URL" "$api_response" 1048576
    # Parse `"tag_name": "v1.2.3"` without jq.
    VERSION="$(
        sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$api_response" \
            | head -n1
    )"
    if [ -z "$VERSION" ]; then
        error "could not parse latest release tag from GitHub API"
        exit 4
    fi
fi

case "$VERSION" in
    v*) : ;;
    *)  VERSION="v${VERSION}" ;;
esac
info "version: ${VERSION}"

# ---- Choose install dir ------------------------------------------------------
INSTALL_DIR=""
NOT_ON_PATH_WARNING=0

path_contains() {
    # path_contains DIR  -> 0 if DIR is in $PATH
    case ":${PATH:-}:" in
        *":$1:"*) return 0 ;;
        *)        return 1 ;;
    esac
}

if [ -n "${GLNC_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$GLNC_INSTALL_DIR"
elif [ -d "${HOME}/.local/bin" ] || path_contains "${HOME}/.local/bin"; then
    INSTALL_DIR="${HOME}/.local/bin"
elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    INSTALL_DIR="/usr/local/bin"
else
    INSTALL_DIR="${HOME}/.local/bin"
    NOT_ON_PATH_WARNING=1
fi

mkdir -p "$INSTALL_DIR"

if ! path_contains "$INSTALL_DIR"; then
    NOT_ON_PATH_WARNING=1
fi

if [ ! -w "$INSTALL_DIR" ]; then
    error "install dir is not writable: $INSTALL_DIR"
    error "re-run with GLNC_INSTALL_DIR=/some/writable/path, or chown the dir."
    exit 6
fi

info "install dir: $INSTALL_DIR"

# ---- Download artifact + checksum file ---------------------------------------
TARBALL="glnc-${OS}-${ARCH}.tar.gz"
BIN_NAME_IN_TAR="glnc-${OS}-${ARCH}"
BASE_URL="${RELEASES_URL}/${VERSION}"

info "downloading ${TARBALL}..."
fetch "${BASE_URL}/${TARBALL}"     "${WORKDIR}/${TARBALL}"
info "downloading SHA256SUMS..."
fetch "${BASE_URL}/SHA256SUMS"     "${WORKDIR}/SHA256SUMS"

# ---- Verify checksum ---------------------------------------------------------
# Extract the line for our tarball into a fresh file so `-c` only checks ours.
SUM_LINE_FILE="${WORKDIR}/SHA256SUMS.glnc"
# Match "<hash>  <file>" or "<hash> *<file>".
grep -E "( |\*)${TARBALL}\$" "${WORKDIR}/SHA256SUMS" > "$SUM_LINE_FILE" || true
if [ ! -s "$SUM_LINE_FILE" ]; then
    error "no SHA256SUMS entry found for ${TARBALL}"
    exit 5
fi

info "verifying checksum..."
(
    cd "$WORKDIR"
    # shellcheck disable=SC2086
    if ! $SHA_CMD -c "$(basename "$SUM_LINE_FILE")" >/dev/null 2>&1; then
        error "SHA256 verification failed for ${TARBALL}"
        exit 5
    fi
)
ok "checksum verified"

# ---- Extract -----------------------------------------------------------------
info "extracting..."
EXTRACT_DIR="${WORKDIR}/extract"
mkdir -p "$EXTRACT_DIR"
# Pre-scan: reject absolute paths or path-traversal entries before extracting.
if tar -tzf "${WORKDIR}/${TARBALL}" | grep -E '^/|(^|/)\.\.(/|$)' >/dev/null 2>&1; then
    error "tarball contains unsafe paths (absolute or ..)"
    exit 6
fi
tar -xzf "${WORKDIR}/${TARBALL}" -C "$EXTRACT_DIR" \
    --no-same-owner --no-same-permissions

SRC_BIN="${EXTRACT_DIR}/${BIN_NAME_IN_TAR}"
if [ ! -f "$SRC_BIN" ]; then
    # Some archives may flatten differently; fall back to a search.
    SRC_BIN="$(find "$EXTRACT_DIR" -maxdepth 3 -type f ! -type l -name "${BIN_NAME_IN_TAR}" | head -n1)"
fi
if [ -z "${SRC_BIN:-}" ] || [ ! -f "$SRC_BIN" ]; then
    error "binary ${BIN_NAME_IN_TAR} not found in tarball"
    exit 6
fi

chmod +x "$SRC_BIN"

# ---- Install (idempotent: overwrite via temp + mv) ---------------------------
DEST="${INSTALL_DIR}/glnc"
# mktemp guarantees a non-predictable, non-pre-existing path; defends against
# symlink races if INSTALL_DIR happens to be world-writable.
TMP_DEST="$(mktemp "${INSTALL_DIR}/.glnc.install.XXXXXX")"
cp "$SRC_BIN" "$TMP_DEST"
chmod +x "$TMP_DEST"
mv -f "$TMP_DEST" "$DEST"

# ---- macOS: clear quarantine attribute --------------------------------------
if [ "$OS" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
    if xattr "$DEST" 2>/dev/null | grep -q '^com\.apple\.quarantine$'; then
        if ! xattr -d com.apple.quarantine "$DEST" 2>/dev/null; then
            warn "could not remove macOS quarantine attribute automatically."
            warn "run manually: xattr -d com.apple.quarantine \"$DEST\""
        else
            info "removed macOS quarantine attribute"
        fi
    fi
fi

# ---- Verify install ----------------------------------------------------------
if ! "$DEST" --version >/dev/null 2>&1; then
    error "installed binary at $DEST failed to run (--version)"
    exit 6
fi
INSTALLED_VERSION="$("$DEST" --version 2>/dev/null | head -n1 || true)"

ok "installed glnc to $DEST"
if [ -n "$INSTALLED_VERSION" ]; then
    info "$INSTALLED_VERSION"
fi

if [ "$NOT_ON_PATH_WARNING" = "1" ]; then
    warn "$INSTALL_DIR is not on your \$PATH."
    warn "add this to your shell profile (do NOT let this script do it for you):"
    warn "    export PATH=\"$INSTALL_DIR:\$PATH\""
fi

printf '\nNext: %sglnc --help%s\nDocs: %s\n' "$C_GREEN" "$C_RESET" "$DOCS_URL"
