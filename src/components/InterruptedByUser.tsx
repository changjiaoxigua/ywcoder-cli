import { c as _c } from "react-compiler-runtime";
import { Text } from '../ink.js';
export function InterruptedByUser() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    {/* Interrupted · What should Claude do instead? */}
    t0 = <><Text dimColor={true}>已中断 </Text>{false ? <Text dimColor={true}>· [internal] /issue to report a model issue</Text> : <Text dimColor={true}>· 接下来让 YwCoder 做什么？</Text>}</>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
