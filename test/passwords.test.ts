import { randomBytes, scryptSync } from "node:crypto";
import { describe, it, expect } from "vite-plus/test";
import { hashPassword, needsRehash, verifyPassword } from "~/lib/passwords";

describe("password hashing (scrypt)", () => {
  it("round-trips a password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", stored),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("stores a self-describing string with the current scrypt parameters", async () => {
    const stored = await hashPassword("s3cret!");
    expect(stored).toMatch(/^\$scrypt\$N=65536,r=8,p=1\$/);
    const [, salt, hash] = stored.slice("$scrypt$".length).split("$");
    // 16-byte salt + 64-byte derived key, base64url.
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash!, "base64url")).toHaveLength(64);
  });

  it("salts per password — two hashes of the same password differ", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("verifies legacy salt:hash rows derived with the default scrypt cost", async () => {
    // The pre-format-change shape: 16-byte hex salt + 64-byte hex key,
    // derived with Node's default scrypt parameters (N=2^14, r=8, p=1).
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync("legacy-password", salt, 64).toString("hex");
    const legacy = `${salt}:${key}`;
    await expect(verifyPassword("legacy-password", legacy)).resolves.toBe(true);
    await expect(verifyPassword("not-it", legacy)).resolves.toBe(false);
  });

  it("needsRehash flags legacy rows but not current ones", async () => {
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync("legacy-password", salt, 64).toString("hex");
    expect(needsRehash(`${salt}:${key}`)).toBe(true);
    expect(needsRehash(await hashPassword("current"))).toBe(false);
  });

  it("fails closed on malformed stored strings", async () => {
    await expect(verifyPassword("x", "")).resolves.toBe(false);
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("x", ":hash-only")).resolves.toBe(false);
    await expect(
      verifyPassword("x", "$scrypt$N=65536,r=8,p=1$salt$hash"),
    ).resolves.toBe(false);
    // N=3 is not a power of two; garbage params fail closed.
    await expect(
      verifyPassword("x", "$scrypt$N=3,r=8,p=1$AAAA$AAAA"),
    ).resolves.toBe(false);
    // A legacy row with a truncated key fails closed.
    await expect(
      verifyPassword("x", `${randomBytes(16).toString("hex")}:abcd`),
    ).resolves.toBe(false);
  });
});
