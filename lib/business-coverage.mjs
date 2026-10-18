import { batchReviewProblems, hollowExplanation } from './evidence-quality.mjs';
import { businessLinks } from './business-links.mjs';

const external = new Set([
  'cli',
  'http',
  'event',
  'page-event',
  'message',
  'scheduled-task',
  'workflow',
]);
export const requiresBusinessOwner = (op) => external.has(op.surface);

// Candidate inventories contain both actual product operations and lookalikes.
// Technical support needs a source connection to a named business result.
// A candidate is uncertain, not refuted: agent labels alone cannot discharge it.
export function coverageProblems(state, model, runtime) {
  const operations = new Map(state.facts.operations.map((o) => [o.id, o]));
  const units = new Map(state.units.map((u) => [u.id, u]));
  const capabilities = new Map(model.capabilities.map((c) => [c.id, c]));
  const gaps = [],
    records = {},
    subjects = [];
  const add = (id, message) =>
    gaps.push({ path: `/business/dispositions/${id}`, kind: 'business', message });
  for (const d of model.dispositions) {
    const op = operations.get(d.operationId),
      unit = units.get(op?.unitId);
    if (!op) continue;
    const subject = {
      ...(unit || {}),
      id: op.id,
      file: op.registration.file,
      name: JSON.stringify(op.trigger),
      reviewPoints: [{ kind: op.surface, code: JSON.stringify(op.trigger) }],
    };
    subjects.push(subject);
    const explanation = Object.values(op.trigger)
      .filter((v) => typeof v === 'string' && v.length)
      .sort((a, b) => b.length - a.length)
      .reduce((reason, v) => reason.replaceAll(v, ''), d.reason);
    records[op.id] = { responsibility: explanation, coverage: [] };
    if (hollowExplanation(explanation, { unit: subject }))
      add(op.id, '排除理由缺少具体职责与业务结果，通用支撑说明不能代替逐项判断。');
    if (d.kind === 'support') {
      if (!d.capabilityIds?.length || d.capabilityIds.some((id) => !capabilities.has(id))) {
        add(op.id, '支撑操作须关联真实业务能力，不能归到不存在或空的业务目标。');
        continue;
      }
      const connected = d.capabilityIds.some((id) => {
        const c = capabilities.get(id);
        if (c.classification === 'requested') return false;
        const results = c.results.map((e) => ({ ...e, operationIds: undefined }));
        return (
          businessLinks(state, { ...c, operationIds: [op.id], results }, runtime).gaps.length === 0
        );
      });
      if (!connected)
        add(
          op.id,
          '支撑操作没有连接到所属能力的实际结果；不能将所有页面/API/命令统称为工作流内部支撑。',
        );
    } else if (d.kind === 'false-positive') {
      if (op.certainty !== 'candidate')
        add(op.id, '明确声明的外部操作不能凭假阳性说明排除，应纳入业务或关联其支撑目标。');
      else
        add(
          op.id,
          '候选表示识别尚不确定，不是已证明误识别。当前工具没有反证适配器，false-positive 仅保存待确认判断，不能使操作覆盖通过；继续核对真实归属，无法确认则保留缺口，不虚构功能。',
        );
    } else if (requiresBusinessOwner(op))
      add(
        op.id,
        '对外操作须进入业务能力，或以 support 关联真实结果；仅未确认的候选可作 false-positive 审阅。',
      );
  }
  const repeated = batchReviewProblems(subjects, records);
  for (const [id] of repeated)
    add(id, '行为不同的操作复用了同一种排除模板，需分别说明职责、使用者和业务归属。');
  return gaps;
}
