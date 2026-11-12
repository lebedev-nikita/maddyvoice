default:
    @just --list

install:
    vp install --frozen-lockfile

# Prepare a new worktree from the primary checkout: its .env, then dependencies.
worktree-init $source:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -e .env || "$source" -ef . ]]; then
      echo "Keeping this checkout's .env."
    elif [[ -n "$source" && -f "$source/.env" ]]; then
      cp "$source/.env" .env
      chmod 600 .env
      echo "Copied .env from $source (mode 0600)."
    else
      echo "No .env in '$source'; copy .env.example and fill it in." >&2
    fi
    bun install --frozen-lockfile

check:
    vp check
    bunx tsgo --noEmit

test:
    vp test run
    bun scripts/+media-smoke.ts

analyze:
    bun run analyze

build:
    vp run build

run:
    vp run start

history months="2":
    vp run cli history --months {{months}}

status:
    vp run cli status

service action="status":
    vp run cli service {{action}}
