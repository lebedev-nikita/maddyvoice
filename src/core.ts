import { Config, Context, Effect, Layer, Schema } from "effect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  message: Schema.String,
}) {}

export const attempt = <A>(message: string, work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new AppError({ message: `${message}: ${safeMessage(cause)}` }),
  });

export function safeMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Unknown failure";
  return message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 1500);
}

export const Paths = {
  channelLogo: fileURLToPath(new URL("../assets/channel-logo.png", import.meta.url)),
  videoOverlay: fileURLToPath(new URL("../assets/video-overlay.png", import.meta.url)),
  thumbnailFont: fileURLToPath(new URL("../assets/fonts/Oswald-Bold.ttf", import.meta.url)),
  cardFont: fileURLToPath(new URL("../assets/fonts/Roboto.ttf", import.meta.url)),
  backgrounds: fileURLToPath(new URL("../assets/backgrounds", import.meta.url)),
  migrations: fileURLToPath(new URL("../db/migrations", import.meta.url)),
  topicSchema: fileURLToPath(new URL("../assets/topic.schema.json", import.meta.url)),
  people: fileURLToPath(new URL("../assets/people.json", import.meta.url)),
  names: fileURLToPath(new URL("../assets/names.json", import.meta.url)),
};

export class Settings extends Context.Service<
  Settings,
  {
    readonly channel: string;
    readonly dataDir: string;
    readonly pollSeconds: number;
    readonly privacy: "public" | "private" | "unlisted";
    readonly ffmpeg: string;
    readonly ffprobe: string;
    readonly chromium: string;
    readonly expectedChannel: string;
  }
>()("maddyvoice/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const channel = yield* Config.String("TELEGRAM_CHANNEL").pipe(
        Config.withDefault("maddysontg"),
      );
      const dataDir = yield* Config.String("DATA_DIR").pipe(Config.withDefault("./data"));
      const pollSeconds = yield* Config.Number("POLL_SECONDS").pipe(Config.withDefault(300));
      const privacy = yield* Config.String("YOUTUBE_PRIVACY").pipe(Config.withDefault("public"));
      const ffmpeg = yield* Config.String("FFMPEG_PATH").pipe(Config.withDefault("ffmpeg"));
      const ffprobe = yield* Config.String("FFPROBE_PATH").pipe(Config.withDefault("ffprobe"));
      const chromium = yield* Config.String("CHROMIUM_PATH").pipe(
        Config.withDefault(defaultChromium()),
      );
      const expectedChannel = yield* Config.String("YOUTUBE_CHANNEL_ID").pipe(
        Config.withDefault(""),
      );
      if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(channel)) {
        return yield* new AppError({
          message: "TELEGRAM_CHANNEL must be a public Telegram username",
        });
      }
      if (!Number.isInteger(pollSeconds) || pollSeconds < 30) {
        return yield* new AppError({ message: "POLL_SECONDS must be an integer >= 30" });
      }
      if (privacy !== "public" && privacy !== "private" && privacy !== "unlisted") {
        return yield* new AppError({
          message: "YOUTUBE_PRIVACY must be public, private, or unlisted",
        });
      }
      return Settings.of({
        channel,
        dataDir: resolve(dataDir),
        pollSeconds,
        privacy,
        ffmpeg,
        ffprobe,
        chromium,
        expectedChannel,
      });
    }),
  );
}

/** Chromium or Chrome from PATH, else the macOS application bundle. */
export function defaultChromium(): string {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return (
    ["chromium", "chromium-browser", "google-chrome"].find((name) => Bun.which(name)) ??
    (existsSync(mac) ? mac : "chromium")
  );
}

export async function checkedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} (${response.statusText})`);
  }
  return response;
}

export const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
