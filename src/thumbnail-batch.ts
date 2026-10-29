import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DateTime, Effect, Schema } from "effect";
import lockfile from "proper-lockfile";
import { AppError, attempt } from "./core.ts";
import { YouTube } from "./youtube.ts";

export function thumbnailBatchExitCode(message: string): 75 | 78 {
  return /quotaExceeded|rateLimitExceeded|HTTP (?:429|5\d\d)|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)\b|network|fetch|timed?\s?out|already being held/iu.test(
    message,
  )
    ? 75
    : 78;
}

const Row = Schema.Struct({
  jobId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]+-\d+-\d+$/)),
  video: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{11}$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const Manifest = Schema.Struct({
  channelId: Schema.String.check(Schema.isPattern(/^UC[a-zA-Z0-9_-]{22}$/)),
  rows: Schema.Array(Row).check(Schema.isMinLength(1)),
});
const Progress = Schema.Struct({
  manifestHash: Schema.String,
  applied: Schema.Array(
    Schema.Struct({ video: Schema.String, sha256: Schema.String, appliedAt: Schema.String }),
  ),
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readProgress(path: string, manifestHash: string) {
  try {
    return Schema.decodeUnknownSync(Progress)(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { manifestHash, applied: [] } satisfies typeof Progress.Type;
    throw error;
  }
}

function validateProgress(
  manifest: typeof Manifest.Type,
  progress: typeof Progress.Type,
  manifestHash: string,
) {
  if (progress.manifestHash !== manifestHash)
    throw new Error("Thumbnail batch changed; review before resuming");
  if (new Set(progress.applied.map((row) => row.video)).size !== progress.applied.length)
    throw new Error("Thumbnail progress contains duplicate confirmations");
  const rows = new Map(manifest.rows.map((row) => [row.video, row]));
  for (const done of progress.applied) {
    if (rows.get(done.video)?.sha256 !== done.sha256)
      throw new Error("Thumbnail confirmation differs from the approved batch");
  }
}

export const applyThumbnailBatch = Effect.fn("applyThumbnailBatch")(function* (
  manifestPath: string,
) {
  yield* Effect.acquireRelease(
    attempt("Lock thumbnail batch", () =>
      lockfile.lock(manifestPath, { stale: 120_000, update: 30_000, retries: 0 }),
    ),
    (release) => Effect.promise(() => release()),
  );
  const input = yield* attempt("Read thumbnail batch", async () => {
    const bytes = await readFile(manifestPath);
    const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(bytes.toString("utf8")));
    if (
      new Set(manifest.rows.map((row) => row.video)).size !== manifest.rows.length ||
      new Set(manifest.rows.map((row) => row.jobId)).size !== manifest.rows.length
    )
      throw new Error("Thumbnail batch contains duplicate videos or recordings");
    const manifestHash = hash(bytes);
    const progressPath = join(dirname(manifestPath), "progress.json");
    const progress = await readProgress(progressPath, manifestHash);
    validateProgress(manifest, progress, manifestHash);
    // Verify every file before any remote mutation, including when resuming a partial batch.
    for (const row of manifest.rows) {
      const png = await readFile(join(dirname(manifestPath), "images", `${row.video}.png`));
      if (hash(png) !== row.sha256)
        throw new Error(`Thumbnail fingerprint changed for ${row.video}`);
    }
    return { manifest, progress, progressPath };
  });
  const pending = input.manifest.rows.filter(
    (row) => !input.progress.applied.some((done) => done.video === row.video),
  );
  if (!pending.length) {
    yield* Effect.logInfo("All thumbnails in this batch are already applied");
    return;
  }
  const client = yield* (yield* YouTube).load();
  yield* attempt("Verify thumbnail destination channel", (signal) =>
    client.verifyChannel(signal, input.manifest.channelId),
  );
  const applied = [...input.progress.applied];
  for (const row of pending) {
    const png = yield* attempt("Read approved thumbnail", () =>
      readFile(join(dirname(manifestPath), "images", `${row.video}.png`)),
    );
    if (hash(png) !== row.sha256)
      return yield* new AppError({ message: "Thumbnail changed before upload" });
    yield* attempt("Apply YouTube thumbnail", (signal) =>
      client.setThumbnail({ id: row.jobId, youtube_id: row.video }, png, signal),
    );
    applied.push({
      video: row.video,
      sha256: row.sha256,
      appliedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* attempt("Persist thumbnail confirmation", async () => {
      const temporary = `${input.progressPath}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ manifestHash: input.progress.manifestHash, applied }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(temporary, input.progressPath);
    });
    yield* Effect.logInfo(
      `Applied thumbnail for ${row.video} (${applied.length}/${input.manifest.rows.length})`,
    );
  }
}, Effect.scoped);
