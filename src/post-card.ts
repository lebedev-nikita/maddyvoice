import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { escapeHtml, openPage } from "./browser.ts";
import { AppError, attempt, Paths, Settings } from "./core.ts";
import type { Post } from "./telegram.ts";

/** Frame area the visible card may fill: right of the face, inside the 1920 × 1080 frame. */
const CardArea = { left: 896, right: 1884, top: 20, bottom: 1060 } as const;
// CSS padding around the bubble that holds its shadow; the PNG includes it.
const shadow = { left: 22, top: 22, right: 28, bottom: 30 } as const;
// Largest first: the card uses the biggest type at which the whole post fits.
const scales = Array.from({ length: 27 }, (_, index) => 2.4 - index * 0.025);

type CardLayers = {
  /**
   * The card once per slide, positioned at (x, y) in the frame: the voice as posted, then
   * that slide's text post. Every image has the same size and the same voice bubble.
   */
  readonly slides: readonly {
    readonly image: string;
    /** Relative screen time. */
    readonly weight: number;
  }[];
  /** Only the played (blue) waveform bars, same size as the slides. */
  readonly played: string;
  readonly x: number;
  readonly y: number;
  /** Waveform rectangle inside the card images, in pixels. */
  readonly wave: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Elapsed-time label position inside the card images and its font size, in pixels. */
  readonly timer: { readonly x: number; readonly y: number; readonly size: number };
};

export type CardImages = { readonly avatar: string; readonly reactions: readonly string[] };

/**
 * One screen of a text post shown under the voice: its photos in a bubble of their own,
 * then its text, which a long post spreads over several pages.
 */
export type TextSlide = {
  readonly post: Post;
  readonly text: string;
  readonly page: number;
  readonly pages: number;
  /** Set on the photo slide only, which has no text. */
  readonly photos: readonly string[];
};

// Coarsest break first: a page ends between paragraphs when it can, inside a word never.
const breaks = [
  [/\n\s*\n/, "\n\n"],
  [/\n/, "\n"],
  [/(?<=[.!?…])\s+/, " "],
  [/\s+/, " "],
] as const;

function pieces(text: string, limit: number, level = 0): { text: string; joiner: string }[] {
  const split = breaks[level];
  if (text.length <= limit || !split) return [{ text, joiner: "" }];
  return text
    .split(split[0])
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) =>
      pieces(part, limit, level + 1).map((piece, index) =>
        index === 0 ? { ...piece, joiner: split[1] } : piece,
      ),
    );
}

type Piece = ReturnType<typeof pieces>[number];
type Paging = { readonly count: number; readonly longest: number; readonly from: number };

const joined = (parts: readonly Piece[]) =>
  parts.map((piece, index) => (index ? piece.joiner : "") + piece.text).join("");

const better = (a: Paging, b: Paging | undefined) =>
  !b || a.count < b.count || (a.count === b.count && a.longest < b.longest);

/**
 * Split a post into the fewest pages of at most `limit` characters, as even in length as its
 * paragraphs and sentences allow, so that no page is left with a stray last line.
 */
export function textPages(text: string, limit = 700): string[] {
  const parts = text.trim() ? pieces(text.trim(), limit) : [];
  // best[end] pages the first `end` pieces; its last page starts at piece `from`.
  const best: Paging[] = [{ count: 0, longest: 0, from: 0 }];
  for (let end = 1; end <= parts.length; end++) {
    let choice: Paging | undefined;
    for (let from = end - 1, length = 0; from >= 0; from--) {
      length += parts[from]!.text.length + (length ? parts[from + 1]!.joiner.length : 0);
      // Only a word longer than the limit may overflow its page.
      if (length > limit && choice) break;
      const paging = {
        count: best[from]!.count + 1,
        longest: Math.max(best[from]!.longest, length),
        from,
      };
      if (better(paging, choice)) choice = paging;
    }
    best.push(choice!);
  }
  const pages: string[] = [];
  for (let end = parts.length; end > 0; end = best[end]!.from)
    pages.unshift(joined(parts.slice(best[end]!.from, end)));
  return pages;
}

