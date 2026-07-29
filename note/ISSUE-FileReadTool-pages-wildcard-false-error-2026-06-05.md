# ISSUE: 非 PDF 文件传入 pages: "*" 触发 Read 工具误报中断分析

- 日期：2026-06-05
- 涉及文件：`src/tools/FileReadTool/FileReadTool.ts`、`src/tools/FileReadTool/FileReadTool.test.ts`（新增）
- 影响范围：所有使用较弱第三方模型（OpenAI、Gemini、DeepSeek、Ollama、GitHub Models 等）执行"分析整个项目"类任务的场景

## 问题描述

用户让 ywcoder 分析当前项目时报错：

```
Invalid pages parameter: *. Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.
```

该报错由 Read 工具的 `pages`（页码）参数校验抛出：模型在读取文件时给 `pages` 传了通配符 `*`，被参数校验拦截。报错本身可恢复（模型下一轮通常会去掉 `pages` 重读），但若模型反复犯错，会持续浪费轮次、拖慢并打断项目分析。

## 分析定位

`pages` 参数本意**仅用于读取 PDF 的页码范围**（schema 描述为 `Page range for PDF files (e.g., "1-5", "3", "10-20")`）。

根因有两点：

1. **校验范围过宽**：`validateInput` 中只要 `pages !== undefined` 就无条件做格式校验，**不区分文件类型**。
   - 见 `src/tools/FileReadTool/FileReadTool.ts:418` 原逻辑：
     ```ts
     if (pages !== undefined) {
       const parsed = parsePDFPageRange(pages)
       if (!parsed) {
         return { result: false, message: `Invalid pages parameter: ...`, errorCode: 7 }
       }
       ...
     }
     ```
   - 而在实际读取路径 `callInner` 中，`pages` **只在 `if (isPDFExtension(ext))` 分支内被使用**（`FileReadTool.ts:894`）。对 notebook、图片、以及所有普通文本/源码文件，`pages` 从头到尾根本没被读取——本就是静默忽略。
   - 结果是校验逻辑与实际读取逻辑**自相矛盾**：非 PDF 传 `pages` 在读取层被忽略，却在校验层被报错拦截。

2. **模型行为差异（为什么是第三方模型）**：`pages` 字段在 schema 里只是个普通 `string` + 一句描述，**没有 `enum` / `pattern` 等机器级约束**（即便有 `pattern` 也会被 `schemaSanitizer` 删掉，参见 [ISSUE-schemaSanitizer-pattern-field-missing-2026-06-01.md](./ISSUE-schemaSanitizer-pattern-field-missing-2026-06-01.md)）。唯一的"规则"是自然语言描述。
   - 官方 Claude 对这套自家工具对齐强，读普通源码文件时会直接**不带** `pages`；
   - 较弱的第三方模型倾向于"可选参数也要填"，并在"读整个文件"意图下把 `*` 当通配符塞入，且未能把"for PDF files"这一限定与"当前是否在读 PDF"绑定。
   - 因此这**本质是模型指令遵循问题，而非 shim 结构缺陷**，但根治办法应放在工具层——用代码强制约束，替弱模型补上它没遵守的规则。

## 修改内容

将 `pages` 格式校验收紧为**仅对 PDF 文件生效**，使校验行为与实际读取逻辑保持一致。

`src/tools/FileReadTool/FileReadTool.ts:418`：

```ts
// 改前
if (pages !== undefined) {

// 改后（path、isPDFExtension 均已在文件顶部导入）
if (pages !== undefined && isPDFExtension(path.extname(file_path))) {
```

判断是否为 PDF 走 `path.extname` 纯字符串操作，**不引入任何 I/O**。

新增测试 `src/tools/FileReadTool/FileReadTool.test.ts`，构造最小 `ToolUseContext`（仅 `getAppState().toolPermissionContext`，复用 `getEmptyToolPermissionContext`）覆盖 5 个用例：

| 用例 | 期望 |
| --- | --- |
| 非 PDF + `pages: "*"` | 放行（result=true，复现的核心场景） |
| 非 PDF + `pages: "1-5"` | 放行 |
| PDF + `pages: "*"` | 报错 errorCode 7 |
| PDF + `pages: "1-5"` | 通过 |
| PDF + `pages: "1-999"`（超单次上限） | 报错 errorCode 8 |

## 验证结果

- `bun test src/tools/FileReadTool/FileReadTool.test.ts` → **5 pass / 0 fail**
- `bun run build` → ✓ Built ywcoder v1.1.2 → dist/cli.mjs
- `bun run smoke` → `1.1.2 (YwCoder, build ...)` 正常输出

## 影响范围

- **正向**：第三方模型分析项目（读源码文件）时再对非 PDF 文件传 `pages: "*"` 等非法值，将被静默忽略并正常读取，不再报错中断。
- **PDF 行为完全不变**：PDF 的页码格式校验、单次最多 `PDF_MAX_PAGES_PER_READ` 页上限、非法格式拦截等保护一概保留。
- **风险评估**：极低。`pages` 对非 PDF 文件在读取层本就被忽略，本次仅让校验层与之对齐。唯一边角影响是——模型若对 `.ts` 等文本文件误传 `pages: "3-5"` 想读行范围，改前报错、改后静默读整文件；但这本属模型用错参数（应使用 `offset`/`limit`），且原报错也未引导其改用正确参数，故不构成行为退化。

## 后续建议

- 本次未处理"PDF 文件传 `*`"的容错（仍报错）。该行为安全且报错清晰，模型会用合法范围重试，故暂不改动。若后续要支持，**必须将 `*` 映射为"第 1 页至上限（前 20 页）"**，切勿映射为"全部页"——否则会绕过 `extractPDFPages` 的页数保护，遇到大体量 PDF 会被整本抽取导致 token / 内存爆炸。
- 版本号已更新至 **1.1.2**，改动位于 `feature/brand-replacement` 分支并已推送远端。按既定流程需 CI 打包 + 内网测试通过后再合并 main。
