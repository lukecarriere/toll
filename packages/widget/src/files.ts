// Node entry for the published package. The page script is dist/toll.js (built separately);
// these URLs point at the files shipped next to dist/index.js.

function packagedFile(name: string): URL {
  return new URL(name, import.meta.url);
}

/** Page script. */
export const tollJs = packagedFile("./toll.js");
/** Standard-mode worker. */
export const tollWorker = packagedFile("./toll.worker.js");
/** Hardened-mode worker, loaded only when a check asks for it. */
export const tollWorkerArgon2id = packagedFile("./toll.worker-argon2id.js");
/** Third-party notices for the page script and workers. */
export const licenses = packagedFile("./LICENSES.txt");
