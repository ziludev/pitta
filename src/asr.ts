import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { log, logError } from "./log.ts";

const run = promisify(execFile);

export type AsrResult = { ok: true; text: string } | { ok: false; error: string };

async function has(bin: string): Promise<boolean> {
  try {
    await run("/usr/bin/env", ["which", bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Feishu voice messages arrive as opus/amr blobs. Convert to 16 kHz mono wav with
 * ffmpeg, then let a local whisper CLI do the transcription — no API key, no
 * audio leaving the machine.
 */
export async function transcribeAudio(input: Buffer, extension = "opus"): Promise<AsrResult> {
  if (config.asr.mode === "off") return { ok: false, error: "asr disabled" };
  if (!(await has(config.asr.ffmpeg))) return { ok: false, error: `${config.asr.ffmpeg} not found` };
  if (!(await has(config.asr.whisper))) return { ok: false, error: `${config.asr.whisper} not found` };

  // Never start a download inside a request: it looks like a hang and blocks the turn.
  const modelArg =
    config.asr.modelPath.length > 0
      ? config.asr.modelPath
      : join(homedir(), ".cache", "whisper", `${config.asr.model}.pt`);
  if (!existsSync(modelArg)) {
    return { ok: false, error: `whisper 模型还没下载好（${modelArg}）` };
  }

  const dir = await mkdtemp(join(tmpdir(), "asr-"));
  const source = join(dir, `input.${extension}`);
  const wav = join(dir, "audio.wav");
  try {
    await writeFile(source, input);
    await run(config.asr.ffmpeg, ["-y", "-loglevel", "error", "-i", source, "-ar", "16000", "-ac", "1", wav], {
      timeout: 60_000,
    });

    const startedAt = Date.now();
    await run(
      config.asr.whisper,
      [
        wav,
        "--model",
        modelArg,
        "--language",
        config.asr.language,
        "--output_format",
        "txt",
        "--output_dir",
        dir,
        "--verbose",
        "False",
        "--fp16",
        "False",
      ],
      { timeout: 300_000 },
    );
    const text = (await readFile(join(dir, "audio.txt"), "utf8")).trim();
    log("asr", "transcribed", { chars: text.length, ms: Date.now() - startedAt, model: config.asr.model });
    return { ok: true, text };
  } catch (error) {
    logError("asr", "transcription failed", error);
    return { ok: false, error: (error as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
