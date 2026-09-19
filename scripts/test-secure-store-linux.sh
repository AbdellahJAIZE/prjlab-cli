#!/usr/bin/env bash
set -euo pipefail
# Run under dbus-run-session: synthetic keyring, isolated from the user's desktop.
prj_keyring_dir=$(mktemp -d)
export XDG_DATA_HOME="$prj_keyring_dir"
trap 'rm -rf "$prj_keyring_dir"' EXIT
printf '\n' | gnome-keyring-daemon --unlock --components=secrets
node scripts/test-secure-store.mjs
