import fs from 'node:fs';
import path from 'node:path';
import { readSnapshot, featureStatus } from './document-operations.mjs';
import { renderDocument } from './document.mjs';
import { loadSession, assertFresh, checkState, guardAnalysis } from './analysis-session.mjs';
import { checkVerification } from './verification.mjs';
import { checkSourceStatus } from './source-status.mjs';
import { checkDeliveryContent } from './delivery-content.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && Boolean(value.trim());

// Read-only final gate. Saving a document or passing Schema validation is not this gate.
export async function checkDelivery(filename, session, review) {
  const snapshot = readSnapshot(filename),
    { state } = loadSession(session);
  assertFresh(state);
  const analysis = checkState(state),
    gaps = [...analysis.gaps];
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
      (key) => !['version', 'documentHash', 'features', 'diagrams', 'journeys'].includes(key),
    ) ||
    review.version !== 2 ||
    !Array.isArray(review.features) ||
    !object(review.diagrams)
  ) {
    add(
      '/review',
      'review',
      '需要 version:2、features 数组、核心 journeys 及项目 diagrams 判断；旧审阅须重新核对内容。',
    );
    review = { features: [], diagrams: {} };
  }
  if (review.documentHash !== snapshot.documentHash)
    add('/review/documentHash', 'stale', '交付审阅未绑定当前文档哈希。');
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
    if (item.revision !== feature.revision) add(where, 'stale', '审阅功能版本已变化。');
    if (featureStatus(feature) === 'complete') {
      if (item.outcome !== 'implemented') add(where, 'status', '完成状态与逐功能判断不一致。');
      gaps.push(...checkVerification(filename, feature, feature.implementation, state, session));
    } else {
      if (
        !['requested', 'unimplemented', 'unverified'].includes(item.outcome) ||
        !text(item.reason) ||
        !text(item.evidence)
      )
        add(where, 'draft', '草稿须区分新需求、未实现或未核验，并填写具体原因与查找／核验依据。');
    }
    for (const kind of ['sequence', 'dataflow'])
      diagram(feature[kind], item.diagrams?.[kind], `${where}/${kind}`);
  }
  for (const id of Object.keys(document.features))
    if (!reviewed.has(id)) add(`/features/${id}`, 'review', '尚未提交逐功能状态判断。');
  for (const kind of ['architecture', 'entities'])
    diagram(document.diagrams?.[kind], review.diagrams[kind], `/diagrams/${kind}`);
  gaps.push(...checkDeliveryContent(document, review));
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
  assertFresh(state);
  if (readSnapshot(filename).documentHash !== snapshot.documentHash)
    add('/review/documentHash', 'stale', '交付检查期间文档发生变化，请重新检查。');
  return {
    valid: gaps.length === 0,
    stage: gaps.length ? 'incomplete' : 'ready',
    documentHash: snapshot.documentHash,
    snapshotHash: state.snapshotHash,
    unitCount: analysis.unitCount,
    recordedCount: analysis.recordedCount,
    reviewedCount: analysis.reviewedCount,
    reviewPointCount: analysis.reviewPointCount,
    reviewedPointCount: analysis.reviewedPointCount,
    featureCount: Object.keys(document.features).length,
    gaps: [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()],
    review,
  };
}