export const textSlides = (texts: readonly Post[]): TextSlide[] =>
  texts.flatMap((post) => [
    ...(post.images.length ? [{ post, text: "", page: 0, pages: 0, photos: post.images }] : []),
    ...textPages(post.text).map((text, index, pages) => ({
      post,
      text,
      page: index + 1,
      pages: pages.length,
      photos: [],
    })),
  ]);

// Photos sit in rows of up to three, like a Telegram album.
const album = (photos: readonly string[]) => {
  const rows = Math.ceil(photos.length / 3);
  const html = Array.from({ length: rows }, (_, row) => {
    const from = Math.round((row * photos.length) / rows);
    const to = Math.round(((row + 1) * photos.length) / rows);
    return `<div class="row">${photos
      .slice(from, to)
      .map((photo) => `<img src="${photo}">`)
      .join("")}</div>`;
  });
  return photos.length ? `<div class="media">${html.join("")}</div>` : "";
};

const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part)}</p>`)
    .join("");

const moscowTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
});

const star = `<svg viewBox="0 0 24 24" width="17" height="17"><path fill="#f5a623" d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>`;
const eye = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 5C6.5 5 2.7 9.1 1.5 12c1.2 2.9 5 7 10.5 7s9.3-4.1 10.5-7C21.3 9.1 17.5 5 12 5zm0 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zm0-2.3a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z"/></svg>`;

const footer = (post: Post) =>
  (post.card?.views
    ? `${eye}<span>${escapeHtml(post.card.views)}</span><span>&nbsp;·&nbsp;</span>`
    : "") +
  `<span>${post.card?.edited ? "изменено " : ""}${moscowTime.format(Date.parse(post.date))}</span>`;

/**
 * Telegram-like voice post, followed by the text posts shown while it plays (one is visible
 * at a time). `position` marks the voice's place in an episode. Images are data URIs so
 * Chromium never waits on the network.
 */
