// Source reachability is a necessary structural condition, not a proof that a
// natural-language business claim is correct. Callback registration is never
// treated as invocation. Unknown boundaries remain explicit gaps.
export function businessLinks(state, capability, runtime = () => false) {
  if (capability.classification === 'requested') return { links: [], gaps: [] };
  const units = new Map(state.units.map((u) => [u.id, u]));
  const operations = new Map(state.facts.operations.map((o) => [o.id, o]));
  const links = [],
    gaps = [],
    supported = new Set();
  const results = capability.results || [];
  for (const id of capability.operationIds) {
    const op = operations.get(id);
    if (!op) continue;
    if (op.contextId) {
      const indexes = results.flatMap((e, i) =>
        e.kind === 'context' && e.contextId === op.contextId ? [i] : [],
      );
      for (const i of indexes) {
        supported.add(i);
        links.push({ operationId: id, result: i, basis: 'workflow-source' });
      }
      if (!indexes.length)
        gaps.push({ operationId: id, kind: 'unverified', message: '工作流结果没有绑定自身原文。' });
      continue;
    }
    const root = units.get(op.unitId);
    if (!root) continue;
    const range =
      op.execution ||
      (op.registration?.file === root.file &&
      op.registration.start >= root.start &&
      op.registration.end <= root.end &&
      !(op.registration.start === root.start && op.registration.end === root.end)
        ? op.registration
        : null);
    const queue = [{ unit: root, range }],
      reached = new Set(),
      visited = new Set();
    for (let n = 0; n < queue.length; n++) {
      const { unit, range: slice } = queue[n];
      const key = `${unit.id}:${slice?.start ?? ''}:${slice?.end ?? ''}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const [i, e] of results.entries()) {
        if (
          e.kind !== 'code' ||
          e.unitId !== unit.id ||
          (e.operationIds && !e.operationIds.includes(id))
        )
          continue;
        const point = unit.reviewPoints.find((p) => p.id === e.pointId);
        if (point && !e.via && (!slice || (point.start >= slice.start && point.end <= slice.end)))
          reached.add(i);
      }
      for (const call of unit.calls || [])
        if (
          call.status === 'resolved' &&
          call.target &&
          (!slice || (call.start >= slice.start && call.end <= slice.end))
        ) {
          const next = units.get(call.target);
          if (next) queue.push({ unit: next, range: null });
        }
    }
    for (const i of reached) {
      supported.add(i);
      links.push({ operationId: id, result: i, basis: 'static-call-path' });
    }
    for (const [i, e] of results.entries())
      if (
        e.kind === 'code' &&
        e.via &&
        (!e.operationIds || e.operationIds.includes(id)) &&
        runtime(op, e)
      ) {
        reached.add(i);
        supported.add(i);
        links.push({ operationId: id, result: i, basis: 'observed-flow', ...e.via });
      }
    if (!reached.size)
      gaps.push({
        operationId: id,
        kind: 'unverified',
        message:
          '没有从此操作的处理函数/具体分支到结果位置的已解析调用路径；名称、回调注册或文字审阅不能代替调用证据。',
      });
  }
  for (const [i, e] of results.entries())
    if (e.kind === 'code' && !supported.has(i))
      gaps.push({
        result: i,
        kind: 'disconnected',
        message: '结果位置虽存在，但没有与所声明操作建立源码关联。',
      });
  return { links, gaps };
}
