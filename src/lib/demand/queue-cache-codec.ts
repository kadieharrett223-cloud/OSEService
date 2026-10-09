import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const decompress = promisify(gunzip);

// Next's data cache rejects entries above 2MB. Invoice payloads repeated on
// queue lines exceeded that limit, making every navigation rebuild the queue.
// Store the exact JSON losslessly: do not trim records, quantities or evidence.
export async function encodeQueueCache(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  const encoded = (await compress(json)).toString("base64");
  console.info("[canonical-queue-cache]", { jsonBytes: Buffer.byteLength(json), encodedBytes: Buffer.byteLength(encoded) });
  return encoded;
}

export async function decodeQueueCache<T>(encoded: string): Promise<T> {
  const json = await decompress(Buffer.from(encoded, "base64"));
  return JSON.parse(json.toString("utf8")) as T;
}
