import { randomBytes, createHash } from "node:crypto";
import { open, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { AppError, attempt, checkedFetch, safeMessage, Settings } from "./core.ts";
import type { Job } from "./database.ts";
import { captionText, topicTitle } from "./topic.ts";
import { defaultVideoTags, mergeVideoTags } from "./video-tags.ts";

const Auth = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.String,
  refreshToken: Schema.String,
  channelId: Schema.String,
  channelTitle: Schema.String,
});
type Auth = typeof Auth.Type;
const OAuthClient = Schema.Struct({
  installed: Schema.Struct({ client_id: Schema.String, client_secret: Schema.String }),
});
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});
const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];
const Channels = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, snippet: Schema.Struct({ title: Schema.String }) }),
  ),
});
const Video = Schema.Struct({ id: Schema.String });
const VideoStatus = Schema.Struct({
  privacyStatus: Schema.Literals(["private", "public", "unlisted"]),
  uploadStatus: Schema.String,
  publishAt: Schema.optionalKey(Schema.String),
  embeddable: Schema.optionalKey(Schema.Boolean),
  license: Schema.optionalKey(Schema.String),
  publicStatsViewable: Schema.optionalKey(Schema.Boolean),
  selfDeclaredMadeForKids: Schema.optionalKey(Schema.Boolean),
  containsSyntheticMedia: Schema.optionalKey(Schema.Boolean),
});
const OwnedVideo = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      snippet: Schema.Struct({
        channelId: Schema.String,
        description: Schema.String,
        title: Schema.optionalKey(Schema.String),
        categoryId: Schema.optionalKey(Schema.String),
        tags: Schema.optionalKey(Schema.Array(Schema.String)),
        defaultLanguage: Schema.optionalKey(Schema.String),
        defaultAudioLanguage: Schema.optionalKey(Schema.String),
      }),
      status: Schema.optionalKey(VideoStatus),
      processingDetails: Schema.optionalKey(Schema.Struct({ processingStatus: Schema.String })),
    }),
  ),
});
const Captions = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      snippet: Schema.Struct({
        videoId: Schema.String,
        language: Schema.String,
        trackKind: Schema.String,
        status: Schema.String,
        isDraft: Schema.Boolean,
      }),
    }),
  ),
});

export class UploadReview extends Error {}
function readyPublicationStatus(video: (typeof OwnedVideo.Type.items)[number]) {
  const status = video.status;
  if (!status) throw new Error("YouTube did not return publication status");
  if (
    ["failed", "rejected", "deleted"].includes(status.uploadStatus) ||
    video.processingDetails?.processingStatus === "failed"
  )
    throw new UploadReview(
      "YouTube could not process this video; inspect it before continuing the queue",
    );
  if (status.publishAt)
    throw new UploadReview(
      "Video was scheduled outside the application; inspect its publication before continuing",
    );
  if (
    status.uploadStatus !== "processed" ||
    video.processingDetails?.processingStatus === "processing"
  )
    return undefined;
  return status;
}
const sourceMarker = (job: Pick<Job, "id">) => `maddyvoice:${job.id}`;

function resumeOffset(range: string | null, size: number): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match?.[1]) throw new Error("Invalid resumable upload range");
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset > size)
    throw new Error("Invalid resumable upload offset");
  return offset;
}

function legacyInitialTitle(job: Job) {
  const day = job.published_at.slice(0, 10);
  const caption = job.caption.replace(/[<>]/g, "").trim();
  const title = `Мэддисон — ${caption.split("\n")[0] || "голосовое сообщение"} | ${day}`;
  return Array.from(title).slice(0, 100).join("");
}

export function videoMetadata(job: Job, privacy: "public" | "private" | "unlisted") {
  const caption = job.caption.replace(/[<>]/g, "").trim();
  const suffix = `\n\nТелеграм-канал Мэддисона: https://t.me/${job.channel}\nОригинальное сообщение: ${job.source_url}\nДата и время публикации оригинального сообщения: ${job.published_at.replace("T", " ").replace(".000Z", " UTC")}\n\n${sourceMarker(job)}`;
  let description = "";
  const budget = 5000 - Buffer.byteLength(suffix, "utf8");
  for (const character of caption) {
    if (Buffer.byteLength(description + character, "utf8") > budget) break;
    description += character;
  }
  description += suffix;
  return {
    snippet: {
      title: topicTitle(caption.split("\n")[0] || "Голосовое сообщение"),
      description,
      categoryId: "22",
      defaultLanguage: "ru",
      defaultAudioLanguage: "ru",
      tags: defaultVideoTags,
    },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function youtubeErrorReason(response: Response, includeMessage = false) {
  const Problem = Schema.Struct({
    error: Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      errors: Schema.Array(
        Schema.Struct({
          reason: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
        }),
      ),
    }),
  });
  try {
    const problem = Schema.decodeUnknownSync(Problem)(await response.json());
    const reasons = problem.error.errors.map((error) => error.reason).join(", ");
    return includeMessage && problem.error.message
      ? `${reasons}: ${safeMessage(new Error(problem.error.message))}`
      : reasons;
  } catch {
    return "unknown";
  }
}

