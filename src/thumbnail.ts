import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { escapeHtml, openPage } from "./browser.ts";
import { AppError, attempt, Paths, Settings } from "./core.ts";
import { listBackgrounds } from "./media.ts";

// YouTube rejects thumbnails with Russian obscenities. Each pattern captures the root;
// the offset names the root letter replaced by a star.
const obscenities: readonly (readonly [RegExp, number])[] = [
  [/(п[ие]зд)/du, 1],
  [/(?<!стра)(ху[йеёяюи])/du, 1],
  [/^(ху)(?:ли|ль)$/du, 1],
  [/^(бля)(?!х)/du, 2],
  [/^(?:за|вы|у|по|на|до|при|про|пере|недо|долбо|съ|отъ|разъ|подъ|объ|въ|изъ|взъ)?([её]б)/du, 1],
  [/^(муд)(?:а[кч]|ил|о[зх])/du, 1],
  [/^(су[кч])(?:а|и|е|у|ой|ам|ами|ах|ин[а-яё]*|к[а-яё]*|ар[а-яё]*|ий|ье|ьё)$/du, 1],
  [/^(пид[оа]?р)/du, 1],
  [/(залуп)/du, 3],
  [/(г[ао]ндон)/du, 1],
  [/(шлюх)/du, 2],
  [/^(?:по|на|за|от|вы|об)?(дроч)/du, 2],
  [/^(манд)(?:а|ы|е|у|ой)$/du, 1],
];

export function maskObscenities(text: string) {
  return text.replace(/[а-яё]+/giu, (word) => {
    const lower = word.toLowerCase();
    for (const [pattern, offset] of obscenities) {
      const root = pattern.exec(lower)?.indices?.[1];
      if (!root) continue;
      const index = root[0] + offset;
      return `${word.slice(0, index)}*${word.slice(index + 1)}`;
    }
    return word;
  });
}

export function thumbnailText(quote: string) {
  return maskObscenities(
    quote.trim().replace(/[.,:;!?…—–\s-]+$/u, (ending) => (ending.includes("?") ? "?" : "")),
  );
}

export function thumbnailLines(quote: string) {
  const words = thumbnailText(quote).split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const previous = lines.at(-1);
    if (previous && Array.from(previous + " " + word).length <= 11)
      lines[lines.length - 1] = `${previous} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** The recording a thumbnail belongs to: its post picks the video's background. */
/** `scene` picks the background: an episode's number, otherwise the message id. */
export type ThumbnailRecording = {
  readonly messageId: number;
  readonly publishedAt: string;
  readonly scene?: number;
};

/** Fields identifying a video and its recording in local thumbnail batch files. */
export const ThumbnailRowFields = {
  video: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{11}$/)),
  messageId: Schema.Int.check(Schema.isGreaterThan(0)),
  publishedAt: Schema.String,
};

const moscowDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** Decorative voice-message bars, stable per post; the first 40% are played. */
function waveform(messageId: number) {
  let seed = (messageId % 2147483646) + 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: 34 }, (_, index) => {
    const level = 0.18 + (0.82 * Math.abs(Math.sin(index * 0.37) * 0.6 + random() * 0.55)) / 1.15;
    const color = index / 34 < 0.4 ? "#40a7e3" : "#c9dbe8";
    return `<i style="height:${Math.max(5, Math.round(level * 40))}px;background:${color}"></i>`;
  }).join("");
}

type ThumbnailImages = {
  readonly background: string;
  readonly logo: string;
  readonly oswald: string;
  readonly roboto: string;
};

/** The video's scene with its Telegram card enlarged; the quote replaces the post text. */
function thumbnailHtml(
  lines: readonly string[],
  recording: ThumbnailRecording,
  images: ThumbnailImages,
): string {
  const longest = Math.max(...lines.map((line) => Array.from(line).length));
  const fontSize = Math.min(92, Math.floor(470 / (longest * 0.56)));
  const date = moscowDate.format(Date.parse(recording.publishedAt)).replace(/\s*г\.$/u, "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Oswald; src: url("${images.oswald}"); }
@font-face { font-family: Roboto; src: url("${images.roboto}"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1280px; height: 720px; overflow: hidden; -webkit-font-smoothing: antialiased; }
.scene { position: absolute; inset: 0; background: url("${images.background}") -36px -40px / 1440px 810px; }
.bubble { position: absolute; right: 48px; top: 50%; width: 560px; padding: 26px 32px 22px;
  transform: translateY(-50%) rotate(-1.2deg); background: #fff; border-radius: 30px;
  box-shadow: 0 18px 60px rgba(0,0,0,.42), 0 2px 6px rgba(0,0,0,.18); }
.author { display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  font: 600 25px Roboto; color: #3a8bc8; }
.author img { width: 46px; height: 46px; border-radius: 50%; }
.voice { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.play { width: 64px; height: 64px; border-radius: 50%; background: #40a7e3; flex: none;
  display: grid; place-items: center; }
.wave { display: flex; align-items: center; gap: 5px; height: 40px; }
.wave i { display: block; width: 5px; border-radius: 5px; }
.quote { font: ${fontSize}px/1.06 Oswald; color: #111; text-transform: uppercase; white-space: nowrap; }
.footer { display: flex; justify-content: flex-end; margin-top: 10px; font: 20px Roboto; color: #a0acb6; }
</style></head><body>
<div class="scene"></div>
<div class="bubble">
  <div class="author"><img src="${images.logo}">Мэддисон</div>
  <div class="voice"><div class="play"><svg width="27" height="27" viewBox="0 0 24 24"><path fill="#fff" d="M7 4.5v15l13-7.5z"/></svg></div>
    <div class="wave">${waveform(recording.messageId)}</div></div>
  <div class="quote">${lines.map(escapeHtml).join("<br>")}</div>
  <div class="footer">голосовое · ${escapeHtml(date)}</div>
</div>
</body></html>`;
}

