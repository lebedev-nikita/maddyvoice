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

Dates are UTC; `--until` includes that whole day. Stop the worker before `history`
or `upload`. A history scan is committed atomically after every page succeeds;
repeated imports preserve the live cursor and do not duplicate recordings.
Status reads can run alongside the worker. `upload` refreshes Telegram first and
does not publish if that scan fails.

Recordings publish in Telegram message-ID and audio-index order. An earlier
recording in backoff, processing or review blocks every later one. Uploads start
privately; the worker saves the video ID, waits for processing, then confirms the
requested visibility before advancing. Publication retries inspect the same
video. Test uploads keep private visibility after restarts.

Import older history before publishing newer recordings: a new recording older
than a completed or potentially visible release is rejected. This includes a
release whose response might have been lost. Existing inconsistent queue rows
enter review. Previously public resumable sessions also require reconciliation
before the new publisher can continue.

For an explicitly authorized exception, stop the worker and run
`bun run cli catch-up --days 14 --allow-out-of-order --limit 100`.
It completes the history scan before queuing missing recordings and preserves
the live cursor. Only recordings in this batch may cross the existing publication
boundary; subsequent recordings retain normal ordering. Repeated runs preserve
existing video IDs and upload sessions. This does not reorder existing videos.

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
Raspberry Pi uses the [manual SSH deployment](deploy/README.md), which covers
both systemd services, updates, data preservation and recovery. GitHub Actions
checks pushes and pull requests; it does not deploy to the Pi.

## Topic titles from YouTube captions

With `TOPICS_URL=http://127.0.0.1:11435`, the worker names uploaded videos as
`Мэддисон <action and topic>`, without a trailing signature. Original publication
dates stay in the description.
Titles use a short direct action or `Мэддисон о <topic>`, without introductory
phrases such as “tells how”. They name the situation without revealing a punchline,
unexpected comparison result or story ending. The independent review checks
these editorial rules as well as factual support.
It waits at least one hour after the original Telegram post before reading
comments or generating a topic, and at least 15 minutes after upload for serving
Russian captions, preferring YouTube's automatic ASR track. Captions are fetched
through the official authenticated API, not a public transcript scraper.

Run the topic service separately under an account already logged into Codex and
`tg`. Select its existing Telegram profile explicitly:

```sh
codex login status
export TG_PROFILE=personal
bun run topics
```

It uses `gpt-6-luna` to filter comment noise and `gpt-6.1-sol` for nickname extraction,
titles and independent review,
through the saved Codex ChatGPT login, with no transcription
API key. This uses that account's Codex limits. The transcript and selected comment
bodies are sent to OpenAI;
YouTube credentials and upload session URLs are excluded. Codex receives an empty
workspace, a read-only sandbox, disabled shell/browser/app tools, and a required
JSON response schema. Its user configuration and persistent session history are
not loaded. The topic endpoint listens only on `127.0.0.1:11435`.

After the hour has passed, the topic service verifies the source post's ID and
publication time through `tg`, then reads its earliest 500 comments, or all
available comments if fewer. It does not wait for 500 comments. Since `tg` pages
from newest to oldest, the reader walks to the beginning of the thread before
selecting the first 500; an incomplete scan is retried. Empty bodies count toward
the limit but are excluded from model input. Commenter names and usernames are
discarded.

Luna first selects useful comment IDs in batches of up to 100 text bodies.
It retains possible nicknames and ambiguous comments; selected texts stay unchanged.
Sol identifies nickname spellings in batches of up to 50 selected bodies;
the application finds their exact quotes and comment IDs in the original texts.
Each stage runs at most two isolated calls concurrently and combines all results
before proceeding. Failed filtering or extraction retries the title instead of
using an incomplete sample.
Candidates need literal quoted evidence in at least two distinct comment bodies;
copied bodies count once. A fresh model call combines candidates with the captions
to produce the topic, with a speech quote and supporting comment IDs for each
adopted nickname. This path has no web search or people registry.
Only literal comment spellings count toward candidate support; common Russian
case forms are allowed when placing that supported nickname in a title.
Comments help identify people and spell nicknames; the speech remains the source for the topic
and claims. Raw comments are not stored by the application.

Before saving a topic, a separate isolated model call checks its meaning against
the complete speech transcript. It sees only the transcript and final title,
without comments, generation evidence or previous verdicts. Each approved claim
requires an exact speech quote. An unsupported meaning triggers a fresh generation,
up to three attempts; the rejection is not fed back as a suggested answer.
Invalid draft structure or reviewer evidence also refuses approval and counts
toward this limit. Repeated nickname candidates are merged without counting the
same comment twice. Model transport and usage errors use the normal retry queue.
If no topic passes, the title stays queued for the existing retry schedule.
This check also applies to topics generated through the registry fallback.
`TOPIC_FILTER_MODEL`, `TOPIC_MODEL`, `TOPIC_EXTRACT_MODEL` and `TOPIC_REVIEW_MODEL`
configure the four roles. The reviewer uses medium reasoning; filtering, extraction and generation use low
reasoning, and every call starts an isolated session.

Titles should name internet personalities when they are the main subject. If
comments are closed, empty or contain no supported candidates, the existing
registry generator is used. Telegram read failures leave the title queued instead
of triggering that fallback. In the registry path, Codex can use web search to
check uncertain nicknames against official profiles and
channels, using only the nickname and minimal context in queries. Search results
may clarify identity and spelling; the transcript remains the source for the
topic and claims. Ambiguous identities are omitted rather than guessed.

