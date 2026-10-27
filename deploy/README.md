# Raspberry Pi deployment

The production worker runs on `pibox` as `maddyvoice.service`, independently of
the Mac. It starts at boot and restarts after failure. No inbound port is needed.

| Location                                 | Purpose                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `/opt/maddyvoice`                        | Application source, dependencies and pinned ARM64 Bun  |
| `/etc/maddyvoice.env`                    | Runtime settings, mode `0640`, owner `root:maddyvoice` |
| `/var/lib/maddyvoice`                    | Private BoxDB state, authorization and rendered videos |
| `/etc/systemd/system/maddyvoice.service` | Installed copy of the service unit                     |

Data stays on the system disk's ext4 filesystem. The external exFAT media disk
is not used for database files or credentials. The service runs under its own
unprivileged account; its data directory is mode `0700` and authorization files
are mode `0600`.

## Operate

From the Mac:

```sh
ssh pibox 'sudo systemctl status maddyvoice --no-pager'
ssh pibox 'sudo journalctl -u maddyvoice -n 50 --no-pager'
ssh pibox 'sudo systemctl restart maddyvoice'
```

On the Pi, use the same environment and account for CLI operations:

```sh
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice status
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice history --since 2026-10-13 --until 2026-10-27
```

Historical imports may run beside the service. Stop the service before manual
`upload`, `run`, `titles`, `resolve` or `retry` commands. The worker lock prevents two
processes from publishing through the same database.

The Mac's LaunchAgent is uninstalled after cutover. Its retained local database
is an old copy: do not start a second production worker or copy that database
back over the Pi's current state.

## Update and recovery

Install dependencies on the Pi with its pinned Bun and
`bun install --production --frozen-lockfile`; do not copy macOS `node_modules`.
Keep source and dependencies readable by the service account and owned by root.
Install the service unit, run `sudo systemd-analyze verify` on it, then reload
systemd and restart the worker. Do not replace private runtime state during code
updates.

For a cold backup or host migration, stop the service, verify that it has exited,
and copy the complete private data directory, including any BoxDB WAL file.
Use BoxDB's conversion or backup facilities for a live snapshot. Protect backups
as credentials, and run BoxDB's full file check after restoration. Any queued
video paths must refer to the restored files; preserve upload session URLs.

If Google authorization is revoked, authorize the same channel from the Mac,
transfer only the new `youtube-auth.json` securely to the Pi, restore its owner
and mode `0600`, and restart the service. Do not expose its contents in logs.

Videos remain in `/var/lib/maddyvoice/videos`; check free space periodically.
The service's CPU and memory limits are declared in `maddyvoice.service`.

## Codex topic service

`maddyvoice-topics.service` runs the loopback topic endpoint on port `11435` as
`pi`, using the existing ChatGPT login in `/home/pi/.codex`. The publisher keeps
its separate `maddyvoice` account and private YouTube authorization. The topic
service sees the Codex directory through a private home mount; it shares the
original auth file so credential refreshes are not forked into competing copies.
No Codex credential is copied into the application repository or publisher data.

The pinned Codex 0.164.0 binary is installed in `/opt/maddyvoice/bin/codex`.
The service selects `gpt-6-luna`, ignores user configuration, disables tools,
uses an empty temporary workspace and requests an ephemeral JSON-only response.
It sends caption text to OpenAI through Codex and uses the account's usage limits.
It does not need Ollama, local model weights or a paid transcription key.

The publisher environment contains:

```dotenv
TOPICS_URL=http://127.0.0.1:11435
```

Operate and inspect from the Mac:

```sh
ssh pibox 'sudo systemctl status maddyvoice-topics --no-pager'
ssh pibox 'curl --fail http://127.0.0.1:11435/health'
ssh pibox 'sudo journalctl -u maddyvoice-topics -n 30 --no-pager'
ssh pibox 'sudo systemctl restart maddyvoice-topics'
```

The health route checks service readiness; generating a real title also verifies
Codex authentication and model access. If Codex login expires, log in again as
`pi` with its installed Codex CLI. Model failures leave the title queued and do
not stop Telegram polling or uploads. The transcript cache is removed after a
topic is saved; generated topics and application publication state stay in BoxDB.

Install both service units on updates and preserve `/home/pi/.codex` and
`/var/lib/maddyvoice`. Stop the publisher before a manual title batch:

```sh
sudo systemctl stop maddyvoice
sudo -u maddyvoice /opt/maddyvoice/deploy/maddyvoice titles --limit 10 --now
sudo systemctl start maddyvoice
```
