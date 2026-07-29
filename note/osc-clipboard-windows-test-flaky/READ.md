# Issue: Windows 剪贴板回退测试在 macOS 测试环境下失败

## 1. 当前状态

Status: Open
Date: 2026-05-14
Owner: TBD
Discovered in: v1.0.2 发布前 CI 检查（feature/brand-replacement 分支）

## 2. 背景一句话

`bun test --max-concurrency=1` 在 macOS 上跑 [src/ink/termio/osc.test.ts](../../src/ink/termio/osc.test.ts) 时，`Windows clipboard fallback` 测试组里有用例失败；该测试通过覆写 `process.platform = 'win32'` 模拟 Windows 环境，但 osc 模块的实际剪贴板路径未按预期走 PowerShell 分支。**与本次 v1.0.2 改动无任何关联**（grep 验证 osc 模块不 import `providerConfig` / `configMigration` / `isLocalProviderUrl`）。

## 3. 失败现象

执行命令：

```bash
bun test --max-concurrency=1
```

输出片段：

```
src/ink/termio/osc.test.ts:
 66 |     expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'clip')).toBe(false)
 67 |     ...
 70 |       execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'powershell'),
 71 |     ).toBe(true)
           ^
error: expect(received).toBe(expected)

Expected: true
Received: false

(fail) Windows clipboard fallback > uses PowerShell instead of clip.exe for local Windows copy [2.91ms]

 531 pass
 1 fail
Ran 532 tests across 79 files. [1499.00ms]
```

## 4. 测试上下文

文件：[src/ink/termio/osc.test.ts:60-72](../../src/ink/termio/osc.test.ts#L60-L72)

测试通过：

```ts
Object.defineProperty(process, 'platform', { value: 'win32' })
```

把当前进程的 `process.platform` 强改为 `'win32'`，期望 `setClipboard()` 内部检测后走 PowerShell 分支（避免 `clip.exe` 对 Unicode 字符的截断）。

第一个断言（不应调用 `clip`）通过；第二个断言（应调用 `powershell`）失败 → 说明在 macOS 测试环境下，**setClipboard 没有走任何 spawn 命令分支**，可能在更早的位置就 return 了。

## 5. 初步怀疑方向

未深入排查，记录候选假设供下次解决时验证：

1. **OSC 52 / 终端转义优先级**：[osc.ts](../../src/ink/termio/osc.ts) 可能在 platform 检测之前先尝试通过 OSC 52 转义序列写剪贴板（fallback 到 spawn 命令是后置路径）。测试虽 `delete SSH_CONNECTION / TMUX`，但 macOS 上 stdout 是否 TTY、TERM_PROGRAM 等可能让代码以为可以走 OSC 52。
2. **`mock.module` + 动态 import 时序**：测试用 `import(\`./osc.ts?ts=${Date.now()}\`)` 强制 fresh import，但 `execFileNoThrowMock` 的注入可能在 osc.ts 模块加载之后才生效，导致首次调用未被 mock 捕获。
3. **process.platform 覆写时机**：`Object.defineProperty(process, 'platform', ...)` 在 osc.ts 内部模块顶层若先读了一次 `process.platform` 并缓存到模块级常量，后续运行时改 platform 不再生效。
4. **Bun 版本差异**：当前 `bun test v1.3.11`，mock 行为可能跟测试编写时的 bun 版本有差异。

## 6. 排查路径建议

下次解决时建议按以下顺序：

1. **先在 Windows 真实环境跑这个测试**（或 Windows GitHub Actions runner），看是否通过 → 若通过，证实是 macOS 模拟 Windows 的环境差异问题，可考虑给测试加 `@platform: win32` 跳过标记
2. **若 Windows 真实环境也失败**：阅读 [osc.ts](../../src/ink/termio/osc.ts) 看 setClipboard 的完整分支结构，确认 OSC 52 / spawn 命令的优先级
3. **若是 mock 时序问题**：调整 `mock.module` 调用顺序，或改用 `bun:test` 的 `spyOn` 替代
4. 修复后跑 `bun test src/ink/termio/osc.test.ts` 确认 4 个测试全 pass

## 7. 不阻塞 v1.0.2 发布的判断依据

- 失败测试位于 [src/ink/termio/](../../src/ink/termio/)（终端 IO 层），跟本次方案E（内网识别）的 [src/services/api/](../../src/services/api/) + [src/utils/](../../src/utils/) 不在同一调用链
- grep 验证：osc 模块**不 import** 任何 v1.0.2 改动文件，反之亦然
- 该测试相关代码最近一次变更是 7 个提交前的 [`c193497 fix: preserve unicode in Windows clipboard fallback (#388)`](../../src/ink/termio/osc.ts)，远早于 v1.0.2 改动
- 530+ 其他测试全部通过，包括本次方案E 涉及的 providerConfig / providerDiscovery / context 等模块

## 8. 关联文档

- [v1.0.2 方案E 实施记录](../internal-model-config-gateway/04-internal-model-implementation-summary-0506.md#v1x-补丁--内网标识开关方案e2026-05-14)（issue 发现于该改动的 CI 验证阶段）
