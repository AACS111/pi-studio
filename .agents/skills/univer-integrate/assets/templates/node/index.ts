/**
 * Minimal Node.js headless integration for Univer Sheets
 * No UI, no render engine, no CSS. Suitable for server-side generation,
 * automated testing, or headless data processing.
 *
 * Dependencies:
 *   @univerjs/core @univerjs/engine-formula @univerjs/sheets @univerjs/sheets-formula
 *
 * Optional (for formula offloading via Worker):
 *   @univerjs/rpc-node
 */

import { LocaleType, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import SheetsEnUS from '@univerjs/sheets/locale/en-US';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';

// Facade side-effects — only import what you actually use.
// In headless mode you typically do NOT import UI-related facades.
import '@univerjs/core/facade';
import '@univerjs/sheets/facade';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets-formula/facade';

const univer = new Univer({
  locale: LocaleType.EN_US,
  locales: {
    [LocaleType.EN_US]: SheetsEnUS,
  },
});

// Registration order matters even in headless mode:
// 1. Formula engine first (needed by sheets-formula)
// 2. Sheets core
// 3. Sheets formula
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverSheetsPlugin);
univer.registerPlugin(UniverSheetsFormulaPlugin);

const API = FUniver.newAPI(univer);
const workbook = API.createWorkbook({});
const sheet = workbook.getActiveSheet();

// Manipulate data via Facade API
sheet.getRange('A1').setValue({ v: 123 });
sheet.getRange('B1').setValue({ f: '=SUM(A1) * 6' });

// Export snapshot (JSON) for persistence or transfer to browser
const snapshot = workbook.save();
console.log(JSON.stringify(snapshot, null, 2));

// Dispose when done
univer.dispose();
