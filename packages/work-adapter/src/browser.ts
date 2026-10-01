// Browser half of the work adapter: the engine's headless multi-worker solver, re-exported so the
// widget source never names the engine. Bundled into toll.js by packages/widget/build.mjs.
// The workers it drives are the engine's prebuilt standalone workers (see docs/adapters.md).
export { solveChallengeWorkers as solveWithWorkers } from "altcha-lib";
