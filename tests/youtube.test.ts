import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../src/database.ts";
import { UploadReview, videoMetadata, YouTubeClient } from "../src/youtube.ts";
import { captionText, topicTitle } from "../src/topic.ts";

const auth = {
  clientId: "test",
  clientSecret: "test",
  refreshToken: "test",
  channelId: "UCtest",
  channelTitle: "Test",
};
const job: Job = {
  id: "maddysontg-7596-0",
  channel: "maddysontg",
  message_id: 7596n,
  audio_index: 0n,
  caption: "",
  published_at: "2026-10-26T02:05:50.000Z",
  source_url: "https://t.me/maddysontg/7596",
  status: "ready",
  origin: "live",
  attempts: 0n,
  next_attempt: 0n,
  error: null,
  video_path: null,
  video_sha256: null,
  video_size: 8n,
  upload_session: null,
  upload_privacy: null,
  youtube_id: null,
  created_at: "",
  updated_at: "",
};
const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test";
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("captions and title updates", () => {
  const uploaded = { ...job, status: "uploaded" as const, youtube_id: "abcdefghijk" };
  const snippet = {
    channelId: "UCtest",
    title: videoMetadata(job, "public").snippet.title,
    description: "Original description\nmaddyvoice:maddysontg-7596-0",
    categoryId: "22",
    tags: ["keep", "these"],
    defaultLanguage: "ru",
    defaultAudioLanguage: "ru",
  };

  it("downloads the serving Russian ASR track through the official API", async () => {
    const client = new YouTubeClient(auth, async (url) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      if (url.includes("/videos?"))
        return Response.json({ items: [{ id: "abcdefghijk", snippet }] });
      if (url.includes("/captions?"))
        return Response.json({
          items: [
            {
              id: "sync",
              snippet: {
                videoId: "abcdefghijk",
                language: "ru",
                trackKind: "ASR",
                status: "syncing",
                isDraft: false,
              },
            },
            {
              id: "en",
              snippet: {
                videoId: "abcdefghijk",
                language: "en",
                trackKind: "ASR",
                status: "serving",
                isDraft: false,
              },
            },
            {
              id: "ru/track",
              snippet: {
                videoId: "abcdefghijk",
                language: "ru",
                trackKind: "ASR",
                status: "serving",
                isDraft: false,
              },
            },
          ],
        });
      expect(url).toContain("/captions/ru%2Ftrack?tfmt=srt");
      return new Response("1\n00:00:00,000 --> 00:00:02,000\nНовая игра получилась отличной.\n");
    });
    expect(await client.captions(uploaded)).toBe("Новая игра получилась отличной.");
  });

  it("returns waiting when Russian captions are absent", async () => {
    const client = new YouTubeClient(auth, async (url) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      if (url.includes("/videos?"))
        return Response.json({ items: [{ id: "abcdefghijk", snippet }] });
      return Response.json({ items: [] });
    });
    expect(await client.captions(uploaded)).toBeUndefined();
  });

  it("preserves snippet fields and reconciles a lost update response without a second PUT", async () => {
    let current = { ...snippet };
    let writes = 0;
    const client = new YouTubeClient(auth, async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      if (init?.method !== "PUT")
        return Response.json({ items: [{ id: "abcdefghijk", snippet: current }] });
      const body = JSON.parse(init.body as string);
      expect(body.status).toBeUndefined();
      expect(body.snippet).toEqual({ ...snippet, channelId: undefined, title: "Новая тема" });
      current = { ...snippet, title: body.snippet.title };
      writes++;
      throw new Error("Response lost after accepted update");
    });
    await expect(client.updateTitle(uploaded, "Новая тема")).rejects.toThrow("Response lost");
    expect(await client.updateTitle(uploaded, "Новая тема")).toBe("applied");
    expect(writes).toBe(1);
  });

  it("preserves manual titles and refuses a foreign channel before writing", async () => {
    let current = { ...snippet, title: "Моё собственное название" };
    const client = new YouTubeClient(auth, async (url, init) => {
      expect(init?.method).not.toBe("PUT");
      return url.includes("oauth2")
        ? Response.json({ access_token: "access" })
        : Response.json({ items: [{ id: "abcdefghijk", snippet: current }] });
    });
    expect(await client.updateTitle(uploaded, "Новая тема")).toBe("manual");
    current = { ...snippet, channelId: "OTHER" };
    await expect(client.updateTitle(uploaded, "Новая тема")).rejects.toThrow("configured channel");
  });

  it("decodes subtitle text and removes overlapping ASR cues", () => {
    expect(
      captionText(
        "1\n00:00:00,000 --> 00:00:02,000\n<b>Привет всем</b> ребята\n\n2\n00:00:02,000 --> 00:00:04,000\nвсем ребята про игру &amp; кино\n",
      ),
    ).toBe("Привет всем ребята про игру & кино");
    expect(() => captionText("not a caption file")).toThrow("no usable speech");
    const title = topicTitle("Очень длинная тема ".repeat(100), job.published_at);
    expect(Array.from(title).length).toBeLessThanOrEqual(100);
    expect(title.endsWith(" | 2026-10-26")).toBe(true);
  });
});
async function videoFile() {
  const directory = await mkdtemp(join(tmpdir(), "maddyvoice-upload-test-"));
  directories.push(directory);
  const file = join(directory, "test.mp4");
  await writeFile(file, Buffer.from("12345678"));
  return file;
}

