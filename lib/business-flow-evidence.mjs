import fs from 'node:fs';
import path from 'node:path';
import { checkFlowRecord } from './flow.mjs';

// Reuse the existing tool-collected, snapshot-bound flow verifier. A model's
// flow name or a successful command is not runtime connection evidence.
export function businessFlowResolver(state, document, filename) {
  const reports = new Map();
  return (operation, evidence) => {
    if (!document || !filename || !evidence.via) return false;
    const { flowId, scenarioId } = evidence.via,
      flow = state.flows?.[flowId];
    if (!flow || flow.documentPath !== fs.realpathSync(filename)) return false;
    const entry = state.facts.entries.find((e) => e.id === flow.entryId);
    if (
      !entry ||
      !(
        operation.entryId === entry.id ||
        entry.operationId === operation.id ||
        (entry.unitId === operation.unitId &&
          entry.registration?.file === operation.registration?.file &&
          entry.registration?.start === operation.registration?.start &&
          entry.registration?.end === operation.registration?.end)
      )
    )
      return false;
    const unit = state.units.find((u) => u.id === evidence.unitId),
      point = unit?.reviewPoints.find((p) => p.id === evidence.pointId);
    const scenario = flow.scenarios.find((s) => s.id === scenarioId);
    if (!point || !scenario) return false;
    if (operation.surface !== 'library') {
      // A handler invoked directly does not prove an HTTP/event registration
      // fired. For a bounded if-dispatch, require its exact guard observed true.
      const entrance = state.units.find((u) => u.id === operation.unitId);
      const guard =
        operation.execution &&
        entrance?.reviewPoints.find(
          (p) =>
            p.kind === 'condition' &&
            p.start >= operation.registration.start &&
            p.end <= operation.execution.start,
        );
      if (
        !guard ||
        !scenario.assertions.some(
          (a) =>
            flow.nodes.find((n) => n.id === a.nodeId)?.unitId === entrance.id &&
            a.event === 'branch' &&
            a.valueId === guard.id &&
            a.operator === 'equals' &&
            a.expected === true,
        )
      )
        return false;
    }
    const facts = state.facts.values
      .filter((v) => v.unitId === unit.id && v.start === point.start && v.end === point.end)
      .map((v) => v.id);
    const exactAssertion = scenario.assertions.some(
      (a) =>
        flow.nodes.find((n) => n.id === a.nodeId)?.unitId === unit.id &&
        ((a.valueId === point.id && ['point', 'branch'].includes(a.event)) ||
          (facts.includes(a.valueId) && ['return', 'value', 'throw'].includes(a.event))),
    );
    if (!exactAssertion) return false;
    if (!reports.has(flowId))
      reports.set(
        flowId,
        checkFlowRecord(
          flow,
          state,
          document,
          path.join(state.root, '.blueprint-analysis', state.sessionId),
        ),
      );
    const report = reports.get(flowId);
    return report.valid && report.scenarios.some((s) => s.id === scenarioId && s.valid);
  };
}
