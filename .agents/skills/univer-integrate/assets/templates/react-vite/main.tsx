/**
 * Minimal React + Vite integration for Univer Sheets
 * Dependencies:
 *   react react-dom
 *   @univerjs/core @univerjs/design @univerjs/engine-formula @univerjs/engine-render
 *   @univerjs/sheets @univerjs/sheets-ui @univerjs/themes @univerjs/ui
 */

import { useEffect, useRef } from 'react';
import { LocaleType, LogLevel, Univer, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { defaultTheme } from '@univerjs/themes';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';

// Facade side-effects — import only the ones you need.
// Missing imports will cause methods to be `undefined` at runtime.
import '@univerjs/core/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-ui/facade';
import '@univerjs/engine-formula/facade';
// Add more as needed: @univerjs/sheets-filter/facade, @univerjs/sheets-data-validation/facade, ...

// In bundler-based projects (Vite/Webpack) this CSS import is usually required.
// If your bundler handles styles via a plugin, you may omit this line.
import '@univerjs/design/lib/index.css';

export default function UniverSheet() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const univer = new Univer({
      theme: defaultTheme,
      locale: LocaleType.EN_US,
      logLevel: LogLevel.WARN,
    });

    // Registration order: engines → UI infra → unit core → unit UI → features.
    // Some units (e.g. docs) may be registered before the render engine; Univer
    // will wire them up automatically. Do NOT register UI plugins before engines.
    univer.registerPlugins([
      [UniverRenderEnginePlugin],
      [UniverFormulaEnginePlugin],
      [UniverUIPlugin, { container: containerRef.current! }],
      [UniverDocsPlugin],
      [UniverDocsUIPlugin],
      [UniverSheetsPlugin],
      [UniverSheetsUIPlugin],
    ]);

    univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
      id: 'workbook-1',
      name: 'Demo',
      sheetOrder: ['sheet-1'],
      sheets: {
        'sheet-1': {
          id: 'sheet-1',
          name: 'Sheet1',
          rowCount: 100,
          columnCount: 20,
        },
      },
    });

    const univerAPI = FUniver.newAPI(univer);
    (window as any).univerAPI = univerAPI;

    return () => {
      univer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100vh' }}
    />
  );
}