it("always includes separate channel, post, and original timestamp lines within YouTube limits", () => {
  const metadata = videoMetadata({ ...job, caption: "Я😀".repeat(10_000) }, "private");
  expect(metadata.snippet.description).toContain(
    "Телеграм-канал Мэддисона: https://t.me/maddysontg\n",
  );
  expect(metadata.snippet.description).toContain(
    "Оригинальное сообщение: https://t.me/maddysontg/7596\n",
  );
  expect(metadata.snippet.description).toContain(
    "Дата и время публикации оригинального сообщения: 2026-10-26 02:05:50 UTC\n",
  );
  expect(Buffer.byteLength(metadata.snippet.description)).toBeLessThanOrEqual(5000);
  expect(Array.from(metadata.snippet.title).length).toBeLessThanOrEqual(100);
  expect(metadata.status.privacyStatus).toBe("private");
});

describe("resumable upload", () => {
  it("continues from the server offset instead of resending accepted bytes", async () => {
    const file = await videoFile();
    const ranges: string[] = [];
    const client = new YouTubeClient(auth, async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      const headers = new Headers(init?.headers);
      ranges.push(headers.get("Content-Range") ?? "");
      if (ranges.length === 1)
        return new Response(null, { status: 308, headers: { Range: "bytes=0-3" } });
      expect(Buffer.from(init?.body as Uint8Array).toString()).toBe("5678");
      return Response.json({ id: "abcdefghijk" }, { status: 201 });
    });
    expect(await client.resume(session, file, 8)).toBe("abcdefghijk");
    expect(ranges).toEqual(["bytes */8", "bytes 4-7/8"]);
  });

  it("recovers a lost final response by querying the SAME session", async () => {
    const file = await videoFile();
    let calls = 0;
    const client = new YouTubeClient(auth, async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      expect(url).toBe(session);
      calls++;
      if (calls === 1) return new Response(null, { status: 308 });
      if (calls === 2) throw new Error("Connection lost after server accepted bytes");
      expect(new Headers(init?.headers).get("Content-Range")).toBe("bytes */8");
      return Response.json({ id: "abcdefghijk" });
    });
    await expect(client.resume(session, file, 8)).rejects.toThrow("Connection lost");
    expect(await client.resume(session, file, 8)).toBe("abcdefghijk");
    expect(calls).toBe(3);
  });

  it("requires review for expired sessions and rejects unexpected upload hosts", async () => {
    const file = await videoFile();
    const client = new YouTubeClient(auth, async (url) =>
      url.includes("oauth2")
        ? Response.json({ access_token: "access" })
        : new Response(null, { status: 410 }),
    );
    await expect(client.resume(session, file, 8)).rejects.toBeInstanceOf(UploadReview);
    await expect(client.resume("https://bad.example/upload", file, 8)).rejects.toThrow(
      "Unexpected YouTube",
    );
  });

  it("verifies destination channel and refuses a token for another channel", async () => {
    const client = new YouTubeClient(auth, async (url) =>
      url.includes("oauth2")
        ? Response.json({ access_token: "access" })
        : Response.json({ items: [{ id: "other", snippet: { title: "Wrong" } }] }),
    );
    await expect(client.verifyChannel()).rejects.toThrow("different YouTube channel");
  });

  it("creates a private test upload with source metadata and returns the session", async () => {
    const client = new YouTubeClient(auth, async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      expect(typeof init?.body).toBe("string");
      const body = JSON.parse(init?.body as string);
      expect(body.status.privacyStatus).toBe("private");
      expect(body.snippet.description).toContain("maddyvoice:maddysontg-7596-0");
      return new Response(null, { headers: { Location: session } });
    });
    expect(await client.start(job, "private")).toBe(session);
  });

  it("only reconciles a video from this channel with this recording's marker", async () => {
    let description = "maddyvoice:maddysontg-7596-0";
    const client = new YouTubeClient(auth, async (url) =>
      url.includes("oauth2")
        ? Response.json({ access_token: "access" })
        : Response.json({
            items: [{ id: "abcdefghijk", snippet: { channelId: "UCtest", description } }],
          }),
    );
    await client.verifyVideo(job, "abcdefghijk");
    description = "Unrelated video";
    await expect(client.verifyVideo(job, "abcdefghijk")).rejects.toThrow("source marker");
  });
});
