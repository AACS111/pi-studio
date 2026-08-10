import { ensureBrowserSidecar } from "./lib/browser-sidecar.ts";
await ensureBrowserSidecar();
console.log("sidecar boot requested");
// keep parent alive 60s so the sidecar has a parent; real parent is the dev server
await new Promise((r) => setTimeout(r, 60000));
