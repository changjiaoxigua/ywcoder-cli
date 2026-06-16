import { c as _c } from "react-compiler-runtime";
import { Text } from '../ink.js';
export function MCPServerDialogCopy() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <Text>MCP 服务器可能会执行代码或访问系统资源。所有工具调用都需要经过审批。</Text>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
