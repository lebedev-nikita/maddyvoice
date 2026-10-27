# Raspberry Pi deployment

The production worker runs on `pibox` as `maddyvoice.service`, independently of
the Mac. It starts at boot and restarts after failure. No inbound port is needed.

Deployment is manual over SSH. Pushing to `origin/main` does not update the Pi:
[GitHub Actions](../.github/workflows/check.yml) runs checks, tests, media
verification, analysis and a build, without a deployment step. There is no
deployment script or automatic pull on the Pi.

Two systemd services run the application:

- [maddyvoice.service](maddyvoice.service) polls Telegram, renders videos with
  FFmpeg, publishes to YouTube and manages title retries as `maddyvoice`.
- [maddyvoice-topics.service](maddyvoice-topics.service) generates topics through
  Codex as `pi`, listening only on `127.0.0.1:11435`.

Both run TypeScript source directly with the pinned Bun in
`/opt/maddyvoice/bin/bun`; the `dist` build is not used by the services.

| Location                                  | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `/opt/maddyvoice`                         | Application source, dependencies and pinned ARM64 Bun    |
| `/etc/maddyvoice.env`                     | Runtime settings, mode `0640`, owner `root:maddyvoice`   |
| `/etc/maddyvoice-topics.env`              | Topic service's Telegram profile and executable settings |
| `/var/lib/maddyvoice`                     | Private BoxDB state, authorization and rendered videos   |
| `/var/lib/maddyvoice-topics`              | Private topic service state                              |
| `/home/pi/.codex`                         | Existing Codex login shared with the topic service       |
| `/etc/systemd/system/maddyvoice*.service` | Installed copies of both service units                   |

Data stays on the system disk's ext4 filesystem. The external exFAT media disk
is not used for database files or credentials. The service runs under its own
unprivileged account; its data directory is mode `0700` and authorization files
are mode `0600`.

## Deploy an update

This procedure assumes the Pi is already provisioned with the SSH alias
`pibox`, sudo access, FFmpeg, pinned Bun, Codex and `tg`, and working YouTube,
Codex and Telegram authorization. It updates application code without replacing
runtime data.

A deployment preserves existing videos. To fill historical gaps across the
current publication boundary, use the explicitly authorized catch-up command
below. Existing YouTube publication dates cannot be reordered by a code update.

1. Select a reviewed commit and run the checks from that revision on the Mac:

   ```sh
   just check
   just test
   just analyze
   just build
   ```

2. Package and transfer only the runtime files. Replace the revision placeholder
   with the full commit SHA. `git archive` excludes uncommitted changes; commit
   the intended release before creating its archive.

   ```sh
   maddyvoice_revision=FULL_REVIEWED_COMMIT_SHA
   maddyvoice_bundle="$(mktemp -t maddyvoice-release)"
   git archive --format=tar.gz --output="$maddyvoice_bundle" "$maddyvoice_revision" src assets db deploy scripts package.json bun.lock
   scp "$maddyvoice_bundle" pibox:/tmp/maddyvoice-release.tar.gz
   ```

   This excludes local `data`, `.env`, `node_modules` and credentials. Keep the
   existing `/opt/maddyvoice/bin` binaries when replacing source files.

