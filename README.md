# maddyvoice

Publishes new voice messages from [Maddyson's Telegram channel](https://t.me/maddysontg)
to a dedicated YouTube channel. Runs locally with Bun, Effect, BoxDB and FFmpeg.

The first scan records the current end of the feed. Subsequent scans queue only
new recordings. Historical imports are explicit and do not move that boundary.
Forwarded messages, music uploads and videos are excluded. Each voice message
becomes a 1080p H.264/AAC MP4 using its attached photos as a slideshow, or the
bundled Maddyson portrait. Every description includes separate channel and post
links, plus the original publication date and time in UTC.

## Install

Requires Bun 1.4.4+, FFmpeg/FFprobe and macOS ARM64 or Linux x64/ARM64 with
glibc 2.35+. BoxDB's native client is bundled; no database server is needed.

```sh
brew install bun ffmpeg just
bun install --frozen-lockfile
cp .env.example .env
bun run cli scan
bun run cli preview 7596
```

The preview command writes an MP4 under `data/videos/` without publishing it.
Telegram credentials are unnecessary for this public channel. Reading relies
on Telegram's public web preview; unavailable or changed markup produces an
error and preserves the live cursor rather than silently skipping posts.

## Connect a new YouTube channel

1. [Create a dedicated channel](https://www.youtube.com/channel_switcher), for
   example **Мэддисон — голосовой архив**. Channel creation is a YouTube UI
   operation; the Data API cannot create channels. If YouTube blocks creation,
   check **YouTube Studio → Settings → Channel → Feature eligibility** and follow
   [YouTube's verification instructions](https://support.google.com/youtube/answer/9891124).
2. In a [Google Cloud project](https://console.cloud.google.com/), enable
   **YouTube Data API v3**, configure Google Auth Platform's consent screen,
   and create an OAuth client with application type **Desktop app**. Download
   its client JSON outside this repository. For an External app in Testing,
   add your Google account as a test user.
3. Copy the new channel's `UC...` ID from
   [YouTube advanced settings](https://www.youtube.com/account_advanced), then run:

   ```sh
   bun run cli auth youtube --client /absolute/path/client.json --channel UCxxxxxxxxxxxxxxxxxxxxxx
   ```

4. Open the printed OAuth URL in your regular browser. Select the **new channel**
   and authorize uploads, read access and `youtube.force-ssl` for captions and
   title updates. Reauthorize an existing installation to add this scope.
   The loopback callback uses PKCE and
   state validation. Authorization is saved only if the selected channel matches
   `--channel`; future uploads verify this identity again. Optionally set
   `YOUTUBE_CHANNEL_ID` in `.env` as a second check.

The refresh token and client credentials stay in `data/youtube-auth.json` with
mode `0600`; `data/` and `.env` are ignored by Git. Keep this directory private.
No Google password is needed. Google External apps in Testing can have short-lived
refresh tokens; for unattended operation, configure the consent screen for
production as appropriate. Uploads from unaudited API projects can be restricted
to private visibility by YouTube. See the official
[OAuth guide](https://developers.google.com/youtube/data/guides/auth/installed-apps)
and [upload restrictions](https://developers.google.com/youtube/data/docs/videos/insert).

## Run and import history

```sh
bun start                                  # poll every 5 minutes and upload
bun run cli status                         # queue, failures, video IDs
bun run cli history --months 2              # queue the last two calendar months
bun run cli history --since 2026-08-27 --until 2026-10-26
bun run cli upload --limit 1 --test         # upload one queued video privately
bun run cli run --once --limit 10           # one scan and up to 10 uploads
```

Dates are UTC; `--until` includes that whole day. `history` queues recordings;
the running worker publishes them, or use `upload` after stopping the worker.
Repeated history imports do not duplicate jobs or videos. The live worker uses
a process lock; history imports and status reads can run alongside it. A test
upload counts as uploaded and will not automatically be republished publicly.
Existing upload sessions retain their initial visibility; `--test` refuses to
resume a session started with non-private visibility.

On macOS, install the background worker:

```sh
bun run cli service install
bun run cli service status
bun run cli service stop
bun run cli service start
bun run cli service uninstall
```

It runs through launchd while this Mac is awake and logged in, restarts after a
crash and starts at login. Without YouTube authorization it still queues new
voice posts and logs the missing setup. Reinstall after changing `.env` settings
to refresh launchd's environment. Logs are in `data/worker.log`; `stop` lasts until
the next login, while `uninstall` also removes the LaunchAgent. On an always-on
Linux host, run `bun start` under your normal process manager. The production
Raspberry Pi uses the [systemd deployment](deploy/README.md).

## Topic titles from YouTube captions

With `TOPICS_URL=http://127.0.0.1:11435`, the worker names uploaded videos as
`<Short topic> | Мэддисон`. Original publication dates stay in the description.
It waits at least 15 minutes for serving
Russian captions, preferring YouTube's automatic ASR track. Captions are fetched
through the official authenticated API, not a public transcript scraper.

Run the topic service separately under an account already logged into Codex:

```sh
codex login status
bun run topics
```

It uses `gpt-6-luna` through the saved Codex ChatGPT login, with no transcription
API key. This uses that account's Codex limits. The transcript is sent to OpenAI;
YouTube credentials and upload session URLs are excluded. Codex receives an empty
workspace, a read-only sandbox, disabled shell/browser/app tools, and a required
JSON response schema. Its user configuration and persistent session history are
not loaded. The topic endpoint listens only on `127.0.0.1:11435`.

Title processing runs independently of live polling and uploads. Missing captions
and temporary model failures use persisted retry delays. At most twelve caption
checks per UTC day reserve a conservative 3000-unit caption budget across restarts;
large historical imports therefore receive titles over several days. A downloaded
transcript is cached in BoxDB over model retries, then discarded when its topic
is saved. The topic is saved before changing YouTube, so a lost update response
is reconciled against the existing title. Manually edited titles are preserved.
Descriptions, privacy and video IDs are preserved during renaming.
When the title format changes, previously applied titles are queued again using
their saved topics. The previous title is retained until YouTube confirms the
change, preserving retries and manual edits without another caption download.

Stop the worker before manually processing existing videos:

```sh
bun run cli titles --limit 10
bun run cli titles --limit 10 --now  # ignore retry times; still respects daily quota
bun run cli status                 # includes title states and errors
```

YouTube does not guarantee automatic captions. Until a usable Russian track is
available, the video retains its initial caption/date title and the app retries.

## Storage and recovery

BoxDB stores the queue and live cursor in `data/maddyvoice.db` using binary WAL
storage. Videos remain under `data/videos/`; monitor disk usage for large archives.
Use BoxDB's backup/conversion facilities for a live database, including its WAL.
Executable migrations live in `db/migrations`; `db/schema.yaml` is an exported
schema, not a data backup.

Upload session URLs are committed before video bytes are sent. Interrupted
uploads query the same session and continue at YouTube's confirmed offset.
Errors use bounded exponential delays, up to 24 hours. If an expired session
has an uncertain outcome, the job enters `review` instead of starting another
upload. Stop the worker and inspect YouTube Studio, then:

```sh
# Existing video must match the destination channel and recording marker:
bun run cli resolve maddysontg-7596-0 --video VIDEO_ID

# Only after confirming that no video was uploaded:
bun run cli retry maddysontg-7596-0 --allow-new-upload

# Retry a normal transient failure without resetting the upload session:
bun run cli retry maddysontg-7596-0
```

## Development

```sh
just check
just test
just analyze
just build
```

Tests cover live catch-up, independent history imports, BoxDB deduplication,
metadata limits, upload recovery and committing sessions before network writes.
The FFmpeg smoke test verifies image order, both stream durations and codecs.
It uses generated local fixtures and makes no external requests. CI runs the
same checks. [Portrait attribution](assets/README.md).
