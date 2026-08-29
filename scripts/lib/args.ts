/**
 * Shared argv plumbing for the standalone maintenance scripts: read the
 * value of a `--name value` flag. Kept tiny on purpose; the scripts stay
 * individually runnable via pnpm tsx.
 */

/** The value following `--name` on the command line, or undefined. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