3. Connect with `ssh pibox`. Run the remaining commands on the Pi. Stop both
   services and verify they have exited; do not run manual jobs during rollout:

   ```sh
   sudo systemctl stop maddyvoice maddyvoice-topics
   ```

   Before applying schema changes, take a verified cold backup as described in
   [Recovery](#recovery). Review the release's migrations before opening its CLI.

4. Extract the release and install Linux ARM64 dependencies on the Pi:

   ```sh
   sudo tar --extract --gzip --file=/tmp/maddyvoice-release.tar.gz --directory=/opt/maddyvoice --no-same-owner
   cd /opt/maddyvoice
   sudo /opt/maddyvoice/bin/bun install --production --frozen-lockfile
   ```

   Keep application source and dependencies root-owned and readable by both
   service accounts. Do not copy macOS `node_modules` or overwrite
   `/var/lib/maddyvoice`, `/var/lib/maddyvoice-topics`, `/etc/maddyvoice.env`,
   `/etc/maddyvoice-topics.env` or
   `/home/pi/.codex` with local copies.

5. Validate and install both service units, then reload systemd:

   ```sh
   sudo systemd-analyze verify deploy/maddyvoice.service deploy/maddyvoice-topics.service
   sudo install -m 0755 deploy/tg /opt/maddyvoice/bin/tg
   sudo install -m 0644 deploy/maddyvoice.service deploy/maddyvoice-topics.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

6. Open the publisher's database with its actual account and environment, then
   start the services:

   ```sh
   sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice status
   sudo systemctl start maddyvoice-topics
   curl --fail --retry 10 --retry-delay 1 --retry-connrefused http://127.0.0.1:11435/health
   sudo systemctl start maddyvoice
   ```

   Opening BoxDB applies pending migrations automatically, including when using
   `status`. The wrapper loads `/etc/maddyvoice.env`; running `bun` directly from
   an arbitrary directory can use different settings and a different database.
   If a migration or readiness check fails, leave the publisher stopped and
   inspect the error before continuing. Verify both services and recent logs
   with the commands below. Check publication and title errors in CLI `status`.

## Operate

From the Mac:

```sh
ssh pibox 'sudo systemctl status maddyvoice --no-pager'
ssh pibox 'sudo systemctl status maddyvoice-topics --no-pager'
ssh pibox 'sudo journalctl -u maddyvoice -n 50 --no-pager'
ssh pibox 'sudo journalctl -u maddyvoice-topics -n 30 --no-pager'
ssh pibox 'curl --fail http://127.0.0.1:11435/health'
ssh pibox 'sudo systemctl restart maddyvoice'
```

On the Pi, use the same environment and account for CLI operations:

```sh
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice status
sudo systemctl stop maddyvoice
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice history --since 2026-10-13 --until 2026-10-27
sudo systemctl start maddyvoice
```

Stop the service before manual `scan`, `history`, `upload`, `run`, `titles`,
`resolve` or `retry` commands. The worker lock prevents two processes from
publishing through the same database.

The Mac's LaunchAgent is uninstalled after cutover. Its retained local database
is an old copy: do not start a second production worker or copy that database
back over the Pi's current state.

## Recovery

For a cold backup or host migration, stop both services, verify they have exited,
and copy both private state directories and `/etc/maddyvoice.env`, including any
BoxDB WAL file. Preserve the existing Codex login when migrating hosts.
Use BoxDB's conversion or backup facilities for a live snapshot. Protect backups
as credentials, and run BoxDB's full file check after restoration. Any queued
video paths must refer to the restored files; preserve upload session URLs.

For a code rollback, transfer the previous compatible Git revision using the
same deployment procedure. A code rollback does not undo database migrations
or YouTube actions. Do not restore an old database over newer upload sessions
or video IDs; reconcile external outcomes before restoring state.

If Google authorization is revoked, authorize the same channel from the Mac,
transfer only the new `youtube-auth.json` securely to the Pi, restore its owner
and mode `0600`, and restart the service. Do not expose its contents in logs.

Videos remain in `/var/lib/maddyvoice/videos`; check free space periodically.
Resource settings are declared in the service units. Memory limits require
kernel cgroup support; do not treat the declared values as a verified hard cap
on this Pi.

## Codex topic service

`maddyvoice-topics.service` runs the loopback topic endpoint on port `11435` as
`pi`, using the existing ChatGPT login in `/home/pi/.codex`. The publisher keeps
its separate `maddyvoice` account and private YouTube authorization. The topic
service sees the Codex directory through a private home mount; it shares the
original auth file so credential refreshes are not forked into competing copies.
No Codex credential is copied into the application repository or publisher data.

The pinned Codex 0.164.0 binary is installed in `/opt/maddyvoice/bin/codex`.
The model and executable are configured in the service unit;
[the Codex adapter](../src/codex.ts) defines its sandbox and search settings.
Caption text and selected comment bodies are sent to OpenAI through Codex, using
the account's usage limits.
It does not need Ollama, local model weights or a paid transcription key.

The publisher environment contains:

```dotenv
TOPICS_URL=http://127.0.0.1:11435
```

The topic service loads `/etc/maddyvoice-topics.env`. Create it with mode `0640`
and owner `root:maddyvoice`, selecting a Telegram profile already authorized for
the service's account and environment:

```dotenv
TG_PROFILE=personal
TG_PATH=/opt/maddyvoice/bin/tg
# TELEGRAM_CHANNEL=maddysontg
```

Install `tg` and its runtime dependencies on the Pi before starting this version.
The supplied wrapper uses Node at `/usr/local/bin/node` and the existing global
package under `/home/pi/.bun/install/global/node_modules`. The service binds that
package read-only and shares `pi`'s existing Telegram configuration, session,
WireCat database and cache through its private home mount. XDG paths select those
original directories; the user D-Bus address preserves keyring access. Do not set
`TG_CONFIG_DIR`, `TG_STATE_DIR` or `TG_CACHE_DIR` for this login: they change the
keyring namespace. Do not copy or recreate credentials during deployment.
`TG_PROFILE` is required; `TG_PATH` defaults to `tg` outside the example above.
If `TELEGRAM_CHANNEL` is customized, set it identically in both services.

Topics wait until the source Telegram post is at least one hour old, including
manual `titles --now` batches. The reader selects the earliest 500 comments and
passes only text bodies to nickname extraction. It verifies the original post
timestamp before reading the thread. Telegram read failures and incomplete scans
use the existing title retry queue; closed or empty threads use the registry
generator. The publisher can keep polling and uploading while titles wait.

The health route checks service readiness; generating a real title also verifies
Telegram access, Codex authentication and model access. If Codex login expires, log in again as
`pi` with its installed Codex CLI. Model failures leave the title queued and do
not stop Telegram polling or uploads. The transcript cache is removed after a
topic is saved; generated topics and application publication state stay in BoxDB.

Stop the publisher before a manual title batch:

```sh
sudo systemctl stop maddyvoice
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice titles --limit 10 --now
sudo systemctl start maddyvoice
```

To regenerate all automatically managed titles with the current model and
editorial policy, add `--regenerate --limit 100 --now` to `titles`. This preserves
the previous remote title for reconciliation and skips manually edited titles.

For an authorized two-week catch-up, keep the publisher stopped and run:

```sh
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice catch-up --days 14 --allow-out-of-order --limit 100
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice status
sudo systemctl start maddyvoice
```

The exception is persisted only on unfinished recordings found in that complete
scan. Processing, backoff and review still block later recordings. If interrupted,
resume the same queue with `upload` or the service; do not clear upload sessions.
Normal history imports and new recordings retain the publication boundary.
