/**
 * The task classifier and the effort router, imported as `@ardurbot/core/effort-router`.
 * They run where a run is admitted, on the server; the browser never needs them, so they
 * stay out of the package index. The example set stays a test fixture.
 */
export * from "./classifier.js";
export * from "./local-classifier.js";
export * from "./route.js";
