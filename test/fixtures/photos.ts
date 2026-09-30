import { Buffer } from "node:buffer";

/** Storage fixture with a JPEG signature and deterministic binary contents. */
export function photoBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index++) bytes[index] = index % 256;
	bytes.set([0xff, 0xd8, 0xff, 0xe0]);
	return bytes;
}

export function photoBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
