import { afterEach, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyThumbnailBatch } from "../src/thumbnail-batch.ts";
import { YouTube, YouTubeClient } from "../src/youtube.ts";
import type { Job } from "../src/database.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
const auth = {
  channelId: "UC" + "x".repeat(22),
  channelTitle: "Test",
  clientId: "test",
  clientSecret: "test",
  refreshToken: "test",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "thumbnail-batch-test-"));
  temporary.push(root);
  await mkdir(join(root, "images"));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const rows = ["abcdefghijk", "lmnopqrstuv"].map((video, index) => ({
    video,
    sha256,
    jobId: `maddysontg-${index + 1}-0`,
  }));
  for (const row of rows) await writeFile(join(root, "images", `${row.video}.png`), png);
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ channelId: auth.channelId, rows }));
  return { root, manifest };
}
function run(manifest: string, client: YouTubeClient) {
  return Effect.runPromise(
    applyThumbnailBatch(manifest).pipe(
      Effect.provide(Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) }))),
    ),
  );
}
it("checkpoints confirmed uploads and resumes without repeating completed videos", async () => {
  const { root, manifest } = await fixture();
  const calls: string[] = [];
  let fail = true;
  let verifications = 0;
  class Client extends YouTubeClient {
    override async verifyChannel(_signal?: AbortSignal, expected?: string) {
      expect(expected).toBe(auth.channelId);
      verifications++;
    }
    override async setThumbnail(job: Pick<Job, "id" | "youtube_id">) {
      calls.push(job.youtube_id!);
      if (calls.length === 2 && fail) throw new Error("HTTP 403 (quotaExceeded)");
      return [{ high: { url: "https://i.ytimg.com/image.jpg" } }];
    }
  }
  const client = new Client(auth);
  await expect(run(manifest, client)).rejects.toThrow("quotaExceeded");
  expect(JSON.parse(await readFile(join(root, "progress.json"), "utf8")).applied).toHaveLength(1);
  fail = false;
  await run(manifest, client);
  await run(manifest, client);
  expect(calls).toEqual(["abcdefghijk", "lmnopqrstuv", "lmnopqrstuv"]);
  expect(verifications).toBe(2);
  expect(JSON.parse(await readFile(join(root, "progress.json"), "utf8")).applied).toHaveLength(2);
});
it("validates every fingerprint before making any remote change", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "images", "lmnopqrstuv.png"), "changed");
  class Client extends YouTubeClient {
    override async verifyChannel() {
      throw new Error("Must not contact YouTube");
    }
  }
  await expect(run(manifest, new Client(auth))).rejects.toThrow("fingerprint changed");
});
