import fs from 'node:fs';
import path from 'node:path';
import { readSnapshot, featureStatus } from './document-operations.mjs';
import { renderDocument } from './document.mjs';
import { loadSession, assertFresh, checkState, guardAnalysis } from './analysis-session.mjs';
import { checkVerification } from './verification.mjs';
import { checkSourceStatus } from './source-status.mjs';
import { checkDeliveryContent } from './delivery-content.mjs';
import { checkFlows } from './flow.mjs';
import { checkVerificationPlans } from './verification-plan.mjs';
import { currentAssessment } from './feature-operations.mjs';
import { basisProblems, assessmentScopeProblems } from './source-evidence.mjs';
import { checkArtifactLayout } from './artifact-layout.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && Boolean(value.trim());

// Read-only final gate. Saving a document or passing Schema validation is not this gate.
export async function checkDelivery(filename, session, review) {
  const snapshot = readSnapshot(filename),
    { state } = loadSession(session);
  let stale;
  try {
    assertFresh(state);
  } catch (error) {
    stale = error.message;
  }
  const analysis = stale
      ? {
          gaps: [{ path: '/', kind: 'stale', message: stale }],
          unitCount: state.units.length,
          recordedCount: Object.keys(state.records).length,
        }
      : checkState(state),
    gaps = [...analysis.gaps, ...checkArtifactLayout(filename, state)];
  const add = (where, kind, message) => gaps.push({ path: where, kind, message });
  const document = snapshot.document;
  const guard = (changes, operations) => {
    try {
      guardAnalysis(state, { document, changes }, { operations });
    } catch (error) {
      gaps.push(...(error.details ?? [{ path: '/', kind: 'trace', message: error.message }]));
    }
  };
  guard(
    Object.entries(document.features).map(([id, feature]) => ({
      path: `/features/${id}`,
      after: feature,
    })),
    [],
  );
  guard(
    [],
    Object.values(document.features)
      .filter((feature) => featureStatus(feature) === 'complete')
      .map((feature) => ({ op: 'feature.complete', id: feature.id })),
  );
  if (!text(document.product.background)) add('/product/background', 'content', '缺少产品背景。');
  if (!Object.keys(document.features).length) add('/features', 'content', '产品书没有功能定义。');
  if (
    !object(review) ||
    Object.keys(review).some(
      (key) =>
        ![
          'version',
          'documentHash',
          'features',
          'diagrams',
          'journeys',
          'flows',
          'acknowledgedGaps',
          'scope',
        ].includes(key),
    ) ||
    ![2, 3, 4].includes(review.version) ||
    !Array.isArray(review.features) ||
    !object(review.diagrams)
  ) {
    add(
      '/review',
      'review',
      '需要 version:4、features、journeys、diagrams、flows 和 acknowledgedGaps；v3 保留严格流程检查。',
    );
    review = { features: [], diagrams: {} };
  }
  if (review.documentHash !== snapshot.documentHash)
    add('/review/documentHash', 'stale', '交付审阅未绑定当前文档哈希。');
  if (![3, 4].includes(review.version))
    add('/review/version', 'review', '旧交付审阅缺少业务连接核验，不能获得 v3 严格通过结论。');
  const flows = checkFlows(filename, session);
  const layered = review.version === 4;
  const verification = layered ? checkVerificationPlans(filename, session, state) : undefined;
  const selectedFlows = layered
    ? flows.flows.filter((f) => review.flows?.includes(f.id))
    : flows.flows;
  gaps.push(
    ...(layered
      ? [
          ...selectedFlows.flatMap((f) => f.gaps),
          ...flows.gaps.filter((g) => ['entry', 'scope'].includes(g.kind)),
        ]
      : flows.gaps),
    ...(verification?.gaps || []),
  );
  if ([3, 4].includes(review.version)) {
    if (
      !Array.isArray(review.flows) ||
      new Set(review.flows).size !== review.flows.length ||
      review.flows.some(
        (id) => typeof id !== 'string' || !flows.flows.some((flow) => flow.id === id),
      )
    )
      add('/review/flows', 'flow', '审阅须引用本产品书真实流程编号。');
    if (
      !Array.isArray(review.acknowledgedGaps) ||
      review.acknowledgedGaps.some(
        (gap) => !object(gap) || !text(gap.kind) || !text(gap.path) || !text(gap.reason),
      )
    )
      add('/review/acknowledgedGaps', 'review', '部分交付须逐项列明真实缺口及其影响。');
    if (!layered)
      for (const [featureId, feature] of Object.entries(document.features))
        for (let step = 0; step < feature.flow.length; step++)
          if (
            !Object.values(state.flows || {}).some(
              (flow) =>
                review.flows?.includes(flow.id) &&
                flow.nodes.some((node) => node.featureId === featureId && node.step === step),
            )
          )
            add(`/features/${featureId}/flow/${step}`, 'flow', '此业务步骤尚未绑定可核验流程。');
  }
  const reviewed = new Set();
  const diagram = (value, decision, where) => {
    if (!object(decision)) return add(where, 'diagram', '缺少图表适用性判断。');
    if (value !== undefined) {
      const present = Array.isArray(value.roles)
        ? value.roles.length && [...(value.base ?? []), ...(value.normal ?? [])].length
        : value.nodes?.length;
      if (decision.decision !== 'included' || !present)
        add(where, 'diagram', '图表为空或与 included 判断不符。');
    } else if (decision.decision !== 'skipped' || !text(decision.reason))
      add(where, 'diagram', '未生成图表时必须说明具体跳过原因。');
  };
  for (const item of review.features) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !Object.hasOwn(document.features, item.id) ||
      reviewed.has(item.id)
    ) {
      add('/review/features', 'review', '含未知或重复功能编号。');
      continue;
    }
    reviewed.add(item.id);
    const feature = document.features[item.id],
      where = `/features/${item.id}`;
    const assessment = currentAssessment(feature);
    for (const problem of assessmentScopeProblems(feature, assessment?.items))
      add(`${where}/implementationAssessment${problem.target}`, 'assessment', problem.message);
    if (assessment)
      for (const assessed of assessment.items)
        if (assessed.state !== 'unknown' && !assessed.requirement) {
          const claim = assessed.target
            .split('/')
            .slice(1)
            .reduce((v, k) => v?.[k], feature);
          for (const message of basisProblems(
            state,
            assessed.basis,
            typeof claim === 'string' ? claim : JSON.stringify(claim),
          ))
            add(`${where}/implementationAssessment${assessed.target}`, 'assessment', message);
        }
    if (item.revision !== feature.revision) add(where, 'stale', '审阅功能版本已变化。');
    if (featureStatus(feature) === 'complete') {
      if (item.outcome !== 'implemented') add(where, 'status', '完成状态与逐功能判断不一致。');
      if (
        !layered ||
        !currentAssessment(feature) ||
        (feature.implementation?.revision === feature.revision &&
          feature.implementation.sourceSnapshot?.snapshotHash === state.snapshotHash)
      )
        gaps.push(...checkVerification(filename, feature, feature.implementation, state, session));
      if (layered) {
        const evidence = verification.features[item.id];
        for (const entry of item.acceptance || []) {
          const scenario = evidence?.scenarios.find(
            (s) =>
              s.valid &&
              s.kind === entry.scenario &&
              s.criteria.includes(entry.criterion) &&
              s.executionIds.includes(entry.executionId) &&
              entry.steps?.every(
                (i) =>
                  s.steps.includes(i) &&
                  (s.level === 'end-to-end' ||
                    s.observations?.some((o) => o.step === i && o.criterion === entry.criterion)),
              ),
          );
          if (!scenario)
            add(
              `${where}/acceptance`,
              'verification',
              '验收映射未引用执行前声明的当前分层场景及其业务范围。',
            );
        }
      }
    } else {
      if (
        !['requested', 'unimplemented', 'unverified'].includes(item.outcome) ||
        !text(item.reason) ||
        !text(item.evidence)
      )
        add(where, 'draft', '草稿须区分新需求、未实现或未核验，并填写具体原因与查找／核验依据。');
      if (
        layered &&
        !currentAssessment(feature) &&
        text(item.reason) &&
        !feature.notes?.includes(item.reason)
      )
        add(where, 'draft', '草稿的具体原因须写入产品书 notes，不能只留在内部审阅记录。');
      if (
        featureStatus(feature) === 'draft' &&
        !['requested', 'unimplemented'].includes(item.outcome)
      )
        add(where, 'status', '草稿表示具体业务内容尚未实现，不能用未测试代替未实现。');
      if (featureStatus(feature) === 'unknown' && item.outcome !== 'unverified')
        add(where, 'status', '实现尚未确认，不能直接宣称已实现或未实现。');
      if (
        layered &&
        item.outcome === 'unverified' &&
        !verification.features[item.id]?.steps.some((s) => s.limitation)
      )
        add(
          where,
          'verification',
          '已有实现尚未验收，应继续执行；真实限制须在预先保存的方案中提供证据。',
        );
    }
    for (const kind of ['sequence', 'dataflow'])
      diagram(feature[kind], item.diagrams?.[kind], `${where}/${kind}`);
  }
  for (const id of Object.keys(document.features))
    if (!reviewed.has(id)) add(`/features/${id}`, 'review', '尚未提交逐功能状态判断。');
  for (const kind of ['architecture', 'entities'])
    diagram(document.diagrams?.[kind], review.diagrams[kind], `/diagrams/${kind}`);
  const supportedStep = (id, step) =>
    verification?.gaps.some(
      (gap) =>
        gap.kind === 'limitation' &&
        gap.path === `/features/${id}/flow/${step.step}` &&
        JSON.stringify(gap.limitation) === JSON.stringify(step.limitation),
    );
  const limitedSteps = layered
    ? Object.fromEntries(
        Object.entries(verification.features).map(([id, value]) => [
          id,
          value.steps.filter((s) => s.limitation && supportedStep(id, s)).map((s) => s.step),
        ]),
      )
    : {};
  const sourceOnlyFeatures = new Set(
    layered
      ? Object.entries(verification.features)
          .filter(
            ([id, evidence]) =>
              currentAssessment(document.features[id]) &&
              evidence.steps.length &&
              evidence.steps.every(
                (step) => step.level === 'source' && step.limitation && supportedStep(id, step),
              ),
          )
          .map(([id]) => id)
      : [],
  );
  const executionIds = layered
    ? Object.fromEntries(
        Object.entries(verification.features).map(([id, evidence]) => [
          id,
          evidence.scenarios.filter((s) => s.valid).flatMap((s) => s.executionIds),
        ]),
      )
    : {};
  gaps.push(
    ...checkDeliveryContent(document, review, {
      limitedSteps,
      sourceOnlyFeatures,
      executionIds,
      root: state.root,
    }),
  );
  const sourceStatus = await checkSourceStatus(document);
  for (const [id, feature] of Object.entries(document.features))
    if (featureStatus(feature) === 'complete' && sourceStatus.features[id]?.status !== 'current')
      add(`/features/${id}`, 'source', '完成记录的源码基线需要重新核验。');
  try {
    if (
      fs.readFileSync(path.join(path.dirname(filename), 'index.html'), 'utf8') !==
      renderDocument(document)
    )
      add('/html', 'html', 'HTML 未对应当前文档及固定模板，请运行 render。');
  } catch (error) {
    add('/html', 'html', `无法读取最新 HTML：${error.message}`);
  }
  // Catch edits while inspecting the book; do not attach a success report to a changed snapshot.
  try {
    assertFresh(state);
  } catch (error) {
    add('/', 'stale', error.message);
  }
  if (readSnapshot(filename).documentHash !== snapshot.documentHash)
    add('/review/documentHash', 'stale', '交付检查期间文档发生变化，请重新检查。');
  const visible = review.acknowledgedGaps || [];
  const shownGaps = [
    ...(document.flowVerification?.globalGaps || []),
    ...Object.values(document.flowVerification?.features || {}).flatMap(
      (feature) => feature.gaps || [],
    ),
  ];
  const gapKey = (gap) =>
    JSON.stringify(
      [
        'kind',
        'message',
        'path',
        'flowId',
        'unitId',
        'edgeId',
        'pointId',
        'scenarioId',
        'entryId',
      ].map((key) => [key, gap[key]]),
    );
  const flowGapsVisible = [
    ...(layered ? selectedFlows.flatMap((f) => f.gaps) : flows.gaps),
    ...analysis.gaps,
    ...(verification?.gaps || []).filter((g) => g.kind === 'limitation'),
    ...flows.gaps.filter((g) => g.kind === 'scope'),
  ].every((gap) => shownGaps.some((shown) => gapKey(shown) === gapKey(gap)));
  const readable =
    Boolean(Object.keys(document.features).length && text(document.product.background)) &&
    !gaps.some((gap) => ['html', 'review'].includes(gap.kind));
  const deliverable =
    readable &&
    flowGapsVisible &&
    gaps.every(
      (gap) =>
        ((gap.kind === 'scope' &&
          object(review.scope) &&
          text(review.scope.reason) &&
          review.scope.authorization?.source === 'user' &&
          text(review.scope.authorization.text)) ||
          (gap.kind === 'limitation' && verification?.gaps.includes(gap)) ||
          (['semantic', 'language', 'adapter'].includes(gap.kind) &&
            analysis.gaps.includes(gap))) &&
        visible.some(
          (item) =>
            item.kind === gap.kind &&
            item.path === (gap.path || gap.flowId || gap.entryId || '/') &&
            text(item.reason),
        ),
    );
  return {
    valid: gaps.length === 0,
    deliverable: gaps.length === 0 || deliverable,
    stage: gaps.length ? (deliverable ? 'partial' : 'incomplete') : 'ready',
    documentHash: snapshot.documentHash,
    snapshotHash: state.snapshotHash,
    unitCount: analysis.unitCount,
    recordedCount: analysis.recordedCount,
    reviewedCount: analysis.reviewedCount,
    reviewPointCount: analysis.reviewPointCount,
    reviewedPointCount: analysis.reviewedPointCount,
    featureCount: Object.keys(document.features).length,
    flows,
    ...(layered
      ? {
          verification,
          diagnostics: {
            pendingEntries: flows.pendingEntries,
            unselectedFlows: flows.flows.filter((f) => !review.flows?.includes(f.id)),
          },
        }
      : {}),
    flowGapsVisible,
    scope: layered
      ? '结论仅覆盖预先保存的逐业务步骤验收方案；源码核对、组件／契约执行及端到端观测分别报告，不宣称穷尽所有分支。'
      : '结论仅涵盖已识别入口、声明场景和当前适配器支持范围；功能完成历史独立保留。',
    gaps: [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()],
    review,
  };
}
