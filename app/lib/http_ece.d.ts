declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  export interface DecryptOptions {
    version?: "aes128gcm" | "aesgcm";
    privateKey: ECDH;
    authSecret?: string;
  }

  export interface EncryptOptions {
    version?: "aes128gcm" | "aesgcm";
    dh: string | Buffer;
    privateKey: ECDH;
    authSecret?: string;
  }

  export function decrypt(buffer: Buffer, options: DecryptOptions): Buffer;
  export function encrypt(buffer: Buffer, options: EncryptOptions): Buffer;
}
