import { sha256 } from "@noble/hashes/sha2.js";
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data,
      hash = sha256.create();
    for (let offset = 0; offset < file.size; offset += 4 * 1024 ** 2) {
      hash.update(
        new Uint8Array(
          await file.slice(offset, offset + 4 * 1024 ** 2).arrayBuffer(),
        ),
      );
      self.postMessage({
        progress: Math.min(file.size, offset + 4 * 1024 ** 2) / file.size,
      });
    }
    self.postMessage({
      hash: Array.from(hash.digest(), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
