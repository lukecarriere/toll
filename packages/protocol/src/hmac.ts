import { utf8, timingSafeEqual } from "./bytes.ts";

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = globalThis.crypto.subtle.importKey("raw", utf8(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, data as BufferSource));
}

export async function hmacVerify(secret: string, data: Uint8Array, mac: Uint8Array): Promise<boolean> {
  const expected = await hmacSha256(secret, data);
  return timingSafeEqual(expected, mac);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource));
}
