import { describe, expect, it } from "vite-plus/test";
import { cardHtml } from "../src/post-card.ts";
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
