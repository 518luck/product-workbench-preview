import fs from 'node:fs';
import path from 'node:path';
import { checkFlows, featureDefinitionHash } from './flow.mjs';
import { readSnapshot } from './document-operations.mjs';
import { updateDocument } from './document-store.mjs';
import { renderDocument, writeHtml } from './document.mjs';
import { checkState, withAnalysisSession, assertFresh, loadSession } from './analysis-session.mjs';
import { BlueprintError } from './errors.mjs';
import { digest } from './analysis-facts.mjs';
import { checkVerificationPlans } from './verification-plan.mjs';

export function summarizeFlows(document, reports, verification = { features: {}, gaps: [] }) {
  const features = {};
  for (const [id, feature] of Object.entries(document.features)) {
    const flows = reports
      .flatMap((report) => report.flows || [])
      .filter((flow) => flow.featureIds?.includes(id));
    const statuses = flows.map((flow) => flow.status);
    const observed = new Set(
      flows
        .filter((flow) => flow.valid)
        .flatMap((flow) =>
          (flow.businessSteps || []).filter((s) => s.featureId === id).map((s) => s.step),
        ),
    );
    const linked = flows.some(
      (flow) =>
        flow.valid &&
        feature.flow.length > 0 &&
        feature.flow.every((_, step) =>
          flow.businessSteps?.some((s) => s.featureId === id && s.step === step),
        ),
    );
    const coverage = {
      observedSteps: [...observed].sort((a, b) => a - b),
      totalSteps: feature.flow.length,
    };
    const evidence = verification.features[id];
    const scopeGaps = verification.gaps.filter(
      (g) => g.path === `/features/${id}` || g.path?.startsWith(`/features/${id}/`),
    );
    const missing = feature.flow.flatMap((_, step) =>
      observed.has(step)
        ? []
        : [
            {
              kind: 'coverage',
              path: `/features/${id}/flow/${step}`,
              message: `业务步骤 ${step + 1} 尚无有效链路观测；组件或契约执行另列。`,
            },
          ],
    );
    const status =
      statuses.includes('stale') || scopeGaps.some((g) => g.kind === 'stale')
        ? 'stale'
        : statuses.includes('failed')
          ? 'failed'
          : linked && statuses.every((value) => value === 'passed')
            ? 'passed'
            : statuses.some((value) => ['passed', 'partial'].includes(value)) ||
                evidence?.scenarios.some((s) => s.valid)
              ? 'partial'
              : 'unverified';
    features[id] = {
      status,
      revision: feature.revision,
      definitionHash: featureDefinitionHash(feature),
      flows,
      coverage,
      ...(evidence ? { verification: evidence } : {}),
      gaps: [
        ...flows.flatMap((flow) => flow.gaps),
        ...missing,
        ...scopeGaps,
        ...(observed.size === feature.flow.length && !linked
          ? [{ kind: 'coverage', message: '各局部观测尚未在同一条有效流程中连接到业务结果。' }]
          : []),
      ],
    };
  }
  return {
    version: 1,
    features,
    globalGaps: reports.flatMap((report) => (report.gaps || []).filter((gap) => !gap.flowId)),
    scope: '已识别入口、声明场景及当前支持范围；流程结论与功能完成历史分别记录。',
  };
}
export function readFlowStatus(filename, document = readSnapshot(filename).document) {
  const roots = new Set(
    [
      path.dirname(filename),
      path.dirname(path.dirname(filename)),
      ...Object.values(document.features)
        .map((feature) => feature.implementation?.sourceSnapshot?.root)
        .filter(Boolean),
    ].map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    }),
  );
  const reports = [];
  const verification = { features: {}, gaps: [] };
  const planReports = [];
  for (const root of roots) {
    const directory = path.join(root, '.blueprint-analysis');
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((name) => /^s-[a-f0-9]{64}$/.test(name))) {
      const session = path.join(directory, name);
      try {
        const { state } = loadSession(session);
        const hasPlans = Object.values(state.verificationPlans || {}).some(
          (p) => p.documentPath === fs.realpathSync(filename),
        );
        if (hasPlans) {
          const report = checkVerificationPlans(filename, session, state);
          planReports.push({
            createdAt: state.createdAt,
            ids: [
              ...new Set(
                Object.values(state.verificationPlans)
                  .filter((p) => p.documentPath === fs.realpathSync(filename))
                  .map((p) => p.featureId),
              ),
            ],
            ...report,
          });
        }
        if (
          hasPlans ||
          Object.values(state.flows || {}).some(
            (flow) => flow.documentPath === fs.realpathSync(filename),
          )
        ) {
          const report = checkFlows(filename, session),
            flowGaps = new Set(report.flows.flatMap((flow) => flow.gaps));
          reports.push({
            createdAt: state.createdAt,
            scopeKey: JSON.stringify([root, state.scope]),
            ...report,
            // Stale flow gaps have no flowId on old snapshots. They still
            // belong to the flow, not to the current project's global gaps.
            gaps: report.gaps.filter((gap) => !flowGaps.has(gap)),
          });
        }
      } catch (error) {
        reports.push({
          flows: [],
          gaps: [{ kind: 'integrity', message: `无法读取流程记录：${error.message}` }],
        });
      }
    }
  }
  const planned = new Set();
  for (const report of planReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    for (const id of report.ids) {
      if (planned.has(id)) continue;
      planned.add(id);
      if (report.features[id]) verification.features[id] = report.features[id];
      verification.gaps.push(
        ...report.gaps
          .filter(
            (g) =>
              g.path === '/' ||
              g.path === `/features/${id}` ||
              g.path?.startsWith(`/features/${id}/`),
          )
          .map((g) => (g.path === '/' ? { ...g, path: `/features/${id}` } : g)),
      );
    }
  }
  reports.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  // A newer scan supersedes old source-bound reports; preserve history on disk.
  const seen = new Set(),
    scopes = new Set();
  for (const report of reports) {
    // Historical missing-entry and stale gaps must not shadow a newer mapping
    // of the same source scope. Its individual unsuperseded flows remain visible.
    if (report.scopeKey) {
      if (scopes.has(report.scopeKey)) report.gaps = [];
      scopes.add(report.scopeKey);
    }
    report.flows = report.flows.filter((flow) => {
      if (seen.has(flow.id)) return false;
      seen.add(flow.id);
      return true;
    });
  }
  return summarizeFlows(document, reports, verification);
}
export async function syncFlowStatus(filename, session) {
  const snapshot = readSnapshot(filename);
  return withAnalysisSession(session, async (state) => {
    const report = checkFlows(filename, session),
      analysis = checkState(state);
    return updateDocument(
      filename,
      (document, { original }) => {
        if (digest(original) !== snapshot.documentHash)
          throw new BlueprintError('CONFLICT', '保存流程状态期间文档已变化，请重新核验。', {
            status: 409,
          });
        const verification = Object.keys(state.verificationPlans || {}).length
          ? checkVerificationPlans(filename, session, state)
          : { features: {}, gaps: [] };
        const status = summarizeFlows(
          document,
          [report, { flows: [], gaps: analysis.gaps }],
          verification,
        );
        document.flowVerification = { ...status, snapshotHash: report.snapshotHash };
        return {
          changed: true,
          result: {
            valid: report.valid,
            documentSaved: true,
            htmlUpdated: false,
            features: status.features,
            gaps: report.gaps,
          },
        };
      },
      {
        beforeCommit() {
          assertFresh(state);
        },
        afterCommit(document, result) {
          try {
            writeHtml(path.join(path.dirname(filename), 'index.html'), renderDocument(document));
            result.htmlUpdated = true;
          } catch (error) {
            throw new BlueprintError(
              'RENDER_FAILED',
              `流程状态已保存，HTML 更新失败：${error.message}`,
              { status: 500, documentSaved: true, htmlUpdated: false, result },
            );
          }
        },
      },
    );
  });
}
