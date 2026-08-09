/**
 * Minimal Vue 3 + Vite integration for Univer Sheets
 * Dependencies:
 *   vue
 *   @univerjs/core @univerjs/design @univerjs/engine-formula @univerjs/engine-render
 *   @univerjs/sheets @univerjs/sheets-ui @univerjs/themes @univerjs/ui @univerjs/ui-adapter-vue3
 */

import { createApp, onMounted, onUnmounted, ref } from 'vue';
import { LocaleType, LogLevel, Univer, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { defaultTheme } from '@univerjs/themes';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverVue3AdapterPlugin } from '@univerjs/ui-adapter-vue3';
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

const App = {
  setup() {
    const container = ref<HTMLDivElement>();
    let univer: Univer | null = null;

    onMounted(() => {
      univer = new Univer({
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
        [UniverUIPlugin, { container: container.value! }],
        [UniverVue3AdapterPlugin],
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

      (window as any).univerAPI = FUniver.newAPI(univer);
    });

    onUnmounted(() => {
      univer?.dispose();
    });

    return { container };
  },
  template: `<div ref="container" style="width: 100%; height: 100vh;" />`,
};

createApp(App).mount('#app');
