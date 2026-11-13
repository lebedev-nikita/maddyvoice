# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Publication state

Persist resumable YouTube session URLs before sending video bytes. An expired
session with an uncertain outcome requires reconciliation, never a fresh upload.
Keep live polling's high-water mark independent from historical imports.

Publish only the earliest unfinished `(message_id, audio_index)` recording.
Backoff, review and YouTube processing block all later recordings. Stage uploads
privately, persist their YouTube IDs, then confirm visibility before advancing.
History imports share the publisher lock and commit only complete scans. Reject
new recordings older than a completed or potentially visible publication.

Recordings after `sources.episodes_after` are published as episodes: runs of
recordings with less than six hours between them, formed only once six hours of
silence follow the last. An episode is one publication under its first
recording (`episode_id = id`); the others are completed in the same transaction
and are never published, retried or resolved on their own. A recording waiting
for its episode to close blocks every later one. Keep transcripts: they are paid
for and live in the `transcripts` table.

# Model calls

The topic service calls models only through `ModelProxy` in `src/model.ts`, which
uses the Responses API of a CLIProxyAPI instance (`OPENAI_BASE_URL`,
`OPENAI_API_KEY`). Tests replace it with a fake layer and need no proxy. Running
the topic server, `scripts/+thumbnail-quotes.ts` or `scripts/+comment-title-check.ts`
spends the proxy's Codex usage limits.

Episodes are transcribed, titled and described by the worker itself, and
`preview-episode` does the same locally. Both call `ModelProxy` directly
(`OPENAI_BASE_URL`, `OPENAI_API_KEY`) for the title, chapters, thumbnail quote,
tags and the verdicts on common words that may be names, so every episode spends
the proxy's limits. The worker also extracts names from the author's unread text
posts around each episode through it (`NameAdditions` in `src/name-additions.ts`);
the preview does not. Voices are transcribed through the OpenAI API itself
(`Transcriber` in `src/transcription.ts`, `OPENAI_TRANSCRIPTION_API_KEY`). That
key is restricted to `/v1/audio` and is never sent to the proxy. Each new voice
costs money once: the worker keeps its transcript in BoxDB, the preview in
`DATA_DIR/transcripts/<model>`.
