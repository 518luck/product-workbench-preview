import { digest } from './analysis-facts.mjs';
import { featureDefinitionHash } from './feature-operations.mjs';
import { recordValid } from './analysis-session.mjs';
import { reviewProblems } from './analysis-review.mjs';

const hashValid = ({ recordHash, ...value }) => recordHash === digest(JSON.stringify(value));
const bound = (feature, revision, hash) =>
  feature && feature.revision === revision && featureDefinitionHash(feature) === hash;
export function entryCoverage(state, document, documentPath, flows = []) {
  const entries = state.facts?.entries || [],
    mapped = new Map(),
    roots = new Set();
  const add = (entry, featureIds, via) =>
    mapped.set(entry.id, { entryId: entry.id, featureIds, via });
  const associate = (unitId, contextId, featureIds, via) => {
    if (unitId) roots.add(unitId);
    for (const entry of entries)
      if ((unitId && entry.unitId === unitId) || (contextId && entry.contextId === contextId))
        add(entry, featureIds, via);
  };
  for (const plan of Object.values(state.verificationPlans || {})) {
    const feature = Object.hasOwn(document.features, plan.featureId)
      ? document.features[plan.featureId]
      : null;
    if (
      plan.documentPath !== documentPath ||
      plan.snapshotHash !== state.snapshotHash ||
      !hashValid(plan) ||
      !bound(feature, plan.revision, plan.definitionHash)
    )
      continue;
    for (const step of plan.steps) {
      for (const unit of step.unitIds || [])
        associate(unit, null, [plan.featureId], 'declared-step');
      for (const context of step.contextIds || [])
        associate(null, context, [plan.featureId], 'declared-step');
    }
  }
  for (const flow of flows) {
    if (
      flow.documentPath !== documentPath ||
      flow.snapshotHash !== state.snapshotHash ||
      !hashValid(flow) ||
      Object.entries(flow.featureBindings).some(
        ([id, binding]) =>
          !bound(
            Object.hasOwn(document.features, id) ? document.features[id] : null,
            binding.revision,
            binding.definitionHash,
          ),
      )
    )
      continue;
    for (const node of flow.nodes) {
      associate(node.unitId, node.contextId, [node.featureId], 'flow-step');
      for (const id of node.relatedUnitIds || [])
        associate(id, null, [node.featureId], 'flow-step');
    }
  }
  const unitMap = new Map(state.units.map((unit) => [unit.id, unit])),
    reached = new Set(roots),
    queue = [...roots];
  for (let i = 0; i < queue.length; i++)
    for (const call of unitMap.get(queue[i])?.calls || [])
      for (const target of [call.target, ...(call.callbacks || [])].filter(Boolean))
        if (!reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
  for (const entry of entries)
    if (!mapped.has(entry.id) && entry.unitId && reached.has(entry.unitId))
      add(entry, [], 'internal-source-link');
  const excluded = [];
  for (const entry of entries) {
    if (mapped.has(entry.id)) continue;
    const disposition = state.entryDispositions?.[entry.id];
    if (
      disposition?.documentPath !== documentPath ||
      disposition.snapshotHash !== state.snapshotHash ||
      disposition.kind !== 'non-business' ||
      !['export', 'declaration'].includes(entry.kind)
    )
      continue;
    const unit = unitMap.get(entry.unitId),
      record = state.records[entry.unitId];
    if (
      unit &&
      disposition.recordHash === record?.recordHash &&
      recordValid(state, unit, record) &&
      !reviewProblems(unit, record).length
    )
      excluded.push({
        entryId: entry.id,
        file: entry.file,
        name: entry.name,
        reason: disposition.reason,
        basis: 'source-reviewed-exclusion',
      });
  }
  const excludedIds = new Set(excluded.map((entry) => entry.entryId));
  return {
    mapped: [...mapped.values()],
    excluded,
    pending: entries.filter((entry) => !mapped.has(entry.id) && !excludedIds.has(entry.id)),
    scope: '入口归类支持业务覆盖审阅；源码可达和人工说明不等于实际运行通过。',
  };
}