Confirmed spellings and contextual ASR aliases live in `assets/people.json`.
Set `PEOPLE_FILE` to a writable copy to maintain the registry separately from
deployments. It is validated and reloaded for every request, without a service
restart. The initial entry is Зио, confirmed by the user; the short alias Зи
requires a contextual hint from the same transcript quote. Aliases are never
globally replaced in transcripts. The app supplies matching transcript quotes,
Codex selects registry IDs, and the app inserts canonical nicknames into
`Мэддисон о <Names>: <topic>` titles. Without selected names it uses
`Мэддисон о <topic>`.
Unknown, ambiguous or unsupported IDs and duplicated author names are rejected.

New names are collected automatically as unconfirmed proposals under
`TOPICS_DATA_DIR/people-candidates/`, with a short transcript quote, suggested
spelling and any profile links found by Codex. Repeated identical proposals reuse
the same file. These files retain excerpts after the full transcript is discarded;
delete reviewed proposals when no longer needed. Source links are research leads,
not verified evidence. Review them against official profiles and the recording
before adding an entry or alias to `PEOPLE_FILE`, including `sources` and
`verifiedAt`. Keep short or ambiguous aliases conditional on distinguishing
context. In the registry path, unconfirmed names are excluded until reviewed;
the generator continues using a specific topic without the name. Comment-supported
names can be used without adding a registry entry. A review is
needed only for new identities or aliases, not for each video. The service never
rewrites confirmed entries from its own guesses.

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
bun run cli titles --limit 10 --now  # ignores retries; still respects the hour and daily quota
bun run cli status                 # includes title states and errors
```

To test comment-assisted titles without changing YouTube, use an existing `tg`
login and a UTF-8 speech transcript:

```sh
cat transcript.txt | bun scripts/+comment-title-check.ts \
  --profile personal --channel @maddysontg --post POST_ID \
  --transcript /dev/stdin --output data/comment-title-check.json --repetitions 3
```

The experiment reads at most 100 comments and refuses incomplete threads.
Only comment bodies are passed to extraction; author metadata is discarded.
Candidates need exact supporting quotes, and at least two distinct comment
bodies before title generation can use them. Each generation and semantic check gets a fresh Codex
session with no web search, repository access, people registry or conversation
history. Transcript-only and candidate-assisted runs use the same title prompt.
Input and prompt hashes are recorded before model calls; a report path cannot be
reused. Raw comments and transcripts stay in memory. Reports contain candidate
names, evidence IDs, rejection counts and all title outcomes, including the
original generated titles, independent semantic verdicts and validation errors.
Reports retain the short speech quotes cited by the reviewer.
The experiment uses the production finalization and review logic, including at
most three generations after semantic rejections. No expected title or prior
review is passed to either model. Use
`--source-video VIDEO_ID` to record transcript provenance without passing the
video ID to the model.
No expected answer is sent to either model stage. This is an experimental
command, separate from the production title worker.

YouTube does not guarantee automatic captions. Until a usable Russian track is
available, the video retains its initial caption/date title and the app retries.

New metadata generations also select search tags from the full captions, including
all clearly named people, brands, platforms, works and places. Tags use one word,
occasionally two, and neutral language. Reviewed titles and the confirmed people
registry supply corrected spellings for caption errors. Tags are
saved with the topic and thumbnail quote before the transcript is discarded, then
added to the video's existing YouTube tags alongside the title update. Duplicates
are removed and the combined list respects YouTube's tag length limit. `cli status`
includes the saved tags. Use `titles --regenerate` to generate tags for videos
whose metadata was already processed.

## Thumbnail quotes and PNGs

New topic generations also select a one-to-four-word continuous excerpt of the
original speech for a thumbnail. A separate model call checks the complete speech
for meaning, tone and spoilers; gratitude should remain positive. Literal matching
and word limits are enforced before approval. The topic and approved quote are
saved together before the full transcript is discarded. Existing applied titles
are preserved; `titles --regenerate` requests new metadata explicitly.

For automatically managed titles, the metadata worker renders and uploads the
approved quote as a 1280×720 thumbnail before marking the work complete. Images
remain under `DATA_DIR/thumbnails/`. Failed renders or uploads use the persisted
metadata retry queue without regenerating the quote or blocking video uploads.
Confirmed quotes are checkpointed in BoxDB and shown by `cli status`; title-only
format updates retain the confirmed thumbnail. Manually managed titles are skipped.
Completed metadata with a saved quote is queued for its missing thumbnail without
downloading captions or generating metadata again. Videos without a saved quote
can be updated with an explicit batch below.

To generate quotes from saved transcripts without changing YouTube, provide a
JSON object with `rows`, each containing `video`, `originalTitle` and `transcript`:

```sh
bun scripts/+thumbnail-quotes.ts --source sources.json --output data/thumbnail-quotes
bun scripts/+render-thumbnails.ts --quotes data/thumbnail-quotes/quotes.json --output data/thumbnails
```

The first command uses the production quote generator and independent review,
saving each approved result and input/prompt hashes. It sends no expected answer
to the model. The second renders 1280×720 PNGs with FFmpeg and the bundled Oswald
font, without a browser. FFmpeg needs `drawtext` and `geq`; select a suitable build
with `FFMPEG_PATH`. Rendering is sequential and limits FFmpeg to two threads.
These commands create local files. To update an explicit batch of existing videos,
run `bun run thumbnail:apply --manifest data/thumbnail-batch/manifest.json`.
The manifest contains `channelId` and `rows` with `jobId`, `video` and `sha256`;
PNGs live at `images/<video>.png` beside it. The uploader verifies the destination
channel, recording markers and fingerprints, then checkpoints each confirmed
update in `progress.json`. Resume with the same immutable manifest after failures.
Exit status 75 means a transient error (including quota exhaustion); 78 requires
operator review. Only the thumbnails endpoint is used for these updates.
Generated quotes, PNGs and archives belong under the ignored `data/` directory.

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
