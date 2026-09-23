/**
 * Frame recorder for the landing-page demo (`pnpm demo`): drives the real app
 * in a browser, samples frames with the hold each state deserves, and hands
 * ffmpeg a concat list to join them.
 *
 * A UI demo needs a timeline the app cannot supply on its own: some states
 * should sit on screen long enough to read (the list, the filled fields),
 * while the cursor moving and the text being typed are pure motion. So this
 * records explicit frames with explicit holds rather than a real-time screen
 * capture, which also makes a re-run reproduce the same cut.
 *
 * The pointer is the one thing in the video the app does not draw: an init
 * script appends a cursor and follows the real mouse, because a browser
 * records no pointer of its own.
 *
 * ffmpeg does the encoding (both an H.264 mp4 and a VP9 webm, plus the WebP
 * poster the page shows first), so the demo build needs it on PATH.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Locator, Page } from "playwright";

/** The cursor the page draws: a filled pointer, drawn over everything, and
 * hidden from the accessibility tree and from hit testing. */
const CURSOR_SCRIPT = `(() => {
  const ID = "__demo_cursor";
  const place = (x, y) => {
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;left:-100px;top:-100px;width:20px;height:20px;z-index:2147483647;pointer-events:none";
      el.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M3.5 1.2 16.4 10.6l-5.1.7-2.6 5.1z" fill="#111827" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      (document.body ?? document.documentElement).appendChild(el);
    }
    el.style.left = x + "px";
    el.style.top = y + "px";
  };
  document.addEventListener(
    "mousemove",
    (e) => place(e.clientX, e.clientY),
    true,
  );
})();`;

export interface DemoRecorder {
  /** Capture the current frame and hold it for `holdMs` milliseconds. */
  shot(holdMs?: number): Promise<void>;
  /** Put the pointer somewhere without recording the move: a scene should not
   * open with the cursor flying in from wherever the last one ended. */
  place(x: number, y: number): Promise<void>;
  /** Move the pointer to a point, sampling the motion frame by frame. */
  glideTo(x: number, y: number): Promise<void>;
  /** Glide to an element's center, pause, then click it. */
  click(locator: Locator): Promise<void>;
  /** Glide to a field, click it, and type the text a few characters at a
   * time so the typing is visible. */
  typeInto(locator: Locator, text: string): Promise<void>;
  /** Encode the sampled frames into the video files the page serves. */
  finish(outputs: {
    width: number;
    height: number;
    poster: string;
    mp4: string;
    webm: string;
  }): Promise<{ seconds: number; frames: number }>;
}

export interface DemoRecorderOptions {
  /** Frames land here (a temp dir unless a path is pinned for debugging). */
  dir?: string;
  /** Motion sample interval, in milliseconds: the hold given to each step of
   * a glide or a burst of typing. */
  stepMs?: number;
}

export async function createDemoRecorder(
  page: Page,
  options: DemoRecorderOptions = {},
): Promise<DemoRecorder> {
  const dir = options.dir ?? join(tmpdir(), `expense-demo-${process.pid}`);
  const stepMs = options.stepMs ?? 90;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await page.addInitScript(CURSOR_SCRIPT);

  const frames: { file: string; ms: number }[] = [];
  let pointer = { x: 0, y: 0 };

  /** Capture one frame. The cursor is placed from the real mouse position by
   * the init script, so a frame taken right after a move shows it there. */
  async function shot(holdMs = 320): Promise<void> {
    // A state React has committed is not necessarily painted yet, and a
    // screenshot taken between the two is a frame of the state before it.
    // Two animation frames put the capture after the paint: without this the
    // one frame that shows the drop highlight can miss it entirely.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const name = `f${String(frames.length).padStart(4, "0")}.png`;
    const file = join(dir, name);
    await page.screenshot({ path: file });
    frames.push({ file, ms: holdMs });
  }

  /** Sample a straight line from the pointer's current spot to (x, y). The
   * browser eases nothing, so the steps are equal: what reads as motion in
   * the video is the sampler's cadence, not an animation. */
  async function glideTo(x: number, y: number): Promise<void> {
    const from = { ...pointer };
    const steps = Math.max(
      4,
      Math.round(Math.hypot(x - from.x, y - from.y) / 90),
    );
    for (let i = 1; i <= steps; i++) {
      pointer = {
        x: Math.round(from.x + ((x - from.x) * i) / steps),
        y: Math.round(from.y + ((y - from.y) * i) / steps),
      };
      await page.mouse.move(pointer.x, pointer.y);
      await shot(stepMs);
    }
  }

  async function place(x: number, y: number): Promise<void> {
    pointer = { x, y };
    await page.mouse.move(x, y);
  }

  async function click(locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    if (!box) throw new Error("demo: element has no box to click");
    await glideTo(box.x + box.width / 2, box.y + box.height / 2);
    await shot(500);
    await locator.click();
  }

  async function typeInto(locator: Locator, text: string): Promise<void> {
    await click(locator);
    await shot(300);
    // Two characters per frame: fast enough to look like typing, slow enough
    // that every frame differs (a frame that matches the last one is a frame
    // the encoder pays for and nobody sees).
    for (let i = 0; i < text.length; i += 2) {
      await locator.pressSequentially(text.slice(i, i + 2), { delay: 20 });
      await shot(stepMs);
    }
  }

  async function finish(outputs: {
    width: number;
    height: number;
    poster: string;
    mp4: string;
    webm: string;
  }): Promise<{ seconds: number; frames: number }> {
    const { width, height } = outputs;
    // The concat demuxer wants the last frame's duration repeated as a plain
    // file entry, or the tail is dropped.
    const list = [
      ...frames.map(
        (f) => `file '${f.file}'\nduration ${(f.ms / 1000).toFixed(3)}`,
      ),
      `file '${frames.at(-1)!.file}'`,
    ].join("\n");
    const listFile = join(dir, "frames.txt");
    await writeFile(listFile, `${list}\n`);

    const scale = `scale=${width}:${height}:flags=lanczos`;
    await run("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `${scale},fps=15`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-tune",
      "stillimage",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputs.mp4,
    ]);
    await run("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `${scale},fps=15`,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "36",
      "-b:v",
      "0",
      "-tune-content",
      "screen",
      "-row-mt",
      "1",
      "-deadline",
      "good",
      "-cpu-used",
      "3",
      "-pix_fmt",
      "yuv420p",
      outputs.webm,
    ]);
    // The poster is the video's own first frame, so the still the page shows
    // before playback is the frame playback starts on.
    await sharp(frames[0]!.file)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputs.poster);

    const seconds = frames.reduce((sum, f) => sum + f.ms, 0) / 1000;
    await rm(dir, { recursive: true, force: true });
    return { seconds, frames: frames.length };
  }

  return { shot, place, glideTo, click, typeInto, finish };
}

/** Run a command, rejecting with its stderr tail. */
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code}: ${stderr}`)),
    );
  });
}
