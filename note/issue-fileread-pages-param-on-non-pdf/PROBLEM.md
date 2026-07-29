# 问题：FileReadTool 对非 PDF 文件传入 pages 参数时直接报错

## 问题描述

用户使用 ywcoder 读取 `.md` 文件时遇到报错：

```
Read lines 1-2000 D:\Project\mailNotice\src\main\java\event.md
Invalid pages parameter: **. Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.
```

文件是 `.md` 格式，不是 PDF，但工具返回了 PDF 专用的 pages 参数校验错误。

## 根因分析

1. **模型幻觉**：LLM 在调用 `FileReadTool` 时，错误地将某个值（`"**"`）传给了 `pages` 参数。`pages` 参数仅适用于 PDF 文件，模型不应对非 PDF 文件传入此参数。
2. **校验逻辑缺陷**：`validateInput`（`FileReadTool.ts:418-440`）在收到 `pages` 参数后，直接进行格式校验并报错，**没有先检查文件是否为 PDF**。这导致非 PDF 文件因模型误传 `pages` 而被阻断读取。

## 触发规律

用户测试发现：**直接发裸文件名（如 `event.md`）更容易触发此问题，而使用 `./event.md` 则明显减少。**

原因是 `./` 是一个强路径信号，帮助模型更准确地将整个字符串归入 `file_path` 参数：
- **裸文件名**（`event.md`）对模型来说是模糊的，模型在做 tool calling 参数分配时，更容易把用户消息中的其他片段（如路径中的 `**`、行号等）错误地"溢出"到 `pages` 等可选参数上。
- **带路径前缀**（`./event.md`、`/abs/path/event.md`、`~/event.md`）则给模型一个明确的"这整个字符串是文件路径"的信号，减少参数的错误分配。

这说明问题的触发与用户输入的路径表达方式相关，但本质上仍是模型概率推理的不确定性，无法仅靠输入规范完全消除，代码层面的容错兜底仍然必要。

## 涉及文件

- `src/tools/FileReadTool/FileReadTool.ts` — 主要修改文件
  - `validateInput`（第 418 行）— pages 参数校验入口
  - `call`（第 496 行）— 工具执行入口
  - `callInner`（第 804 行）— 实际读取逻辑
- `src/utils/pdfUtils.ts` — `parsePDFPageRange` 函数、`isPDFExtension` 判断

## 设计考量

**不应静默忽略** `pages` 参数。静默忽略会让模型误以为对非 PDF 文件传 `pages` 是合法行为，导致后续持续产生无意义的参数传递。

正确的做法是：**容错执行 + 明确反馈**，即不阻断文件读取，但在返回结果中告知模型 `pages` 参数被忽略及原因。