export class YouTubeClient {
  private accessToken = "";
  constructor(
    private readonly auth: Auth,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  private async refresh(signal?: AbortSignal) {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
      body: new URLSearchParams({
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret,
        refresh_token: this.auth.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OAuth refresh failed (HTTP ${response.status}); run auth youtube again`);
    }
    this.accessToken = Schema.decodeUnknownSync(Tokens)(await response.json()).access_token;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!this.accessToken) await this.refresh(signal);
    const call = () => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.accessToken}`);
      return this.fetcher(url, {
        ...init,
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
      });
    };
    const response = await call();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    await this.refresh(signal);
    return call();
  }

  async verifyChannel(signal?: AbortSignal, expectedChannel = this.auth.channelId): Promise<void> {
    const response = await this.request(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {},
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `YouTube channel verification HTTP ${response.status} (${await youtubeErrorReason(response)})`,
      );
    }
    const channels = Schema.decodeUnknownSync(Channels)(await response.json());
    if (
      channels.items.length !== 1 ||
      channels.items[0]?.id !== this.auth.channelId ||
      this.auth.channelId !== expectedChannel
    ) {
      throw new Error(
        "OAuth is connected to a different YouTube channel; run auth youtube and choose the intended channel",
      );
    }
  }

  async start(
    job: Job,
    privacy: "public" | "private" | "unlisted",
    signal?: AbortSignal,
  ): Promise<string> {
    if (job.video_size === null) throw new Error("Video has no size");
    const response = await this.request(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(job.video_size),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify(videoMetadata(job, privacy)),
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Start YouTube upload HTTP ${response.status}`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("YouTube did not return a resumable upload URL");
    this.validateSession(location);
    return location;
  }

  private validateSession(session: string) {
    const url = new URL(session);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.googleapis.com" ||
      url.pathname !== "/upload/youtube/v3/videos"
    ) {
      throw new Error("Unexpected YouTube upload session host or path");
    }
  }

  private async progress(
    response: Response,
    size: number,
  ): Promise<{ offset: number } | { videoId: string }> {
    if (response.status === 200 || response.status === 201) {
      return { videoId: Schema.decodeUnknownSync(Video)(await response.json()).id };
    }
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) {
      throw new UploadReview(
        "Upload session expired. Check YouTube Studio, then use resolve or retry --allow-new-upload; automatic recreation could duplicate a video.",
      );
    }
    if (response.status !== 308) throw new Error(`YouTube upload HTTP ${response.status}`);
    return { offset: resumeOffset(response.headers.get("range"), size) };
  }

  async resume(session: string, file: string, size: number, signal?: AbortSignal): Promise<string> {
    this.validateSession(session);
    let result = await this.progress(
      await this.request(
        session,
        {
          method: "PUT",
          headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
        },
        signal,
      ),
      size,
    );
    await using handle = await open(file, "r");
    while (!("videoId" in result)) {
      const offset = result.offset;
      if (offset === size)
        throw new Error(
          "YouTube received all bytes but is not yet returning a video ID; will query the same session again",
        );
      const length = Math.min(8 * 1024 * 1024, size - offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error("Video file changed during upload");
      const next = await this.progress(
        await this.request(
          session,
          {
            method: "PUT",
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
            },
            body: buffer,
          },
          signal,
        ),
        size,
      );
      if ("offset" in next && next.offset <= offset)
        throw new Error("YouTube made no upload progress; will resume on the next attempt");
      result = next;
    }
    return result.videoId;
  }

  private async ownedVideo(
    job: Pick<Job, "id">,
    videoId: string,
    part: string,
    signal?: AbortSignal,
  ) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId))
      throw new Error("Expected a YouTube video ID (11 characters)");
    const response = await this.request(
      `https://www.googleapis.com/youtube/v3/videos?part=${part}&id=${videoId}`,
      {},
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `YouTube video check HTTP ${response.status} (${await youtubeErrorReason(response)})`,
      );
    }
    const video = Schema.decodeUnknownSync(OwnedVideo)(await response.json()).items[0];
    if (
      !video ||
      video.id !== videoId ||
      video.snippet.channelId !== this.auth.channelId ||
      !video.snippet.description.split(/\r?\n/).includes(sourceMarker(job))
    ) {
      throw new Error(
        "Video does not belong to the configured channel or lacks this recording's source marker",
      );
    }
    return video;
  }

  private async ownedSnippet(job: Pick<Job, "id">, videoId: string, signal?: AbortSignal) {
    return (await this.ownedVideo(job, videoId, "snippet", signal)).snippet;
  }

  async verifyVideo(job: Job, videoId: string, signal?: AbortSignal): Promise<void> {
    await this.ownedSnippet(job, videoId, signal);
  }

  async publish(
    job: Job,
    privacy: "private" | "public" | "unlisted",
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!job.youtube_id) throw new Error("Video has not been uploaded");
    const video = await this.ownedVideo(
      job,
      job.youtube_id,
      "snippet,status,processingDetails",
      signal,
    );
    const status = readyPublicationStatus(video);
    if (!status) return false;
    if (status.privacyStatus === privacy) return true;
    if (status.privacyStatus !== "private")
      throw new UploadReview(
        "Video visibility changed outside the application; inspect it before continuing",
      );
    const { uploadStatus: _uploadStatus, ...writableStatus } = status;
    const response = await this.request(
      "https://www.googleapis.com/youtube/v3/videos?part=status",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: job.youtube_id,
          status: { ...writableStatus, privacyStatus: privacy },
        }),
      },
      signal,
    );
    if (!response.ok) {
      const reason = await youtubeErrorReason(response);
      throw new Error(`Publish YouTube video HTTP ${response.status} (${reason})`);
    }
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, status: VideoStatus }),
    )(await response.json());
    if (result.id !== job.youtube_id || result.status.privacyStatus !== privacy)
      throw new Error(
        "YouTube did not confirm the requested publication; will reconcile the same video",
      );
    return true;
  }

  async captions(job: Job, signal?: AbortSignal): Promise<string | undefined> {
    if (!job.youtube_id) throw new Error("Video has not been uploaded");
    await this.verifyVideo(job, job.youtube_id, signal);
    const response = await this.request(
      `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${job.youtube_id}`,
      {},
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `List YouTube captions HTTP ${response.status}; check youtube.force-ssl authorization`,
      );
    }
    const tracks = Schema.decodeUnknownSync(Captions)(await response.json()).items;
    const track = tracks
      .filter(
        (item) =>
          item.snippet.videoId === job.youtube_id &&
          /^ru(?:-|$)/i.test(item.snippet.language) &&
          item.snippet.status === "serving" &&
          !item.snippet.isDraft,
      )
      .sort(
        (a, b) => Number(b.snippet.trackKind === "ASR") - Number(a.snippet.trackKind === "ASR"),
      )[0];
    if (!track) return undefined;
    const download = await this.request(
      `https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(track.id)}?tfmt=srt`,
      {},
      signal,
    );
    if (!download.ok) {
      await download.body?.cancel();
      throw new Error(`Download YouTube captions HTTP ${download.status}`);
    }
    return captionText(await download.text());
  }

  async updateTitle(
    job: Job,
    title: string,
    previousTitle?: string | null,
    tags?: readonly string[],
    signal?: AbortSignal,
  ): Promise<"applied" | "manual"> {
    if (!job.youtube_id) throw new Error("Video has not been uploaded");
    const current = await this.ownedSnippet(job, job.youtube_id, signal);
    if (!current.title) throw new Error("YouTube video has no title");
    const nextTags = tags === undefined ? current.tags : mergeVideoTags(current.tags ?? [], tags);
    if (current.title === title && JSON.stringify(current.tags) === JSON.stringify(nextTags))
      return "applied";
    const managedTitles = [
      title,
      videoMetadata(job, "private").snippet.title,
      legacyInitialTitle(job),
      previousTitle,
    ];
    if (!managedTitles.includes(current.title)) return "manual";
    if (!current.categoryId) throw new Error("YouTube video has no category");
    const { channelId: _channelId, ...snippet } = current;
    await this.saveSnippet(job.youtube_id, { ...snippet, title, tags: nextTags }, signal);
    return "applied";
  }

  private async saveSnippet(
    videoId: string,
    snippet: Omit<(typeof OwnedVideo.Type.items)[number]["snippet"], "channelId">,
    signal?: AbortSignal,
  ) {
    const updated = await this.request(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: videoId, snippet }),
      },
      signal,
    );
    if (!updated.ok) {
      const reason = await youtubeErrorReason(updated);
      throw new Error(`Update YouTube title HTTP ${updated.status} (${reason})`);
    }
    if (Schema.decodeUnknownSync(Video)(await updated.json()).id !== videoId)
      throw new Error("YouTube returned a different video after title update");
  }

  async setThumbnail(job: Pick<Job, "id" | "youtube_id">, png: Uint8Array, signal?: AbortSignal) {
    if (!job.youtube_id) throw new Error("Video has not been uploaded");
    if (
      png.byteLength > 50 * 1024 * 1024 ||
      !Buffer.from(png.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Thumbnail must be a PNG smaller than 50 MiB");
    await this.ownedSnippet(job, job.youtube_id, signal);
    const response = await this.request(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=${job.youtube_id}`,
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Blob([Uint8Array.from(png)]),
      },
      signal,
    );
    if (!response.ok)
      throw new Error(
        `Set YouTube thumbnail HTTP ${response.status} (${await youtubeErrorReason(response, true)})`,
      );
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        items: Schema.Array(
          Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
        ).check(Schema.isMinLength(1)),
      }),
    )(await response.json());
    if (
      !result.items.some((item) =>
        Object.values(item).some((image) => image.url.startsWith("https://")),
      )
    )
      throw new Error("YouTube did not confirm a thumbnail URL");
    return result.items;
  }
}

export class YouTube extends Context.Service<
  YouTube,
  {
    load(): Effect.Effect<YouTubeClient, AppError>;
  }
>()("maddyvoice/YouTube") {
  static readonly layer = Layer.effect(
    YouTube,
    Effect.gen(function* () {
      const config = yield* Settings;
      let client: YouTubeClient | undefined;
      const load = () =>
        attempt("Load YouTube authorization", async () => {
          if (client) return client;
          let raw: string;
          try {
            raw = await readFile(join(config.dataDir, "youtube-auth.json"), "utf8");
          } catch {
            throw new Error(
              "Run auth youtube --client <desktop-oauth-client.json> --channel UC... first",
            );
          }
          const auth = Schema.decodeUnknownSync(Auth)(JSON.parse(raw));
          if (config.expectedChannel && config.expectedChannel !== auth.channelId)
            throw new Error("YOUTUBE_CHANNEL_ID does not match the authorized channel");
          client = new YouTubeClient(auth);
          return client;
        });
      return YouTube.of({ load });
    }),
  );
}

export const authorizeYouTube = Effect.fn("authorizeYouTube")(function* (
  clientPath: string,
  expectedChannel: string,
) {
  const config = yield* Settings;
  return yield* attempt("Authorize YouTube", async (signal) => {
    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(expectedChannel))
      throw new Error("Pass the ID of the dedicated YouTube channel (UC...)");
    const { installed } = Schema.decodeUnknownSync(OAuthClient)(
      JSON.parse(await readFile(clientPath, "utf8")),
    );
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let complete: (code: string) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const result = new Promise<string>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/oauth/callback") return new Response("Not found", { status: 404 });
        if (url.searchParams.get("state") !== state)
          return new Response("Invalid OAuth state", { status: 400 });
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.has("error")) {
          reject(new Error("YouTube authorization was declined"));
          return new Response("Authorization declined. Return to the terminal.", { status: 400 });
        }
        complete(code);
        return new Response(
          "YouTube authorization received. You can close this tab and return to the terminal.",
          { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
        );
      },
    });
    const redirect = `http://127.0.0.1:${server.port}/oauth/callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({
      client_id: installed.client_id,
      redirect_uri: redirect,
      response_type: "code",
      scope: youtubeScopes.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    console.log(
      `Open this URL in your regular browser and select the dedicated YouTube channel:\n${authUrl.href}`,
    );
    const timeout = setTimeout(
      () => reject(new Error("OAuth timed out after 10 minutes")),
      600_000,
    );
    const onAbort = () => reject(new Error("OAuth cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const code = await result;
      const response = await checkedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        signal,
        body: new URLSearchParams({
          client_id: installed.client_id,
          client_secret: installed.client_secret,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirect,
        }),
      });
      const tokens = Schema.decodeUnknownSync(Tokens)(await response.json());
      if (!tokens.refresh_token)
        throw new Error(
          "Google did not return a refresh token; revoke the old grant and authorize again",
        );
      const channelResponse = await checkedFetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
          signal,
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      );
      const channel = Schema.decodeUnknownSync(Channels)(await channelResponse.json()).items;
      if (channel.length !== 1 || channel[0]?.id !== expectedChannel)
        throw new Error("Selected channel differs from --channel; no authorization was saved");
      const auth: Auth = {
        clientId: installed.client_id,
        clientSecret: installed.client_secret,
        refreshToken: tokens.refresh_token,
        channelId: expectedChannel,
        channelTitle: channel[0].snippet.title,
      };
      const temporary = join(config.dataDir, `youtube-auth-${randomBytes(8).toString("hex")}.json`);
      await writeFile(temporary, JSON.stringify(auth), { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, join(config.dataDir, "youtube-auth.json"));
      return { id: expectedChannel, title: auth.channelTitle };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      await server.stop(true);
    }
  });
});
