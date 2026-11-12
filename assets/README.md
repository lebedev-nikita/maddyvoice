`ilya-maddyson.jpg`: the portrait of Ilya Maddyson selected as photo 10,
AI-restored and upscaled from 1280 × 853 to 1620 × 1080 pixels.
[Original image](https://click-or-die.ru/app/uploads/2025/06/photo_2024-07-31_13-33-46.jpg) ·
[Source article](https://click-or-die.ru/2025/06/ilya-meddison-vzyal-pereryv-ot-strimov-legenda-youtube-nazvala-uslovie-pri-kotorom-vernetsya-k-videoigram/).

Used as the source portrait for the backgrounds.
No Creative Commons license is asserted for it.

`backgrounds/`: twelve 1920 × 1080 AI-generated American scenes with the same
portrait on the left. A voice post without attached photos uses the background
at index `message_id % 12` in file-name order, so adding or removing a file
changes the rotation for newly rendered videos and thumbnails. The right side
stays clear for the post card.

`channel-logo.png`: the channel avatar, shown in the thumbnail's voice card.

`video-overlay.png`: the approved 1920 × 240 transparent lower-edge artwork,
including a soft shade, monochrome YouTube icon and `@MaddyvoiceArchive` handle.
The lettering is rasterized so video rendering needs no system font or drawing
library. The post card is drawn separately by `src/post-card.ts`.

Thumbnail lettering uses [Oswald](https://github.com/google/fonts/tree/main/ofl/oswald),
Copyright 2016 The Oswald Project Authors, under the SIL Open Font License 1.1.
The font and its license are bundled in `assets/fonts/`.

The post card and its timer use [Roboto](https://github.com/google/fonts/tree/main/ofl/roboto),
Copyright 2011 The Roboto Project Authors, under the SIL Open Font License 1.1
(`fonts/Roboto.ttf`, `fonts/Roboto-OFL.txt`). Reaction emoji are Apple images from
[emoji-datasource-apple](https://github.com/iamcal/emoji-data), downloaded at
render time; Telegram's own image is the fallback.
