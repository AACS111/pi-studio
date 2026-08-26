# 测试报告：项目组设置保存后弹窗不关闭

**日期**：2026-08-24
**测试人**：tester
**关联任务**：TASK-001 项目组设置，为什么我点击保存，弹窗没关闭
**验证对象**：`components/TeamSettings.tsx`（leader 修复）

## 结论：✅ 通过

## 需求与验收

| # | 验收点 | 结果 |
|---|--------|------|
| 1 | 点保存（PATCH 成功）后弹窗关闭 | ✅ 通过 |
| 2 | 校验有错误时按钮置灰，用户能看到红色错误列表 | ✅ 通过 |
| 3 | 保存成功仍通知 TeamChat 刷新数据 | ✅ 通过 |
| 4 | 不再有无用的 `saved` 状态与多余 `load()` 刷新 | ✅ 通过 |
| 5 | 类型检查 + lint 通过 | ✅ 通过 |

## 验证证据

### 1. 保存成功路径关闭弹窗（核心修复）
`components/TeamSettings.tsx` `handleSave`（约 L100-122）：

```tsx
const res = await fetch(`/api/teams/${sessionId}`, { method: "PATCH", ... });
const data = await res.json();
if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
onSaved?.();   // L120 先通知 TeamChat 刷新
onClose();     // L121 再关闭弹窗  ← 修复新增
```

- 成功路径（`res.ok`）必经 `onClose()`，弹窗关闭 ✅
- 失败路径（`!res.ok`）抛错进 catch 设 `setError`，**不**调用 `onClose`，弹窗保持打开显示错误 ✅（合理）
- 顺序正确：先 `onSaved`（触发 TeamChat `data.load()` 刷新 chips）再 `onClose`，避免关闭后竞态 ✅

### 2. 弹窗关闭链路完整
`components/TeamChat.tsx` L659-670 调用 `TeamSettings`：

```tsx
<TeamSettings
  sessionId={sessionId}
  onClose={() => {
    setSettingsOpen(false);          // 弹窗 state 置 false → 不再渲染
    setSettingsAgentId(undefined);
  }}
  onSaved={() => void data.load()}   // 刷新 TeamChat 数据
/>
```

`onClose` 真实清除 `settingsOpen` 渲染条件 → TeamSettings 组件卸载 → 弹窗消失 ✅

### 3. 校验错误时按钮置灰（边界场景）
Footer（L695-699）：

```tsx
<button onClick={() => void handleSave()} disabled={saving || errors.length > 0} ...>
```

- `errors.length > 0`（孤儿边等）时按钮 `disabled`，点不动 ✅
- 错误区域红色显示（L672-682）：`{t("team.settings.errors")}` + `<ul>` 罗列错误 ✅
- 印证组长说明：用户反馈「点了没反应」时先查 `errors.length>0` / 校验提示区 ✅

### 4. 清理冗余状态
grep 确认 TeamSettings.tsx 内已无 `saved` / `setSaved` / try 末尾的 `void load()`，符合组长「移除无用 saved 状态和多余 load」说明 ✅

### 5. 静态检查
- `tsc --noEmit`：无 error（无输出）
- `eslint components/TeamSettings.tsx`：无 error/warning（无输出）

## 未覆盖项（说明）
- 未做 Electron 实机点击测试（需打包应用运行环境）；此为纯前端 state 流转，逻辑链路由源码与调用处双向确认，可信。
- 未验证 PATCH 接口本身（属后端职责，本次修复不涉及接口变更）。

## 残留无关问题（非本次范围，记录备查）
- L51 `useState<Tab>(initialAgentId ? "agents" : "agents")` 三元恒为 `"agents"`，冗余但不影响功能（tester-review B4 已记录）。
- L638-648 & L653-661 `maxOutputChars` 字段在 grid2 中出现两次（tester-review B2 已记录）。以上两项与「保存不关闭」无关，不在本次修复范围。