export function cardHtml(
  post: Post,
  audioIndex: number,
  images: CardImages,
  font: string,
  slides: readonly TextSlide[] = [],
  position = "",
): string {
  const card = post.card;
  const waveform = card?.waveforms[audioIndex] ?? [];
  const caption = paragraphs(post.text);
  const reactions = (card?.reactions ?? []).map((reaction, index) => {
    if (reaction.paid)
      return `<span class="reaction paid">${star}${escapeHtml(reaction.count)}</span>`;
    const image = images.reactions[index];
    const icon = image
      ? `<img src="${image}">`
      : `<span class="glyph">${escapeHtml(reaction.emoji)}</span>`;
    return `<span class="reaction">${icon}${escapeHtml(reaction.count)}</span>`;
  });
  const posts = slides.map((slide) =>
    slide.photos.length
      ? `<div class="bubble post photos">${album(slide.photos)}</div>`
      : `<div class="bubble post"><div class="text">${paragraphs(slide.text)}</div>` +
        `<div class="footer">${slide.pages > 1 ? `<span class="page">${slide.page} / ${slide.pages}</span>` : ""}${footer(slide.post)}</div></div>`,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Roboto; src: url("${font}"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: transparent; font-family: Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.card { width: 520px; padding: ${shadow.top}px ${shadow.right}px ${shadow.bottom}px ${shadow.left}px; }
.bubble { background: #fff; border-radius: 16px; padding: 9px 13px 8px;
  box-shadow: 0 4px 22px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.12); }
.author { display: flex; align-items: center; gap: 8px; color: #3a8bc8; font-weight: 600; font-size: 14.5px;
  line-height: 19px; margin-bottom: 7px; }
.author span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.author .position { margin-left: auto; flex: none; color: #a0acb6; font-weight: 500; font-size: 12.5px; }
.avatar { width: 26px; height: 26px; border-radius: 50%; flex: none; background: #3a8bc8; }
.voice { display: flex; align-items: center; gap: 11px; margin-bottom: 7px; }
.play { width: 44px; height: 44px; border-radius: 50%; background: #40a7e3; flex: none; position: relative; }
.play::before, .play::after { content: ""; position: absolute; top: 14px; width: 4px; height: 16px;
  border-radius: 1.5px; background: #fff; }
.play::before { left: 15px; } .play::after { left: 25px; }
.wave-wrap { flex: 1; min-width: 0; }
.wave { height: 26px; display: flex; align-items: flex-end; }
.duration { height: 17px; margin-top: 3px; }
.text { color: #111; font-size: 15px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere;
  margin-bottom: 8px; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.text p + p { margin-top: 10px; }
.reactions { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
.reaction { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px 0 6px; border-radius: 14px;
  background: rgba(64,167,227,.13); color: #2481cc; font-size: 13.5px; font-weight: 600; }
.reaction img { width: 19px; height: 19px; }
.reaction .glyph { font-size: 16px; line-height: 19px; }
.reaction.paid { background: rgba(245,166,35,.16); color: #d2860c; }
.footer { display: flex; justify-content: flex-end; align-items: center; gap: 4px; color: #a0acb6; font-size: 12.5px; }
.footer svg { margin-right: 1px; }
.post { margin-top: 8px; padding-top: 10px; }
.page { margin-right: auto; }
.photos { width: fit-content; padding: 0; overflow: hidden; }
.media, .media .row { display: flex; gap: 2px; }
.media { flex-direction: column; }
.media img { display: block; object-fit: cover; }
body.played .bubble > *:not(.voice), body.played .voice > *:not(.wave-wrap), body.played .duration { visibility: hidden; }
body.played .bubble { background: none; box-shadow: none; }
</style></head><body>
<div class="card"><div class="bubble">
  <div class="author">${images.avatar ? `<img class="avatar" src="${images.avatar}">` : `<span class="avatar"></span>`}<span>${escapeHtml(card?.author ?? "")}</span>${position ? `<span class="position">${escapeHtml(position)}</span>` : ""}</div>
  <div class="voice"><div class="play"></div>
    <div class="wave-wrap"><div class="wave" data-waveform="${waveform.join(",")}"></div><div class="duration"></div></div></div>
  ${caption ? `<div class="text">${caption}</div>` : ""}
  ${reactions.length ? `<div class="reactions">${reactions.join("")}</div>` : ""}
  <div class="footer">${footer(post)}</div>
</div>${posts.join("")}</div>
</body></html>`;
}

// Tallest a photo bubble grows, and the least height it may take before the type shrinks.
const photoHeight = { max: 520, min: 140 };

// Runs inside the page. show() leaves one text post visible; fit() picks the scale that
// holds every slide; draw() paints the waveform in device pixels.
const pageScript = `
const card = document.querySelector(".card"), caption = document.querySelector(".bubble:not(.post) .text");
const posts = [...document.querySelectorAll(".post")];
const slides = posts.length ? posts.map((_, index) => index) : [0];
const box = (element) => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
// A photo bubble takes the height left under the voice; photos in a row share one height
// and keep their proportions, and every row stays within the card's width.
const album = (post, limit, width) => {
  const rows = [...post.querySelector(".media").children];
  const size = (height) => rows.forEach((row) => {
    const photos = [...row.children];
    const ratios = photos.map((photo) => photo.naturalWidth / photo.naturalHeight || 1);
    const sum = ratios.reduce((total, ratio) => total + ratio, 0);
    const fitted = Math.max(0, Math.min(height / rows.length, (width - 2 * (photos.length - 1)) / sum));
    photos.forEach((photo, index) => { photo.style.height = fitted + "px"; photo.style.width = fitted * ratios[index] + "px"; });
  });
  size(0);
  const free = limit - card.getBoundingClientRect().height;
  size(Math.min(free, ${photoHeight.max}));
  return free >= ${photoHeight.min};
};
window.show = (slide) => posts.forEach((post, index) => { post.style.display = index === slide ? "" : "none"; });
window.fit = (scales, area, padding) => {
  const fits = (scale, slide) => {
    card.style.width = area.width / scale + padding.width + "px";
    show(slide);
    const limit = area.height / scale + padding.height;
    if (posts[slide]?.classList.contains("photos")) return album(posts[slide], limit, area.width / scale);
    return card.getBoundingClientRect().height <= limit;
  };
  for (const scale of scales) if (slides.every((slide) => fits(scale, slide))) return scale;
  // Even the smallest type overflows: drop whole lines from the end of the slide's post,
  // then from the voice's own caption.
  const scale = scales[scales.length - 1];
  for (const slide of slides)
    for (const text of [posts[slide]?.querySelector(".text"), caption])
      for (let lines = text ? Math.round(text.scrollHeight / 21) : 0; !fits(scale, slide) && lines > 1; )
        text.style.webkitLineClamp = String(--lines);
  return scale;
};
window.draw = () => {
  // Bars fill the row and resample Telegram's 100-point, 5-bit waveform; a dip rises
  // to 60% of its taller neighbour so short pauses don't read as gaps.
  const wave = document.querySelector(".wave");
  const raw = wave.dataset.waveform ? wave.dataset.waveform.split(",").map(Number) : [];
  const dpr = devicePixelRatio, barW = Math.round(3 * dpr), gapW = Math.round(2 * dpr), maxH = Math.round(26 * dpr);
  const bars = Math.max(1, Math.floor((wave.parentElement.clientWidth * dpr + gapW) / (barW + gapW)));
  const peaks = Array.from({ length: bars }, (_, i) => {
    if (!raw.length) return 0;
    const from = Math.floor((i * raw.length) / bars), to = Math.max(from + 1, Math.floor(((i + 1) * raw.length) / bars));
    return Math.max(...raw.slice(from, to)) / 31;
  });
  const canvas = document.createElement("canvas");
  canvas.width = bars * (barW + gapW) - gapW;
  canvas.height = maxH;
  canvas.style.cssText = "display:block;width:" + canvas.width / dpr + "px;height:" + maxH / dpr + "px";
  const context = canvas.getContext("2d");
  context.fillStyle = document.body.classList.contains("played") ? "#40a7e3" : "#c5d7e6";
  peaks.forEach((peak, i) => {
    const level = Math.max(peak, 0.6 * Math.max(peaks[i - 1] ?? 0, peaks[i + 1] ?? 0));
    const height = Math.max(Math.round(2 * dpr), Math.round(level * maxH));
    context.beginPath();
    context.roundRect(i * (barW + gapW), maxH - height, barW, height, barW / 2);
    context.fill();
  });
  wave.replaceChildren(canvas);
  // Every slide is captured at the tallest one's size so the images overlay alike.
  const [x, y, width] = box(card);
  const height = Math.max(...slides.map((slide) => (show(slide), box(card)[3])));
  return { card: [x, y, width, height], wave: box(canvas), pixels: [canvas.width, canvas.height], timer: box(document.querySelector(".duration")) };
};
`;

const Rect = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]);
const Geometry = Schema.Struct({
  card: Rect,
  wave: Rect,
  pixels: Schema.Tuple([Schema.Number, Schema.Number]),
  timer: Rect,
});
const imageHosts = /(^|\.)(telesco\.pe|cdn-telegram\.org|telegram\.org|t\.me|cdn\.jsdelivr\.net)$/;

/** First available candidate as a data URI, or "" when every candidate is missing. */
async function imageData(candidates: readonly string[], signal: AbortSignal): Promise<string> {
  for (const candidate of candidates) {
    const url = new URL(candidate, "https://telegram.org");
    if (url.protocol !== "https:" || !imageHosts.test(url.hostname)) continue;
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.status >= 500) throw new Error(`Card image HTTP ${response.status}`);
    if (!response.ok || !type.startsWith("image/")) {
      await response.body?.cancel();
      continue;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Card image exceeds 2 MB");
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  return "";
}

// Telegram serves 40 px reaction emoji; emoji-datasource has the same Apple set at 64 px.
const emojiCandidates = (emoji: string, fallback: string) => {
  // File names are code points (not grapheme clusters) joined by "-".
  const code = (emoji.match(/./gsu) ?? [])
    .map((char) => char.codePointAt(0)!.toString(16))
    .filter((point) => point !== "fe0f")
    .join("-");
  const base = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/";
  return code ? [`${base}${code}.png`, `${base}${code}-fe0f.png`, fallback] : [fallback];
};

const pngSize = (bytes: Buffer) => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

export class PostCard extends Context.Service<
  PostCard,
  {
    /**
     * Write the card's slides and played layer into `work` and place them in the frame.
     * `texts` are the posts shown while the voice plays; `position` is its place in an episode.
     */
    render(
      post: Post,
      audioIndex: number,
      work: string,
      texts?: readonly Post[],
      position?: string,
    ): Effect.Effect<CardLayers, AppError>;
  }
>()("maddyvoice/PostCard") {
  static readonly layer = Layer.effect(
    PostCard,
    Effect.gen(function* () {
      const config = yield* Settings;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const render = Effect.fn("PostCard.render")(function* (
        post: Post,
        audioIndex: number,
        work: string,
        texts: readonly Post[] = [],
        position = "",
      ) {
        const images = yield* attempt("Download post card images", async (signal) => ({
          avatar: post.card?.avatar ? await imageData([post.card.avatar], signal) : "",
          reactions: await Promise.all(
            (post.card?.reactions ?? []).map((reaction) =>
              reaction.paid
                ? Promise.resolve("")
                : imageData(emojiCandidates(reaction.emoji, reaction.image), signal),
            ),
          ),
        }));
        // Photos that cannot be downloaded are left out, and so is a bubble left empty.
        const pages = yield* attempt("Download text post photos", async (signal) =>
          (
            await Promise.all(
              textSlides(texts).map(async (slide) => ({
                ...slide,
                photos: (
                  await Promise.all(slide.photos.map((photo) => imageData([photo], signal)))
                ).filter(Boolean),
              })),
            )
          ).filter((slide) => slide.text || slide.photos.length),
        );
        const font = yield* attempt(
          "Read card font",
          async () => `data:font/ttf;base64,${(await readFile(Paths.cardFont)).toString("base64")}`,
        );
        const page = yield* openPage(work).pipe(
          Effect.provideService(Settings, config),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        // A voice without text posts is a single slide.
        const slides = (pages.length ? pages : [undefined]).map((page, index) => ({
          image: join(work, `card-${index}.png`),
          // A photo bubble stays up as long as a post of 250 characters.
          weight: page?.photos.length ? 250 : Math.max(page?.text.length ?? 0, 150),
        }));
        const played = join(work, "card-played.png");
        const geometry = yield* attempt("Render post card", async () => {
          const area = {
            width: CardArea.right - CardArea.left,
            height: CardArea.bottom - CardArea.top,
          };
          const padding = {
            width: shadow.left + shadow.right,
            height: shadow.top + shadow.bottom,
          };
          await page.send("Emulation.setDefaultBackgroundColorOverride", {
            color: { r: 0, g: 0, b: 0, a: 0 },
          });
          await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1200,
            height: 1200,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await page.load(cardHtml(post, audioIndex, images, font, pages, position));
          await page.evaluate(pageScript);
          const scale = Number(
            await page.evaluate(
              `fit(${JSON.stringify(scales)}, ${JSON.stringify(area)}, ${JSON.stringify(padding)})`,
            ),
          );
          await page.send("Emulation.setDeviceMetricsOverride", {
            width: Math.ceil(area.width / scale + padding.width),
            height: Math.ceil(area.height / scale + padding.height) + 1,
            deviceScaleFactor: scale,
            mobile: false,
          });
          const layout = Schema.decodeUnknownSync(Geometry)(await page.evaluate("draw()"));
          const [, , width, height] = layout.card;
          for (const [index, slide] of slides.entries()) {
            await page.evaluate(`show(${index})`);
            await page.screenshot(slide.image, width, height);
          }
          await page.evaluate("document.body.classList.add('played'), draw()");
          await page.screenshot(played, width, height);
          return { scale, layout };
        });
        const size = pngSize(
          yield* attempt("Read card image", () =>
            readFile(played).then((bytes) => bytes.subarray(0, 24)),
          ),
        );
        const { scale, layout } = geometry;
        // Right-align the visible bubble; centre it a little above the middle, kept inside the area.
        const x = Math.round(CardArea.right + shadow.right * scale) - size.width;
        const y = Math.min(
          Math.max(
            Math.round((1080 - size.height) / 2) - 50,
            Math.round(CardArea.top - shadow.top * scale),
          ),
          Math.round(CardArea.bottom + shadow.bottom * scale) - size.height,
        );
        return {
          slides,
          played,
          x,
          y,
          wave: {
            x: Math.round(layout.wave[0] * scale),
            y: Math.round(layout.wave[1] * scale),
            width: layout.pixels[0],
            height: layout.pixels[1],
          },
          timer: {
            x: Math.round(layout.timer[0] * scale),
            y: Math.round(layout.timer[1] * scale + scale),
            size: Math.round(13 * scale),
          },
        } satisfies CardLayers;
      }, Effect.scoped);
      return PostCard.of({ render });
    }),
  );
}
