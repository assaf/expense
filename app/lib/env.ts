import "node:process";

const env = process.env;

/** Absolute directory holding CSV state and image files. Volume-mounted in prod. */
export const DATA_DIR = env.DATA_DIR ?? "data";

export const isProd = env.NODE_ENV === "production";