// Shrinks the quote until every line fits the bubble and the bubble fits the frame.
const fitScript = `(() => {
  const quote = document.querySelector(".quote"), bubble = document.querySelector(".bubble");
  let size = parseFloat(getComputedStyle(quote).fontSize);
  while (size > 32 && (quote.scrollWidth > quote.clientWidth || bubble.offsetHeight > 640))
    quote.style.fontSize = --size + "px";
  return size > 32;
})()`;

const dataUri = async (path: string, type: string) =>
  `data:${type};base64,${(await readFile(path)).toString("base64")}`;

export const renderThumbnail = Effect.fn("renderThumbnail")(function* (
  quote: string,
  recording: ThumbnailRecording,
  destination: string,
) {
  const displayQuote = thumbnailText(quote);
  const lines = thumbnailLines(displayQuote);
  if (!displayQuote || lines.length > 4)
    return yield* new AppError({ message: "Thumbnail requires a short nonempty quote" });
  const backgrounds = yield* listBackgrounds;
  const work = yield* Effect.acquireRelease(
    attempt("Create thumbnail workspace", () => mkdtemp(join(tmpdir(), "maddyvoice-thumbnail-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const images = yield* attempt("Read thumbnail images and fonts", async () => ({
    background: await dataUri(
      backgrounds[(recording.scene ?? recording.messageId) % backgrounds.length]!,
      "image/jpeg",
    ),
    logo: await dataUri(Paths.channelLogo, "image/png"),
    oswald: await dataUri(Paths.thumbnailFont, "font/ttf"),
    roboto: await dataUri(Paths.cardFont, "font/ttf"),
  }));
  const page = yield* openPage(work);
  const output = join(work, "thumbnail.png");
  yield* attempt("Render thumbnail", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.load(thumbnailHtml(lines, recording, images));
    if (!(await page.evaluate(fitScript))) throw new Error("Quote does not fit the thumbnail");
    await page.screenshot(output, 1280, 720);
  });
  yield* attempt("Save thumbnail", async () => {
    await mkdir(dirname(destination), { recursive: true });
    // The staging file is placed beside the destination for an atomic rename across filesystems.
    const staging = join(dirname(destination), `.${work.split("/").at(-1)}.png`);
    try {
      await copyFile(output, staging);
      await rename(staging, destination);
    } finally {
      await rm(staging, { force: true });
    }
  });
  return destination;
}, Effect.scoped);

export class Thumbnails extends Context.Service<
  Thumbnails,
  {
    render(
      quote: string,
      recording: ThumbnailRecording,
      destination: string,
    ): Effect.Effect<string, AppError>;
  }
>()("maddyvoice/Thumbnails") {
  static readonly layer = Layer.effect(
    Thumbnails,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Thumbnails.of({
        render: (quote, recording, destination) =>
          renderThumbnail(quote, recording, destination).pipe(
            Effect.provideService(Settings, settings),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) => new AppError({ message: error.message })),
          ),
      });
    }),
  );
}
