import fs from 'node:fs';
import path from 'node:path';
import { checkFlows, featureDefinitionHash } from './flow.mjs';
import { readSnapshot } from './document-operations.mjs';
import { updateDocument } from './document-store.mjs';
import { renderDocument, writeHtml } from './document.mjs';
import { checkState, withAnalysisSession, assertFresh } from './analysis-session.mjs';
import { BlueprintError } from './errors.mjs';
import { digest } from './analysis-facts.mjs';

export function summarizeFlows(document, reports) {
  const features = {};
  for (const [id, feature] of Object.entries(document.features)) {
    const flows = reports
      .flatMap((report) => report.flows || [])
      .filter((flow) => flow.featureIds?.includes(id));
    const statuses = flows.map((flow) => flow.status);
    const status = statuses.includes('stale')
      ? 'stale'
      : statuses.includes('failed')
        ? 'failed'
        : flows.length && statuses.every((value) => value === 'passed')
          ? 'passed'
          : statuses.some((value) => ['passed', 'partial'].includes(value))
            ? 'partial'
            : 'unverified';
    features[id] = {
      status,
      revision: feature.revision,
      definitionHash: featureDefinitionHash(feature),
      flows,
      gaps: flows.length
        ? flows.flatMap((flow) => flow.gaps)
        : [{ kind: 'flow', message: '此功能尚无当前协议的业务流程与运行证据。' }],
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
  for (const root of roots) {
    const directory = path.join(root, '.blueprint-analysis');
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((name) => /^s-[a-f0-9]{64}$/.test(name))) {
      const session = path.join(directory, name);
      try {
        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
        if (
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
  return summarizeFlows(document, reports);
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
        const status = summarizeFlows(document, [report, { flows: [], gaps: analysis.gaps }]);
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
