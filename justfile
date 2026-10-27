default:
    @just --list

install:
    vp install --frozen-lockfile

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
