# Chronological rebuild preparation

This destructive rebuild is an optional maintenance procedure, separate from
normal deployment and the bounded catch-up command in [the deployment guide](README.md).
Deleting existing videos requires separate authorization. Keep the existing channel
`UCSoaAuNuuynvOcMQCIGW-ug` (Maddyvoice | Архив голосовых).

The existing nine videos were not originally released in Telegram order.
Updating their titles or source dates cannot correct that order. YouTube sets
[`snippet.publishedAt`](https://developers.google.com/youtube/data/reference/rest/v3/videos#snippet.publishedAt)
when a private video becomes public; `status.publishAt` cannot backdate a release.
A rebuild would permanently lose the old video URLs, views and reactions.

## Reviewed source order

A read-only audit on 2026-10-27 verified all nine cached MP4 sizes and SHA-256
hashes against the Pi's BoxDB records. The private local audit is
`data/ordered-publication-source-audit.json`. This inventory is not a backup or
a fresh inventory of every video on the YouTube channel.

All recordings below have audio index `0`. Original times are UTC.

| Order | Telegram message                     | Original publication | Existing YouTube video                      |
| ----- | ------------------------------------ | -------------------- | ------------------------------------------- |
| 1     | [7514](https://t.me/maddysontg/7514) | 2026-10-13 15:25:51  | [0oMixzeT6zo](https://youtu.be/0oMixzeT6zo) |
| 2     | [7519](https://t.me/maddysontg/7519) | 2026-10-15 03:25:08  | [jWKKn0v2WIY](https://youtu.be/jWKKn0v2WIY) |
| 3     | [7564](https://t.me/maddysontg/7564) | 2026-10-21 14:31:10  | [ZA4ukmZw7jg](https://youtu.be/ZA4ukmZw7jg) |
| 4     | [7569](https://t.me/maddysontg/7569) | 2026-10-22 18:32:24  | [_VSJdVY8l_8](https://youtu.be/_VSJdVY8l_8) |
| 5     | [7572](https://t.me/maddysontg/7572) | 2026-10-23 09:10:35  | [TuNgoVeHk-Q](https://youtu.be/TuNgoVeHk-Q) |
| 6     | [7574](https://t.me/maddysontg/7574) | 2026-10-23 09:18:16  | [mYbRDXsP3IE](https://youtu.be/mYbRDXsP3IE) |
| 7     | [7580](https://t.me/maddysontg/7580) | 2026-10-24 02:48:18  | [I8qn2354YgU](https://youtu.be/I8qn2354YgU) |
| 8     | [7587](https://t.me/maddysontg/7587) | 2026-10-24 16:12:57  | [x3o6PVY65uQ](https://youtu.be/x3o6PVY65uQ) |
| 9     | [7596](https://t.me/maddysontg/7596) | 2026-10-26 02:05:50  | [Sz0V48XTe3k](https://youtu.be/Sz0V48XTe3k) |

## Preconditions for a later cutover

1. Obtain explicit authorization for permanent deletion of the exact video IDs
   in a refreshed manifest, keeping the channel. A change in inventory requires
   reviewing the new scope before deletion.
2. Stop the publisher and any manual job, verify they have exited, and hold its
   worker lock throughout the cutover. Keep the topic worker idle while changing
   title records. Confirm the authorized account's channel ID before mutations.
3. Take and verify a cold backup of the Pi's complete private data directory,
   including BoxDB and its WAL, MP4s and authorization files. Protect it as
   credentials. Export the exact current YouTube snippets and statuses plus job
   and title records. Keep an old-ID-to-new-ID manifest outside reset state.
   Verify all MP4 hashes, source links and original timestamps again.
4. Inspect every owned channel video and every unfinished job, including private
   uploads and resumable sessions. Reconcile uncertain uploads. Do not assume
   this nine-row snapshot is still complete. Never restore the Mac's stale DB
   over production.
5. Set the full historical range before releasing the first replacement. Import
   all desired older recordings into the rebuilt queue before publication. A
   later import cannot insert older videos into an existing YouTube chronology.
6. Review cached backgrounds. The early test renders for messages 7569 and 7596
   predate the selected portrait; prepare and inspect replacements if needed.
   Preserve the old files in the verified backup.

The normal CLI deliberately has no bulk-delete or rebuild-reset command.
Implement and review the maintenance operation against the refreshed manifest
before cutover. Do not improvise SQL resets or use `retry --allow-new-upload` to
rebuild completed jobs.

## Cutover procedure after approval

1. Delete only the approved old video IDs. Confirm each is absent before any
   replacement becomes public. If any deletion fails or its outcome is unknown,
   stop and reconcile; do not start public replacements after partial deletion.
2. Under the worker lock, reset the selected jobs in one BoxDB transaction,
   preserving source fields, verified render paths and the live polling cursor.
   Clear old YouTube IDs, sessions, publication targets and retry state only
   after their outcomes are reconciled. Include any additional historical jobs
   in the complete ordered queue before continuing.
3. Reset title records together with jobs. Keep cached topics and exact reviewed
   titles and descriptions in the manifest, then associate them with each new
   YouTube ID. Title records retain the old video ID: changing only `jobs` would
   cause a mismatch and stop automatic renaming. Apply the saved title and
   description to the private replacement before public release.
4. Release replacements in `(message_id, audio_index)` order through the prepared
   publisher. Every upload starts private. Persist its resumable session before
   sending bytes and its accepted YouTube ID before changing visibility. Wait
   for processing and confirmed public visibility, then finish the completion
   barrier before advancing. A failure, backoff or review stops the queue.
5. After interruption, inspect the same saved session or video ID. Never clear
   an ambiguous session to create another upload. Keep all old-to-new mappings
   durable throughout the operation.
6. Verify that replacement `snippet.publishedAt` values are strictly increasing
   in Telegram order and that all intended videos are public, with no old public
   copies. Check each title, background, channel link, exact message link and
   original UTC timestamp in its description. Compare the final manifest to the
   complete source inventory, then resume the normal service.

After the first replacement is public, recovery moves forward through the same
queue. Restoring the old DB cannot restore deleted YouTube videos. Changing the
historical scope or independently publishing videos during cutover requires
stopping and reviewing chronology again.
