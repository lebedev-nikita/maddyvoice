import type { Post } from "./telegram.ts";

/** Silence between voices that ends an episode. */
export const episodeGapMs = 6 * 3600_000;

export type Recording = { readonly post: Post; readonly audioIndex: number };

const time = (post: Post) => Date.parse(post.date);

/**
 * Split a contiguous stretch of the feed into episodes: runs of recordings in feed order with
 * less than a gap of silence between them. Forwarded posts are left out.
 */
export function groupEpisodes(posts: readonly Post[], gapMs = episodeGapMs): Recording[][] {
  const original = posts.filter((post) => !post.forwarded).sort((a, b) => a.id - b.id);
  const episodes: Recording[][] = [];
  let last = -Infinity;
  for (const post of original) {
    if (post.audio.length === 0) continue;
    if (time(post) - last >= gapMs) episodes.push([]);
    episodes.at(-1)!.push(...post.audio.map((_, audioIndex) => ({ post, audioIndex })));
    last = time(post);
  }
  return episodes;
}
