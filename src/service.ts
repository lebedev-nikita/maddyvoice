import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import { AppError, attempt, Settings } from "./core.ts";

const exec = promisify(execFile);
const label = "com.maddyvoice.worker";
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

async function writeAgent(config: Settings["Service"], root: string, file: string) {
  await mkdir(dirname(file), { recursive: true });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const environment = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    DATA_DIR: config.dataDir,
    TELEGRAM_CHANNEL: config.channel,
    POLL_SECONDS: String(config.pollSeconds),
    YOUTUBE_PRIVACY: config.privacy,
    FFMPEG_PATH: config.ffmpeg,
    FFPROBE_PATH: config.ffprobe,
    YOUTUBE_CHANNEL_ID: config.expectedChannel,
  };
  const variables = Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("\n");
  await writeFile(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, "src/+cli.ts"))}</string><string>run</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${variables}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(config.dataDir, "worker.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(config.dataDir, "worker.log"))}</string>
</dict></plist>\n`,
    { mode: 0o600 },
  );
}

export const manageService = Effect.fn("manageService")(function* (
  action: "install" | "start" | "stop" | "status" | "uninstall",
) {
  if (process.platform !== "darwin")
    return yield* new AppError({
      message:
        "The service command uses macOS launchd. On Linux, run `bun start` under your service manager.",
    });
  const config = yield* Settings;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const file = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid?.()}`;
  return yield* attempt("Manage background worker", async (signal) => {
    const loaded = () =>
      exec("launchctl", ["print", `${domain}/${label}`], { signal }).then(
        () => true,
        () => false,
      );
    const stop = async () => {
      if (await loaded()) await exec("launchctl", ["bootout", `${domain}/${label}`], { signal });
    };
    const start = async () => {
      if (await loaded()) return;
      await exec("launchctl", ["bootstrap", domain, file], { signal });
      console.log(
        `Background worker loaded: every ${config.pollSeconds}s while this Mac is awake. Logs: ${join(config.dataDir, "worker.log")}`,
      );
    };
    const actions = {
      install: async () => {
        await stop();
        await writeAgent(config, root, file);
        await start();
      },
      start,
      stop: async () => {
        await stop();
        console.log("Background worker stopped until next login or `service start`");
      },
      uninstall: async () => {
        await stop();
        await rm(file, { force: true });
        console.log("Background worker uninstalled; recordings and authorization retained");
      },
      status: async () => {
        console.log(
          (await loaded())
            ? `Background worker is loaded. Logs: ${join(config.dataDir, "worker.log")}`
            : "Background worker is not loaded",
        );
      },
    };
    await actions[action]();
  });
});
