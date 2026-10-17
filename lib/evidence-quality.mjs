// A quality floor: remove cited syntax/claims before looking for an explanation.
// This detects source wrapped in procedural prose, not semantic correctness.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const scaffolding =
  /(?:向调用者|对|向|由|被|位于|负责|属于|作为|以便|以完成|得到|已经|已在|对应|相应|相关|当前|本次|本单元|该位置|通过|以及|或者|并且|进行|执行|提供|接收|传入|返回|读取|写入|保存|处理|判断|决定|评估|控制|求值|获取|检查|核对|验证|保障|实现|支持|就绪|特定|具体|核心|完整|实际|业务|能力|行为|边界|前置|逻辑|计算|状态|输入|输出|参数|声明|表达式|函数|方法|调用|结果|流程|步骤|模块|分支|走向|流转|依赖|原文|源码|代码|测试|断言|条件|规则|结构|文本|内容|数据|操作|标识|编号|位置|的|了|在|与|和|或|及|将|为|把|中|上|下|是|并|该|本|其|按|到|后|前)/g;
// Match whole phrases before single characters (e.g. 对应 before 对).
const procedural = new RegExp(
  `(?:${[...scaffolding.source.slice(3, -1).split('|'), '以', '已'].sort((a, b) => b.length - a.length).join('|')})`,
  'g',
);
function remainder(text, { unit, fragments = [], claim } = {}) {
  if (typeof text !== 'string') return '';
  // Administrative labels are not explanations, including labels encoded as
  // Chinese words rather than digits. Do not strip arbitrary business literals.
  let rest = text
    .normalize('NFKC')
    .replace(
      /(?:序列标号|序号|编号|标签|标号|record\s*id|unit\s*id|label|token|tag)\s*[:：=]?\s*[【\[（(][^】\]）)]*[】\]）)]/gi,
      '',
    )
    .replace(/\s+/g, '');
  const snippets = [...fragments, unit?.file, unit?.name, unit?.role, claim]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map((s) => s.normalize('NFKC').replace(/\s+/g, ''))
    .sort((a, b) => b.length - a.length);
  for (const snippet of snippets) {
    rest = rest.replaceAll(snippet, '');
    // A generator often quotes only a prefix of the indexed source. Remove that
    // prefix too, regardless of the particular truncation length it chose.
    if (snippet.length >= 12) {
      let at;
      while ((at = rest.indexOf(snippet.slice(0, 12))) !== -1) {
        let end = 12;
        while (end < snippet.length && rest[at + end] === snippet[end]) end++;
        rest = rest.slice(0, at) + rest.slice(at + end);
      }
    }
  }
  const identifiers = new Set(
    snippets.flatMap(
      (s) => s.replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '').match(/[A-Za-z_$][\w$]*/g) || [],
    ),
  );
  for (const word of [...identifiers].sort((a, b) => b.length - a.length))
    rest = rest.replace(new RegExp(`\\b${escape(word)}\\b`, 'g'), '');
  return rest;
}
export function hollowExplanation(text, context = {}) {
  return (
    remainder(text, context)
      .replace(
        /(?:业务计算、?数据校验与状态流转处理|调度底层接口|推进流程执行|维护状态一致性|业务载荷数据|配置载荷|计算结果或承诺对象|逻辑真假|下层业务逻辑|目标属性或局部寄存器|系统健壮性与无泄露|语法节点|承接调用端注入|承诺对象交付消费|相应子任务|逻辑与约束|约束|最新计算数据|调度|推进|维护|一致性|载荷|负载|形参|调用端|调用栈|交付|消费|最新|注入|健壮性|无泄露|健壮|无回归缺陷)/g,
        '',
      )
      .replace(procedural, '')
      .replace(/[\p{P}\p{S}\p{Z}\d_]/gu, '').length === 0
  );
}

// Compare explanation shapes across different source behaviors. Identical tiny
// wrappers remain legitimate; copying one synopsis onto unrelated bodies does not.
export function batchReviewProblems(units, records) {
  const groups = new Map(),
    problems = new Map();
  const behaviorOf = (point) =>
    `${point.kind}:${point.code}`.replace(
      /(['"])(?:\\.|(?!\1).)*?\1|[A-Za-z_$][\w$]*/g,
      (token, quote, offset, source) => (quote || source[offset - 1] === '.' ? token : '#'),
    );
  const add = (unit, text, field, points, pointId) => {
    const prose = remainder(text, { unit, fragments: points.map((p) => p.code) });
    const shape = prose.replace(/[\p{P}\p{S}\p{Z}_]/gu, '');
    if (!shape) return;
    // Different real thresholds/status values are meaningful, unlike arbitrary
    // record IDs. Preserve literals actually explained outside copied syntax.
    const literals = [
      ...new Set(
        points.flatMap((p) =>
          [...p.code.matchAll(/(['"])((?:\\.|(?!\1).)*)\1|\b\d+(?:\.\d+)?\b/g)].map(
            (m) => m[2] ?? m[0],
          ),
        ),
      ),
    ]
      .filter((v) => v && prose.includes(v))
      .sort()
      .join('|');
    const key = `${field}:${shape}`;
    if (!groups.has(key)) groups.set(key, { field, shape, literals, entries: [] });
    groups
      .get(key)
      .entries.push({ id: unit.id, pointId, behavior: points.map(behaviorOf).join('|') });
  };
  for (const unit of units) {
    const record = records[unit.id];
    if (!record) continue;
    add(unit, record.responsibility, 'responsibility', unit.reviewPoints || []);
    const points = new Map((unit.reviewPoints || []).map((p) => [p.id, p]));
    for (const item of Array.isArray(record.coverage) ? record.coverage : []) {
      const point = points.get(item?.pointId);
      if (point) add(unit, item.detail, point.field, [point], point.id);
    }
  }
  // Near-identical prose with a short nonce inserted elsewhere must not defeat
  // exact grouping. Index representatives, not all point pairs (large sessions).
  const representatives = [],
    index = new Map();
  const grams = (s) =>
    new Set(Array.from({ length: Math.max(0, s.length - 7) }, (_, i) => s.slice(i, i + 8)));
  for (const group of groups.values()) {
    const tokens = grams(group.shape),
      candidates = new Set();
    if (group.shape.length >= 40)
      for (const token of tokens)
        for (const candidate of index.get(`${group.field}:${group.literals}:${token}`) || [])
          candidates.add(candidate);
    let matched;
    for (const candidate of candidates) {
      const other = representatives[candidate];
      if (Math.min(tokens.size, other.tokens.size) < 24) continue;
      const shared = [...tokens].filter((token) => other.tokens.has(token)).length;
      if (shared / Math.max(tokens.size, other.tokens.size) >= 0.86) {
        matched = other;
        break;
      }
    }
    if (matched) matched.entries.push(...group.entries);
    else {
      const at = representatives.length;
      representatives.push({ ...group, tokens });
      if (group.shape.length >= 40)
        for (const token of tokens) {
          const key = `${group.field}:${group.literals}:${token}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(at);
        }
    }
  }
  for (const { field, entries } of representatives)
    if (
      new Set(entries.map((v) => v.id)).size >= 4 &&
      new Set(entries.map((v) => v.behavior)).size >= 3
    )
      for (const { id, pointId } of entries) {
        const items = problems.get(id) || [];
        if (!items.some((item) => item.field === field))
          items.push({
            field,
            ...(pointId ? { pointId } : {}),
            message:
              '多个行为不同的单元复用了同一种说明模板；无关标签不算解释，需逐项说明具体结果与影响。',
          });
        problems.set(id, items);
      }
  return problems;
}
