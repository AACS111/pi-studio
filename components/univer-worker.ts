// Formula worker entry for the spreadsheet viewer. Next.js bundles this file
// into a separate worker chunk when XlsxViewer constructs
// `new Worker(new URL("./univer-worker.ts", import.meta.url), { type: "module" })`.
import { createUniver } from "@univerjs/presets";
import { UniverSheetsCoreWorkerPreset } from "@univerjs/preset-sheets-core/worker";
import { UniverSheetsFilterWorkerPreset } from "@univerjs/preset-sheets-filter/worker";

createUniver({
  presets: [UniverSheetsCoreWorkerPreset(), UniverSheetsFilterWorkerPreset()],
});
