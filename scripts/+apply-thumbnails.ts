import { Layer, ManagedRuntime } from "effect";
import { parseArgs } from "node:util";
import { Settings, safeMessage } from "../src/core.ts";
import { applyThumbnailBatch, thumbnailBatchExitCode } from "../src/thumbnail-batch.ts";
import { YouTube } from "../src/youtube.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { manifest: { type: "string" } },
});
if (!values.manifest) throw new Error("Use --manifest data/thumbnail-batch/manifest.json");
const runtime = ManagedRuntime.make(YouTube.layer.pipe(Layer.provide(Settings.layer)));
try {
  await runtime.runPromise(applyThumbnailBatch(values.manifest));
} catch (cause) {
  const message = safeMessage(cause);
  console.error(message);
  // EX_TEMPFAIL retries the immutable batch; EX_CONFIG requires operator review.
  process.exitCode = thumbnailBatchExitCode(message);
} finally {
  await runtime.dispose();
}
