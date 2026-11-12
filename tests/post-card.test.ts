import { describe, expect, it } from "vite-plus/test";
import { cardHtml, textPages, textSlides } from "../src/post-card.ts";
import type { Post } from "../src/telegram.ts";

const post: Post = {
  id: 7,
  url: "https://t.me/maddysontg/7",
  date: "2026-11-08T12:33:31.000Z",
  text: "<b>Привет</b> & пока\n\nВторой абзац",
  audio: ["https://cdn4.telesco.pe/a.ogg"],
  images: [],
  forwarded: false,
  card: {
    author: '"Канал"',
    avatar: "https://cdn4.telesco.pe/avatar.jpg",
    views: "40K",
    edited: true,
    reactions: [
      { emoji: "❤", image: "", count: "2.1K", paid: false },
      { emoji: "", image: "", count: "5", paid: true },
    ],
    waveforms: [[1, 2, 3]],
  },
};

describe("post card markup", () => {
  it("escapes post text, keeps paragraphs and shows Moscow time", () => {
    const html = cardHtml(post, 0, { avatar: "", reactions: ["data:image/png;base64,AA", ""] }, "");
    expect(html).toContain("<p>&#60;b&#62;Привет&#60;/b&#62; &#38; пока</p><p>Второй абзац</p>");
    expect(html).toContain("&#34;Канал&#34;");
    expect(html).toContain("изменено 15:33");
    expect(html).toContain('data-waveform="1,2,3"');
    expect(html).toContain('<img src="data:image/png;base64,AA">2.1K');
    expect(html).toContain('class="reaction paid"');
  });

  it("falls back to the emoji glyph when no image is available", () => {
    const html = cardHtml(post, 0, { avatar: "", reactions: ["", ""] }, "");
    expect(html).toContain('<span class="glyph">❤</span>2.1K');
  });
});

describe("text post slides", () => {
  const text: Post = { ...post, id: 8, text: "Пост <i>рядом</i>", audio: [], card: undefined };

  it("keeps a short post on one page and splits a long one between paragraphs", () => {
    expect(textPages("  Коротко\n\nи ясно ")).toEqual(["Коротко\n\nи ясно"]);
    const paragraph = "Абзац текста. ".repeat(20).trim();
    const pages = textPages([paragraph, paragraph, paragraph, paragraph].join("\n\n"), 700);
    expect(pages).toEqual([`${paragraph}\n\n${paragraph}`, `${paragraph}\n\n${paragraph}`]);
  });

  it("leaves no stray last paragraph on a page of its own", () => {
    const [first, second, tail] = ["а".repeat(470), "б".repeat(412), "Пссс. И ещё строка."];
    expect(textPages([first, second, tail].join("\n\n"), 700)).toEqual([
      first,
      `${second}\n\n${tail}`,
    ]);
    expect(textPages("  ")).toEqual([]);
  });

  it("splits an oversized paragraph at sentences, then words, and loses no text", () => {
    const sentence = "Это довольно длинное предложение без единой точки внутри";
    const long = `${Array.from({ length: 30 }, () => `${sentence}.`).join(" ")}\n${"слово ".repeat(200).trim()}`;
    const pages = textPages(long, 300);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.every((page) => page.length <= 300)).toBe(true);
    expect(pages.slice(0, 3).every((page) => page.endsWith("."))).toBe(true);
    expect(pages.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });

  it("numbers the pages of each post", () => {
    const long = { ...text, id: 9, text: "Длинное предложение. ".repeat(60) };
    expect(
      textSlides([text, long]).map((slide) => [slide.post.id, slide.page, slide.pages]),
    ).toEqual([
      [8, 1, 1],
      [9, 1, 2],
      [9, 2, 2],
    ]);
  });

  it("adds one bubble per slide under the voice and marks the episode position", () => {
    const long = { ...text, id: 9, text: "Длинное предложение. ".repeat(60) };
    const html = cardHtml(
      post,
      0,
      { avatar: "", reactions: ["", ""] },
      "",
      textSlides([text, long]),
      "2 / 5",
    );
    expect(html.match(/class="bubble post"/g)).toHaveLength(3);
    expect(html).toContain("<p>Пост &#60;i&#62;рядом&#60;/i&#62;</p>");
    expect(html).toContain('<span class="page">1 / 2</span>');
    expect(html).toContain('<span class="position">2 / 5</span>');
    expect(html.indexOf('class="voice"')).toBeLessThan(html.indexOf('class="bubble post"'));
    const alone = cardHtml(post, 0, { avatar: "", reactions: ["", ""] }, "");
    expect(alone).not.toContain('class="bubble post"');
    expect(alone).not.toContain('class="position"');
  });
});
