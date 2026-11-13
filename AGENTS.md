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

# Model calls

The topic service calls models only through `ModelProxy` in `src/model.ts`, which
uses the Responses API of a CLIProxyAPI instance (`OPENAI_BASE_URL`,
`OPENAI_API_KEY`). Tests replace it with a fake layer and need no proxy. Running
the topic server, `scripts/+thumbnail-quotes.ts` or `scripts/+comment-title-check.ts`
spends the proxy's Codex usage limits.

`preview-episode` transcribes voices through the OpenAI API itself
(`Transcriber` in `src/transcription.ts`, `OPENAI_TRANSCRIPTION_API_KEY`). That
key is restricted to `/v1/audio` and is never sent to the proxy; each new voice
costs money once, then its transcript is read from `DATA_DIR/transcripts`. It also
asks `ModelProxy` whether common words listed in `assets/names.json` stand for
names, once per occurrence (`DATA_DIR/transcripts/*.names.json`).
