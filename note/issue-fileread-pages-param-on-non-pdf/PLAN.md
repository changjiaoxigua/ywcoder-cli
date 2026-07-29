# 修复计划：FileReadTool 非 PDF 文件 pages 参数容错处理

## 修复策略：容错执行 + 明确反馈

对非 PDF 文件传入 `pages` 参数时，不报错阻断，而是忽略该参数继续正常读取文件，同时在返回结果中附加提示信息，纠正模型行为。

## 修改步骤

### 步骤 1：修改 `validateInput`（FileReadTool.ts:418）

**改动**：在 `pages` 校验逻辑前增加文件扩展名判断，仅对 PDF 文件执行 `pages` 参数的格式校验。

```typescript
// 修改前
if (pages !== undefined) {
  const parsed = parsePDFPageRange(pages)
  // ...校验逻辑
}

// 修改后
const ext = path.extname(file_path).toLowerCase().slice(1)
if (pages !== undefined && isPDFExtension(ext)) {
  const parsed = parsePDFPageRange(pages)
  // ...校验逻辑（不变）
}
```

**效果**：非 PDF 文件不再因 `pages` 参数校验失败而被阻断。

### 步骤 2：修改 `call` 方法（FileReadTool.ts:496）

**改动**：在 `call` 方法开头，检测非 PDF 文件是否传入了 `pages` 参数。如果是，清除 `pages` 并记录警告前缀。

```typescript
// 在 const ext = path.extname(file_path)... 之后
let pagesWarning = ''
if (pages !== undefined && !isPDFExtension(ext)) {
  pagesWarning = `Note: "pages" parameter is only applicable to PDF files and was ignored for this ${ext || 'text'} file.\n`
  pages = undefined
}
```

**改动 2**：在 `callInner` 返回结果后，如果存在 `pagesWarning`，将其附加到返回的文本内容前面。

**效果**：
- 文件正常读取，用户不受影响
- 模型收到明确反馈，知道 `pages` 参数被忽略了，下次不会再传

### 步骤 3：补充测试

在现有测试文件中添加测试用例：
- 对 `.md` 文件传入 `pages` 参数，验证文件正常读取且结果中包含警告提示
- 对 `.pdf` 文件传入无效 `pages` 参数，验证仍然正确报错

## 影响范围

- 仅影响 `FileReadTool` 的输入校验和执行逻辑
- 不影响 PDF 文件的正常读取流程
- 不影响其他工具
