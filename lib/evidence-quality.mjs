// A quality floor: remove cited syntax/claims before looking for an explanation.
// This detects source wrapped in procedural prose, not semantic correctness.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const scaffolding =
  /(?:向调用者|对|向|由|被|位于|负责|属于|作为|以便|以完成|得到|已经|已在|对应|相应|相关|当前|本次|本单元|该位置|通过|以及|或者|并且|进行|执行|提供|接收|传入|返回|读取|写入|保存|处理|判断|决定|评估|控制|求值|获取|检查|核对|验证|保障|实现|支持|就绪|特定|具体|核心|完整|实际|业务|能力|行为|边界|前置|逻辑|计算|状态|输入|输出|参数|声明|表达式|函数|方法|调用|结果|流程|步骤|模块|分支|走向|流转|依赖|原文|源码|代码|测试|断言|条件|规则|结构|文本|内容|数据|操作|标识|编号|位置|的|了|在|与|和|或|及|将|为|把|中|上|下|是|并|该|本|其|按|到|后|前)/g;
export function hollowExplanation(text, { unit, fragments = [], claim } = {}) {
  if (typeof text !== 'string' || !text.trim()) return true;
  let rest = text.normalize('NFKC').replace(/\s+/g, '');
  const snippets = [...fragments, unit?.file, unit?.name, unit?.role, claim]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map((s) => s.normalize('NFKC').replace(/\s+/g, ''))
    .sort((a, b) => b.length - a.length);
  for (const snippet of snippets) rest = rest.replaceAll(snippet, '');
  const identifiers = new Set(snippets.flatMap((s) => s.match(/[A-Za-z_$][\w$]*/g) || []));
  for (const word of [...identifiers].sort((a, b) => b.length - a.length))
    rest = rest.replace(new RegExp(`\\b${escape(word)}\\b`, 'g'), '');
  rest = rest.replace(scaffolding, '').replace(/[\p{P}\p{S}\p{Z}\d_]/gu, '');
  return rest.length === 0;
}
