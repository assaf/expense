#!/usr/bin/env tsx

/**
 * Review screenshot drift against the committed baselines in screenshots/
 * (adapted from rentail/scripts/screenshots.ts).
 *
 * - A .png with a matching .new.png (a failed toMatchScreenshot): compare
 *   .new.png vs .png, Accept or Skip.
 * - A committed .png modified locally but with no .new.png (edited by hand
 *   or accepted outside a test run): compare vs the Git HEAD version,
 *   Revert or Keep.
 *
 * Usage:
 *   pnpm screenshots:review
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";

type Item = {
  keepPath?: string;
  mode: "modified" | "accept" | "next" | "new-only";
  name: string;
  newPath: string;
  oldPath?: string;
};

const screenshotsDir = resolve(import.meta.dirname, "..", "screenshots");
const repoRoot = resolve(import.meta.dirname, "..");

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitShow(relPath: string, destPath: string): boolean {
  try {
    const data = execSync(`git show HEAD:"${relPath}"`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
    writeFileSync(destPath, data);
    return true;
  } catch {
    return false;
  }
}

function findNewScreenshots(): string[] {
  const results: string[] = [];
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(".new.png")) results.push(path);
    }
  }
  if (existsSync(screenshotsDir)) scan(screenshotsDir);
  return results;
}

const newScreenshots = findNewScreenshots();
const gitTempFiles: string[] = [];

// Also detect committed .png files that have been modified (differ from Git)
const modifiedPaths = new Set(
  newScreenshots.map((p) => p.replace(/\.new\.png$/, ".png")),
);
const modifiedItems: Item[] = [];
if (existsSync(screenshotsDir)) {
  function scanModified(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanModified(path);
      } else if (
        entry.name.endsWith(".png") &&
        !entry.name.endsWith(".new.png") &&
        !entry.name.endsWith(".diff.png") &&
        !entry.name.endsWith(".git.png")
      ) {
        // Skip if there's already a .new.png for this file
        if (modifiedPaths.has(path)) continue;
        const relPath = relative(screenshotsDir, path);
        const gitRelPath = join("screenshots", relPath);
        const gitAbsolutePath = join(
          screenshotsDir,
          relPath.replace(/\.png$/, ".git.png"),
        );
        const gotGit = gitShow(gitRelPath, gitAbsolutePath);
        if (!gotGit) continue;
        const currentHash = hashFile(path);
        const gitHash = hashFile(gitAbsolutePath);
        if (currentHash === gitHash) {
          unlinkSync(gitAbsolutePath);
          continue;
        }
        gitTempFiles.push(gitAbsolutePath);
        modifiedItems.push({
          name: relPath.replace(/\.png$/, ""),
          newPath: "/" + relPath,
          oldPath: "/" + relPath.replace(/\.png$/, ".git.png"),
          mode: "modified" as const,
          keepPath: "/" + relPath,
        });
      }
    }
  }
  scanModified(screenshotsDir);
}

if (newScreenshots.length === 0 && modifiedItems.length === 0) {
  console.info("No new screenshots to review.");
  process.exit(0);
}

console.info(
  `Found ${newScreenshots.length} new + ${modifiedItems.length} modified screenshot(s) to review.`,
);

const htmlPath = join(screenshotsDir, "review.html");

const items: Item[] = [
  ...newScreenshots.map((absoluteNewPath) => {
    const absoluteOldPath = absoluteNewPath.replace(/\.new\.png$/, ".png");
    const relativeNewPath = absoluteNewPath
      .replace(screenshotsDir, "")
      .replace(/^\//, "");
    const relativeOldPath = relativeNewPath.replace(/\.new\.png$/, ".png");
    const relativeGitPath = relativeNewPath.replace(/\.new\.png$/, ".git.png");

    const hasLocal = existsSync(absoluteOldPath);

    if (hasLocal) {
      return {
        name: relativeNewPath.replace(/\.new\.png$/, ""),
        newPath: relativeNewPath,
        oldPath: relativeOldPath,
        mode: "accept" as const,
      };
    }

    // No local .png — try Git
    const gitAbsolutePath = join(screenshotsDir, relativeGitPath);
    const gotGit = gitShow(
      join("screenshots", relativeOldPath),
      gitAbsolutePath,
    );
    if (gotGit) {
      gitTempFiles.push(gitAbsolutePath);
      return {
        name: relativeNewPath.replace(/\.new\.png$/, ""),
        newPath: relativeNewPath,
        oldPath: relativeGitPath,
        mode: "next" as const,
      };
    }

    // Neither local nor Git — show new only
    return {
      name: relativeNewPath.replace(/\.new\.png$/, ""),
      newPath: relativeNewPath,
      mode: "new-only" as const,
    };
  }),
  ...modifiedItems,
];

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Screenshot Review</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a1a; color: #fff; padding: 20px; }
    h1 { margin-bottom: 20px; font-size: 24px; }
    .item { margin-bottom: 40px; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
    .item-header { padding: 12px 16px; background: #252525; display: flex; justify-content: space-between; align-items: center; }
    .item-name { font-family: monospace; font-size: 14px; }
    .item-actions { display: flex; gap: 8px; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
    .accept { background: #22c55e; color: #000; }
    .accept:hover { background: #16a34a; }
    .skip, .next { background: #6b7280; color: #fff; }
    .skip:hover, .next:hover { background: #4b5563; }
    .next { background: #f59e0b; color: #000; }
    .next:hover { background: #d97706; }
    .images { display: flex; gap: 20px; padding: 20px; background: #0a0a0a; }
    .images.single { justify-content: center; }
    .image-panel { flex: 1; min-width: 0; }
    .image-panel h3 { margin-bottom: 12px; font-size: 14px; color: #888; }
    .image-panel img { max-width: 100%; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .done { text-align: center; padding: 60px; font-size: 18px; color: #888; }
    .hint { position: fixed; bottom: 20px; right: 20px; background: #333; padding: 12px 16px; border-radius: 8px; font-size: 13px; color: #888; }
    kbd { background: #555; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    .source-badge { font-size: 11px; padding: 2px 6px; border-radius: 3px; margin-left: 8px; font-family: monospace; }
    .source-badge.git { background: #f59e0b; color: #000; }
  </style>
</head>
<body>
  <h1>Screenshot Review</h1>
  <div id="items"></div>
  <div class="hint">Press <kbd>A</kbd> to accept, <kbd>S</kbd> to skip, <kbd>N</kbd> for next, <kbd>Esc</kbd> to close</div>
  <script>
    const items = ${JSON.stringify(items)};
    let currentIndex = 0;
    const container = document.getElementById("items");

    const placeholderSvg = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22><rect fill=%22%23333%22 width=%22400%22 height=%22300%22/><text x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23666%22 font-family=%22sans-serif%22>Not found</text></svg>';

    function shutdown() {
      // sendBeacon survives page unload (unlike fetch), so closing the tab
      // also reliably stops the server.
      navigator.sendBeacon('/shutdown');
    }

    function render() {
      if (currentIndex >= items.length) {
        container.innerHTML = '<div class="done">All screenshots reviewed! Server stopped — you can close this tab.</div>';
        shutdown();
        return;
      }
      const item = items[currentIndex];

      let panels, actions, sourceBadge;
      if (item.mode === "accept") {
        sourceBadge = "";
        panels = \`
          <div class="images">
            <div class="image-panel">
              <h3>Baseline</h3>
              <img src="\${item.oldPath}" onerror="this.src='\${placeholderSvg}'">
            </div>
            <div class="image-panel">
              <h3>New</h3>
              <img src="\${item.newPath}">
            </div>
          </div>
        \`;
        actions = \`
          <button class="skip" onclick="skip()">Skip (S)</button>
          <button class="accept" onclick="accept()">Accept (A)</button>
        \`;
      } else if (item.mode === "next") {
        sourceBadge = '<span class="source-badge git">vs Git</span>';
        panels = \`
          <div class="images">
            <div class="image-panel">
              <h3>Git (HEAD)</h3>
              <img src="\${item.oldPath}" onerror="this.src='\${placeholderSvg}'">
            </div>
            <div class="image-panel">
              <h3>New</h3>
              <img src="\${item.newPath}">
            </div>
          </div>
        \`;
        actions = \`
          <button class="next" onclick="next()">Next (N)</button>
        \`;
      } else if (item.mode === "modified") {
        sourceBadge = '<span class="source-badge git">modified</span>';
        panels = \`
          <div class="images">
            <div class="image-panel">
              <h3>Git (HEAD)</h3>
              <img src="\${item.oldPath}" onerror="this.src='\${placeholderSvg}'">
            </div>
            <div class="image-panel">
              <h3>Current (modified)</h3>
              <img src="\${item.newPath}">
            </div>
          </div>
        \`;
        actions = \`
          <button class="skip" onclick="revert()">Revert to Git</button>
          <button class="accept" onclick="keep()">Keep (K)</button>
        \`;
      } else {
        sourceBadge = '<span class="source-badge" style="background:#555;color:#aaa">new</span>';
        panels = \`
          <div class="images single">
            <div class="image-panel" style="max-width:600px">
              <h3>New (no baseline)</h3>
              <img src="\${item.newPath}">
            </div>
          </div>
        \`;
        actions = \`
          <button class="next" onclick="next()">Next (N)</button>
        \`;
      }

      container.innerHTML = \`
        <div class="item" data-index="\${currentIndex}">
          <div class="item-header">
            <span class="item-name">\${item.name}\${sourceBadge}</span>
            <div class="item-actions">\${actions}</div>
          </div>
          \${panels}
        </div>
      \`;
      document.querySelector('button:last-child')?.focus();
    }

    async function accept() {
      const item = items[currentIndex];
      await fetch("/accept?path=" + encodeURIComponent(item.newPath));
      currentIndex++;
      render();
    }
    async function revert() {
      const item = items[currentIndex];
      await fetch("/revert?git=" + encodeURIComponent(item.oldPath) + "&target=" + encodeURIComponent(item.newPath));
      currentIndex++;
      render();
    }
    function skip() { currentIndex++; render(); }
    function next() { currentIndex++; render(); }
    function keep() { currentIndex++; render(); }

    document.addEventListener("keydown", (e) => {
      if (e.key === "a" || e.key === "A") accept();
      else if (e.key === "s" || e.key === "S") skip();
      else if (e.key === "n" || e.key === "N") next();
      else if (e.key === "k" || e.key === "K") keep();
      else if (e.key === "r" || e.key === "R") revert();
      else if (e.key === "Escape") {
        shutdown();
        window.close();
      }
    });
    window.addEventListener('beforeunload', shutdown);
    render();
  </script>
</body>
</html>`;

writeFileSync(htmlPath, html);

function handleAccept(relPath: string, res: ServerResponse): void {
  const newPath = join(screenshotsDir, relPath);
  if (!existsSync(newPath)) {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  const oldPath = newPath.replace(/\.new\.png$/, ".png");
  const diffPath = newPath.replace(/\.new\.png$/, ".diff.png");
  const gitPath = newPath.replace(/\.new\.png$/, ".git.png");

  if (existsSync(oldPath)) unlinkSync(oldPath);
  renameSync(newPath, oldPath);
  if (existsSync(diffPath)) unlinkSync(diffPath);
  if (existsSync(gitPath)) unlinkSync(gitPath);

  console.info(`Accepted: ${relPath.replace(/\.new\.png$/, "")}`);
  res.writeHead(200);
  res.end("ok");
}

function handleRevert(
  gitRelPath: string,
  targetRelPath: string,
  res: ServerResponse,
): void {
  const gitPath = join(screenshotsDir, gitRelPath);
  const targetPath = join(screenshotsDir, targetRelPath);
  if (existsSync(gitPath) && existsSync(targetPath)) {
    writeFileSync(targetPath, readFileSync(gitPath));
    unlinkSync(gitPath);
    console.info(`Reverted: ${targetRelPath.replace(/^\//, "")}`);
  }
  res.writeHead(200);
  res.end("ok");
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".png": "image/png",
  ".css": "text/css",
  ".js": "application/javascript",
};

function serveStatic(filePath: string, res: ServerResponse): void {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
  });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/accept") {
    const relPath = url.searchParams.get("path");
    if (relPath) handleAccept(relPath, res);
    else {
      res.writeHead(200);
      res.end("ok");
    }
    return;
  }
  if (url.pathname === "/revert") {
    const gitRelPath = url.searchParams.get("git");
    const targetRelPath = url.searchParams.get("target");
    if (gitRelPath && targetRelPath)
      handleRevert(gitRelPath, targetRelPath, res);
    else {
      res.writeHead(200);
      res.end("ok");
    }
    return;
  }
  if (url.pathname === "/shutdown") {
    res.writeHead(200);
    res.end("ok");
    // Respond first, then clean up and exit after a tick so the fetch completes.
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 50);
    return;
  }
  serveStatic(join(screenshotsDir, url.pathname), res);
});

const port = 3456;
server.listen(port, () => {
  console.info(`Opening http://localhost:${port}/review.html`);
  execSync(`open http://localhost:${port}/review.html`);
});

function cleanup() {
  server.close();
  for (const f of gitTempFiles) {
    try {
      unlinkSync(f);
    } catch {
      /* ok */
    }
  }
  if (existsSync(htmlPath)) unlinkSync(htmlPath);
  console.info("\nDone.");
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
