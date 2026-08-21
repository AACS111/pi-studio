/**
 * DSH client 插件 fixture（最小示例）—— 模拟真实 DSH client 插件的结构，
 * 用于端到端验证 Pi 的 client loader（window.__ModuleLoader__ + ctx.slots）。
 *
 * 与真实 DSH client 插件（如 @linxin666/dsh-client-ui-task-board 的
 * lib/client.js）同构：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) → { apply, inject }
 *   apply(ctx) 里 ctx.slots.inject(...) / ctx.locale.register(...)
 *
 * 它只依赖 react + slots + locale，不摸 DOM、不依赖 sessions/workspaces，
 * 是「最小闭环」的验证目标。
 */
window.__ModuleLoader__.load({
  id: "dsh:fixture-sidebar",
  factory: (require) => {
    var React = require("react");
    var module = { exports: {} };
    var exports = module.exports;

    var inject = ["slots", "locale"];

    function FixturePanel() {
      return React.createElement(
        "div",
        { style: { padding: 12, lineHeight: 1.7 } },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 6 } }, "Fixture Sidebar Entry"),
        React.createElement(
          "div",
          { style: { fontSize: 12, color: "var(--text-muted)" } },
          "This panel is rendered by a real DSH client plugin (fixture) through ctx.slots.inject."
        )
      );
    }

    function apply(ctx) {
      ctx.locale.register("fixture", { title: "Fixture Panel" });
      ctx.slots.inject("web-ui.plugin.item", () =>
        ctx.slots.register(
          {
            name: "web-ui.plugin.item",
            id: "fixture-sidebar-entry",
            order: 100,
          },
          FixturePanel
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
