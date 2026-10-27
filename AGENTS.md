# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Publication state

Persist resumable YouTube session URLs before sending video bytes. An expired
session with an uncertain outcome requires reconciliation, never a fresh upload.
Keep live polling's high-water mark independent from historical imports.
