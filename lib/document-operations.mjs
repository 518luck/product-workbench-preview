import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateDocument, renderDocument, writeHtml, assertHtmlOutput } from './document.mjs';
import { updateDocument, DocumentConflictError } from './document-store.mjs';
import { BlueprintError } from './errors.mjs';
import {
  createFeature,
  finalizeFeature,
  implementationStatus,
  currentAssessment,
} from './feature-operations.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const featureFields = [
  'title',
  'groupPath',
  'overview',
  'notes',
  'actors',
  'rules',
  'checks',
  'impact',
  'flow',
  'stepDetails',
  'dependencies',
  'sequence',
  'dataflow',
];
const optionalFields = ['overview', 'notes', 'actors', 'checks', 'impact', 'sequence', 'dataflow'];
const productFields = ['name', 'background', 'actors', 'repository'];
const dependencyFields = [
  'name',
  'category',
  'purpose',
  'description',
  'responsibility',
  'failure',
  'openQuestions',
  'relations',
];
export const documentHash = (source) => createHash('sha256').update(source).digest('hex');
const serialized = (document) => JSON.stringify(document, null, 2) + '\n';
export const featureStatus = implementationStatus;

function argument(message, details) {
  throw new BlueprintError('INVALID_ARGUMENT', message, { details });
}
function checkedDocument(document) {
  const report = validateDocument(document);
  if (!report.valid)
    throw new BlueprintError('VALIDATION_FAILED', '文档校验失败，未保存。', {
      details: report.errors,
    });
  return document;
}
function keys(value, allowed, label) {
  if (!object(value)) argument(`${label}应为对象。`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) argument(`${label}不支持字段：${key}。`);
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    argument('编号应为小写字母开头的稳定编号。');
  return value;
}
function feature(document, value) {
  id(value);
  if (!own(document.features, value))
    throw new BlueprintError('NOT_FOUND', `功能不存在：${value}。`, { status: 404 });
  return document.features[value];
}
function dependencyIndex(document, value) {
  id(value);
  const index = document.dependencies.findIndex((item) => item.id === value);
  if (index < 0) throw new BlueprintError('NOT_FOUND', `依赖不存在：${value}。`, { status: 404 });
  return index;
}
function requireHash(expectedHash, actualHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
    argument('请提供读取结果中的 expectedHash（SHA-256）。');
  if (expectedHash !== actualHash)
    throw new BlueprintError('CONFLICT', '文档已变化，请重新读取并预览变更。', {
      status: 409,
      expectedHash,
      actualHash,
    });
}

export function readSnapshot(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    throw new BlueprintError('VALIDATION_FAILED', '项目文档不是有效 JSON。');
  }
  return { document: checkedDocument(document), documentHash: documentHash(source) };
}
export function queryDocument(snapshot, { section = 'all' } = {}) {
  if (!['all', 'product', 'dependencies', 'diagrams'].includes(section))
    argument('分区应为 all、product、dependencies 或 diagrams。');
  return {
    documentHash: snapshot.documentHash,
    section,
    data: section === 'all' ? snapshot.document : (snapshot.document[section] ?? {}),
  };
}
export function listFeatures(snapshot, { group, status } = {}) {
  if (status !== undefined && !['draft', 'complete', 'unknown'].includes(status))
    argument('状态应为 draft、complete 或 unknown。');
  if (group !== undefined && typeof group !== 'string') argument('分组应为用 / 分隔的文字。');
  const groupPath =
    group === undefined
      ? undefined
      : group
          .split('/')
          .map((part) => part.trim())
          .filter(Boolean);
  return {
    documentHash: snapshot.documentHash,
    features: Object.values(snapshot.document.features)
      .filter(
        (item) =>
          (status === undefined || featureStatus(item) === status) &&
          (groupPath === undefined ||
            (groupPath.length
              ? groupPath.every((part, index) => item.groupPath[index] === part)
              : !item.groupPath.length)),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        groupPath: item.groupPath,
        status: featureStatus(item),
        missing: currentAssessment(item)?.items.filter((entry) => entry.state === 'missing') ?? [],
        revision: item.revision,
        editRevision: item.editRevision ?? 0,
        flowRevision: item.flowRevision,
        annotationCount: item.annotations?.length ?? 0,
      })),
  };
}
export function getFeature(snapshot, value, { related = false } = {}) {
  const item = feature(snapshot.document, value);
  const result = { documentHash: snapshot.documentHash, feature: item };
  if (related) {
    const references = new Set(item.dependencies);
    for (const detail of item.stepDetails)
      for (const reference of detail.dependencies) references.add(reference);
    for (const node of item.dataflow?.nodes ?? []) {
      if (node.dependency) references.add(node.dependency);
      for (const reference of node.dependencies ?? []) references.add(reference);
    }
    result.relatedDependencies = snapshot.document.dependencies.filter(
      (entry) => references.has(entry.id) || entry.relations?.includes(value),
    );
  }
  return result;
}

// 部分对象补充时保留旧元数据；带稳定编号的数组按编号合并，不按显示次序关联历史字段。
function mergeHistory(previous, next) {
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return structuredClone(next);
    const keyed = next.every((item) => object(item) && typeof item.id === 'string');
    return next.map((item, index) => {
      const old = keyed ? previous.find((entry) => entry?.id === item.id) : previous[index];
      return object(item) ? mergeHistory(old, item) : structuredClone(item);
    });
  }
  if (!object(next)) return structuredClone(next);
  const result = object(previous) ? structuredClone(previous) : {};
  for (const [key, value] of Object.entries(next)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      argument(`内容包含不支持的字段：${key}。`);
    Object.defineProperty(result, key, {
      value: mergeHistory(result[key], value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
function mergeFeatureHistory(previous, changes) {
  const result = mergeHistory(previous, changes);
  if (Array.isArray(changes.flow)) {
    const used = new Set();
    const positions = changes.flow.map((step, index) => {
      let old =
        previous.flow[index]?.[0] === step?.[0]
          ? index
          : previous.flow.findIndex(
              (item, oldIndex) => !used.has(oldIndex) && item[0] === step?.[0],
            );
      if (old < 0) old = index;
      used.add(old);
      return old;
    });
    result.flow = changes.flow.map((step, index) => {
      if (!Array.isArray(step)) return structuredClone(step);
      const old = previous.flow[positions[index]];
      return Array.isArray(old) && step.length >= 2 && step.length < old.length
        ? [...structuredClone(step), ...structuredClone(old.slice(step.length))]
        : structuredClone(step);
    });
    if (Array.isArray(changes.stepDetails))
      result.stepDetails = changes.stepDetails.map((detail, index) =>
        mergeHistory(previous.stepDetails[positions[index]], detail),
      );
  }
  return result;
}
const escapePointer = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
function diff(before, after, pointer = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (object(before) && object(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      diff(
        own(before, key) ? before[key] : undefined,
        own(after, key) ? after[key] : undefined,
        `${pointer}/${escapePointer(key)}`,
      ),
    );
  return [
    {
      path: pointer || '/',
      action: before === undefined ? 'add' : after === undefined ? 'remove' : 'replace',
      before: before ?? null,
      after: after ?? null,
    },
  ];
}
function referencesTo(document, type, value) {
  const references = [];
  if (type === 'feature') {
    document.dependencies.forEach((entry, index) => {
      if (entry.relations?.includes(value))
        references.push({ path: `/dependencies/${index}/relations`, id: entry.id });
    });
    return references;
  }
  const graph = (model, pointer) =>
    (Array.isArray(model?.nodes) ? model.nodes : []).forEach((node, index) => {
      if (node.dependency === value || node.dependencies?.includes(value))
        references.push({ path: `${pointer}/nodes/${index}`, id: node.id });
    });
  for (const [key, item] of Object.entries(document.features)) {
    if (item.dependencies.includes(value))
      references.push({ path: `/features/${key}/dependencies`, id: key });
    item.stepDetails.forEach((detail, index) => {
      if (detail.dependencies.includes(value))
        references.push({ path: `/features/${key}/stepDetails/${index}/dependencies`, id: key });
    });
    graph(item.dataflow, `/features/${key}/dataflow`);
  }
  for (const kind of ['architecture', 'entities'])
    graph(document.diagrams?.[kind], `/diagrams/${kind}`);
  return references;
}
function operationShape(operation) {
  const shapes = {
    'feature.create': ['op', 'id', 'data'],
    'feature.update': ['op', 'id', 'changes', 'unset'],
    'feature.define': ['op', 'id', 'description'],
    'feature.delete': ['op', 'id'],
    'feature.sync': ['op', 'id'],
    'feature.complete': ['op', 'id', 'revision', 'implementation', 'resolvedAnnotationIds'],
    'product.update': ['op', 'changes', 'unset'],
    'dependency.create': ['op', 'data'],
    'dependency.update': ['op', 'id', 'changes', 'unset'],
    'dependency.delete': ['op', 'id'],
    'diagram.set': ['op', 'kind', 'data'],
    'diagram.delete': ['op', 'kind'],
  };
  if (!object(operation) || typeof operation.op !== 'string') argument('操作必须包含文字 op。');
  if (!own(shapes, operation.op)) argument(`不支持的操作：${operation.op}。`);
  keys(operation, shapes[operation.op], '操作');
}
function unsetFields(value, allowed) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((field) => !allowed.includes(field)) ||
    new Set(value).size !== value.length
  )
    argument('unset 必须是不重复的可选字段名称。');
  return value;
}

export function planChanges(original, bundle, { sourceSnapshot } = {}) {
  checkedDocument(original);
  keys(bundle, ['version', 'expectedHash', 'operations', 'affectedFeatureIds'], '变更批次');
  if (bundle.version !== 1 || !Array.isArray(bundle.operations) || !bundle.operations.length)
    argument('变更批次需要 version: 1 和非空 operations。');
  const affected = bundle.affectedFeatureIds ?? [];
  if (!Array.isArray(affected) || new Set(affected).size !== affected.length)
    argument('affectedFeatureIds 应为不重复的功能编号数组。');
  for (const value of affected) feature(original, value);
  const document = structuredClone(original);
  const touched = new Set(affected),
    deleted = [],
    unset = new Map(),
    synced = new Set(),
    completed = new Map();
  for (const operation of bundle.operations) {
    operationShape(operation);
    switch (operation.op) {
      case 'feature.create': {
        id(operation.id);
        if (own(original.features, operation.id) || own(document.features, operation.id))
          throw new BlueprintError('CONFLICT', `功能已存在：${operation.id}。`, { status: 409 });
        keys(operation.data, [...featureFields, 'description'], '新功能');
        Object.defineProperty(document.features, operation.id, {
          value: createFeature(operation.id, operation.data),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        touched.add(operation.id);
        break;
      }
      case 'feature.update': {
        const previous = feature(document, operation.id);
        keys(operation.changes ?? {}, featureFields, '功能修改（定义原文请使用 feature.define）');
        const removed = unsetFields(operation.unset, optionalFields);
        if (removed.some((field) => own(operation.changes ?? {}, field)))
          argument('同一操作不能同时修改与删除一个字段。');
        document.features[operation.id] = mergeFeatureHistory(previous, operation.changes ?? {});
        for (const field of removed) delete document.features[operation.id][field];
        const finalUnset = unset.get(operation.id) ?? new Set();
        for (const field of Object.keys(operation.changes ?? {})) finalUnset.delete(field);
        for (const field of removed) finalUnset.add(field);
        unset.set(operation.id, finalUnset);
        touched.add(operation.id);
        break;
      }
      case 'feature.define': {
        const previous = feature(document, operation.id);
        if (
          typeof operation.description !== 'string' ||
          !operation.description.trim() ||
          operation.description.length > 5000
        )
          argument('功能定义应为 1–5000 字。');
        previous.description = operation.description.trim();
        touched.add(operation.id);
        break;
      }
      case 'feature.delete': {
        feature(document, operation.id);
        deleted.push({
          type: 'feature',
          id: operation.id,
          references: referencesTo(original, 'feature', operation.id),
        });
        delete document.features[operation.id];
        touched.delete(operation.id);
        break;
      }
      case 'feature.sync': {
        feature(document, operation.id);
        synced.add(operation.id);
        touched.add(operation.id);
        break;
      }
      case 'feature.complete': {
        const current = feature(document, operation.id);
        if (completed.has(operation.id)) argument('同一批次不能重复登记一个功能的完成记录。');
        if (
          !Number.isSafeInteger(operation.revision) ||
          operation.revision < 0 ||
          !object(operation.implementation)
        )
          argument('完成操作需要准确的 revision 和 implementation 验收记录。');
        if (operation.resolvedAnnotationIds !== undefined) {
          const resolved = operation.resolvedAnnotationIds;
          if (
            !Array.isArray(resolved) ||
            !resolved.length ||
            new Set(resolved).size !== resolved.length
          )
            argument('resolvedAnnotationIds 应为不重复的已处理批注编号数组。');
          for (const value of resolved) {
            id(value);
            if (!current.annotations?.some((annotation) => annotation.id === value))
              throw new BlueprintError('NOT_FOUND', `批注不存在：${value}。`, { status: 404 });
          }
        }
        completed.set(operation.id, operation);
        touched.add(operation.id);
        break;
      }
      case 'product.update': {
        keys(operation.changes ?? {}, productFields, '产品修改');
        const removed = unsetFields(
          operation.unset,
          productFields.filter((field) => field !== 'name'),
        );
        if (removed.some((field) => own(operation.changes ?? {}, field)))
          argument('同一操作不能同时修改与删除一个字段。');
        document.product = mergeHistory(document.product, operation.changes ?? {});
        for (const field of removed) delete document.product[field];
        break;
      }
      case 'dependency.create': {
        keys(operation.data, ['id', ...dependencyFields], '新依赖');
        id(operation.data.id);
        if (
          original.dependencies.some((entry) => entry.id === operation.data.id) ||
          document.dependencies.some((entry) => entry.id === operation.data.id)
        )
          throw new BlueprintError('CONFLICT', `依赖已存在：${operation.data.id}。`, {
            status: 409,
          });
        document.dependencies.push(structuredClone(operation.data));
        break;
      }
      case 'dependency.update': {
        const index = dependencyIndex(document, operation.id);
        keys(operation.changes ?? {}, dependencyFields, '依赖修改');
        const removed = unsetFields(
          operation.unset,
          dependencyFields.filter((field) => field !== 'name'),
        );
        if (removed.some((field) => own(operation.changes ?? {}, field)))
          argument('同一操作不能同时修改与删除一个字段。');
        document.dependencies[index] = mergeHistory(
          document.dependencies[index],
          operation.changes ?? {},
        );
        for (const field of removed) delete document.dependencies[index][field];
        break;
      }
      case 'dependency.delete': {
        const index = dependencyIndex(document, operation.id);
        deleted.push({
          type: 'dependency',
          id: operation.id,
          references: referencesTo(original, 'dependency', operation.id),
        });
        document.dependencies.splice(index, 1);
        break;
      }
      case 'diagram.set':
      case 'diagram.delete': {
        if (!['architecture', 'entities'].includes(operation.kind))
          argument('项目图表类型应为 architecture 或 entities。');
        document.diagrams ??= {};
        if (operation.op === 'diagram.set') {
          keys(operation.data, ['title', 'nodes', 'edges'], '项目图表');
          document.diagrams[operation.kind] = mergeHistory(
            document.diagrams[operation.kind],
            operation.data,
          );
        } else {
          if (!own(document.diagrams, operation.kind))
            throw new BlueprintError('NOT_FOUND', '项目图表不存在。', { status: 404 });
          delete document.diagrams[operation.kind];
        }
        break;
      }
    }
  }
  // 每个功能只在最终候选上计算一次版本，即使批次中多次编辑同一功能。
  for (const value of touched) {
    if (!own(document.features, value)) argument(`受影响功能被删除：${value}。`);
    if (own(original.features, value))
      document.features[value] = structuredClone(
        finalizeFeature(original.features[value], document.features[value], {
          forceRevision: affected.includes(value),
          unset: [...(unset.get(value) ?? [])],
        }).feature,
      );
  }
  for (const value of synced) {
    const current = feature(document, value);
    if (!current.flow.length)
      throw new BlueprintError('VALIDATION_FAILED', '业务流程为空，请先梳理步骤后同步。');
    current.flowRevision = current.revision;
  }
  for (const [value, operation] of completed) {
    const current = feature(document, value);
    if (currentAssessment(current)?.items.some((item) => item.state !== 'implemented'))
      throw new BlueprintError(
        'VALIDATION_FAILED',
        '当前实现核对仍有未实现或待确认项，请先逐项核对，不能用验收记录覆盖。',
      );
    if (!sourceSnapshot && operation.implementation.sourceSnapshot !== undefined)
      argument('源码快照由 --analysis-session 自动绑定，不能从验收输入自行设置。');
    const implementation = {
      ...operation.implementation,
      ...(sourceSnapshot ? { sourceSnapshot } : {}),
    };
    if (!own(original.features, value) || current.revision !== original.features[value].revision)
      throw new BlueprintError(
        'VALIDATION_FAILED',
        '请先保存新的业务定义，再实现、验证该版本后登记完成。',
      );
    if (
      operation.revision !== current.revision ||
      operation.implementation.revision !== current.revision
    )
      throw new BlueprintError('CONFLICT', '验收记录不对应当前定义版本，请重新读取并验证。', {
        status: 409,
      });
    if (current.flowRevision !== current.revision || !current.flow.length)
      throw new BlueprintError('VALIDATION_FAILED', '当前业务流程尚未同步，不能登记完成。');
    if (!isDeepStrictEqual(current.implementation, implementation)) {
      if (current.implementation) {
        const history = current.implementationHistory ?? [];
        if (!Array.isArray(history))
          throw new BlueprintError(
            'VALIDATION_FAILED',
            '既有 implementationHistory 不是记录数组，未覆盖历史内容。',
          );
        current.implementationHistory = [...history, structuredClone(current.implementation)];
      }
      current.implementation = structuredClone(implementation);
    }
    current.implementedRevision = current.revision;
    if (operation.resolvedAnnotationIds)
      current.annotations = current.annotations.filter(
        (annotation) => !operation.resolvedAnnotationIds.includes(annotation.id),
      );
  }
  // 同步与验收同批登记时也只增加一次保存版本，不再增加业务定义版本。
  for (const value of new Set([...synced, ...completed.keys()])) {
    if (own(original.features, value))
      document.features[value] = structuredClone(
        finalizeFeature(original.features[value], document.features[value], {
          forceRevision: affected.includes(value),
          unset: [...(unset.get(value) ?? [])],
        }).feature,
      );
  }
  checkedDocument(document);
  const changes = diff(original, document);
  const summaries = [
    ...new Set([
      ...touched,
      ...deleted.filter((item) => item.type === 'feature').map((item) => item.id),
    ]),
  ].map((value) => {
    const summary = (entry) =>
      entry
        ? {
            revision: entry.revision,
            editRevision: entry.editRevision ?? 0,
            flowRevision: entry.flowRevision,
            status: featureStatus(entry),
          }
        : null;
    return {
      id: value,
      before: summary(own(original.features, value) ? original.features[value] : undefined),
      after: summary(own(document.features, value) ? document.features[value] : undefined),
    };
  });
  return {
    document,
    changed: changes.length > 0,
    changes,
    features: summaries,
    deletions: deleted,
  };
}

export async function applyChanges(
  filename,
  bundle,
  {
    dryRun = false,
    render = true,
    output,
    analysisSession,
    allowPartialAnalysis = false,
    requireVerification = false,
    _analysisState,
  } = {},
) {
  if (requireVerification && !analysisSession && !_analysisState)
    throw new BlueprintError('INVALID_ARGUMENT', '严格验收需要 --analysis-session。');
  if (allowPartialAnalysis && !analysisSession && !_analysisState)
    throw new BlueprintError('INVALID_ARGUMENT', '允许部分分析需要指定分析会话。');
  let analysis;
  if (analysisSession || _analysisState) analysis = await import('./analysis-session.mjs');
  if (analysisSession && !_analysisState)
    return analysis.withAnalysisSession(analysisSession, (state) =>
      applyChanges(filename, bundle, {
        dryRun,
        render,
        output,
        allowPartialAnalysis,
        requireVerification,
        analysisSession,
        _analysisState: state,
      }),
    );
  const resolved = path.resolve(filename);
  const html = path.resolve(output ?? path.join(path.dirname(resolved), 'index.html'));
  const canonicalDocument = render ? assertHtmlOutput(resolved, html) : fs.realpathSync(resolved);
  const verifyPlan = async (plan) => {
    const completions = bundle.operations.filter((op) => op.op === 'feature.complete');
    if (!completions.length) return;
    const hasReceipts = completions.some((op) =>
      op.implementation?.checks?.some((check) => check.executionId !== undefined),
    );
    if (!requireVerification && !hasReceipts) return;
    if (!_analysisState) throw new BlueprintError('INVALID_ARGUMENT', '验收执行记录需要分析会话。');
    const { checkVerification } = await import('./verification.mjs');
    const gaps = completions.flatMap((op) =>
      checkVerification(
        resolved,
        plan.document.features[op.id],
        plan.document.features[op.id].implementation,
        _analysisState,
        analysisSession,
        { required: requireVerification },
      ),
    );
    if (gaps.length)
      throw new BlueprintError('VERIFICATION_FAILED', '验收执行记录检查未通过，未保存。', {
        details: gaps,
      });
  };
  if (dryRun) {
    const snapshot = readSnapshot(resolved);
    requireHash(bundle?.expectedHash, snapshot.documentHash);
    const plan = planChanges(snapshot.document, bundle, {
      sourceSnapshot: _analysisState ? analysis.snapshotFromAnalysis(_analysisState) : undefined,
    });
    const analysisReport = _analysisState
      ? analysis.guardAnalysis(_analysisState, plan, bundle, { allowPartialAnalysis })
      : undefined;
    const { document, ...result } = plan;
    await verifyPlan(plan);
    return {
      ...result,
      documentHash: snapshot.documentHash,
      dryRun: true,
      documentSaved: false,
      htmlUpdated: false,
      ...(analysisReport ? { analysis: analysisReport } : {}),
      ...(render ? { html } : {}),
    };
  }
  // Prepare validation before acquiring the document lock; recheck receipts synchronously under it.
  const verification = await import('./verification.mjs');
  try {
    return await updateDocument(
      canonicalDocument,
      (document, { original }) => {
        const hash = documentHash(original);
        requireHash(bundle?.expectedHash, hash);
        const plan = planChanges(document, bundle, {
          sourceSnapshot: _analysisState
            ? analysis.snapshotFromAnalysis(_analysisState)
            : undefined,
        });
        const analysisReport = _analysisState
          ? analysis.guardAnalysis(_analysisState, plan, bundle, { allowPartialAnalysis })
          : undefined;
        for (const op of bundle.operations.filter((item) => item.op === 'feature.complete')) {
          const hasReceipts = op.implementation?.checks?.some(
            (check) => check.executionId !== undefined,
          );
          if (!requireVerification && !hasReceipts) continue;
          if (!_analysisState)
            throw new BlueprintError('INVALID_ARGUMENT', '验收执行记录需要分析会话。');
          const gaps = verification.checkVerification(
            resolved,
            plan.document.features[op.id],
            plan.document.features[op.id].implementation,
            _analysisState,
            analysisSession,
            { required: requireVerification },
          );
          if (gaps.length)
            throw new BlueprintError('VERIFICATION_FAILED', '验收执行记录检查未通过，未保存。', {
              details: gaps,
            });
        }
        if (plan.changed) {
          for (const key of Object.keys(document)) delete document[key];
          Object.defineProperties(document, Object.getOwnPropertyDescriptors(plan.document));
        }
        const { document: candidate, ...result } = plan;
        return {
          changed: plan.changed,
          result: {
            ...result,
            documentHash: plan.changed ? documentHash(serialized(candidate)) : hash,
            dryRun: false,
            documentSaved: true,
            htmlUpdated: false,
            ...(analysisReport ? { analysis: analysisReport } : {}),
            ...(render ? { html } : {}),
          },
        };
      },
      {
        ...(_analysisState ? { beforeCommit: () => analysis.assertFresh(_analysisState) } : {}),
        afterCommit(document, result) {
          if (!render) return;
          try {
            writeHtml(html, renderDocument(document));
            result.htmlUpdated = true;
          } catch (error) {
            throw new BlueprintError(
              'RENDER_FAILED',
              `文档已保存，但 HTML 更新失败：${error.message}。可运行 render 重试。`,
              { status: 500, documentSaved: true, htmlUpdated: false, result },
            );
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DocumentConflictError)
      throw new BlueprintError('CONFLICT', error.message, { status: 409 });
    if (error instanceof SyntaxError)
      throw new BlueprintError('VALIDATION_FAILED', '项目文档不是有效 JSON。');
    throw error;
  }
}

export async function renderSnapshot(filename, { output } = {}) {
  const resolved = path.resolve(filename);
  const html = path.resolve(output ?? path.join(path.dirname(resolved), 'index.html'));
  const canonical = assertHtmlOutput(resolved, html);
  try {
    return await updateDocument(
      canonical,
      (document, { original }) => {
        checkedDocument(document);
        return {
          changed: false,
          result: {
            documentHash: documentHash(original),
            html,
            featureCount: Object.keys(document.features).length,
            documentSaved: false,
            htmlUpdated: false,
          },
        };
      },
      {
        afterCommit(document, result) {
          try {
            writeHtml(html, renderDocument(document));
            result.htmlUpdated = true;
          } catch (error) {
            throw new BlueprintError('RENDER_FAILED', `HTML 生成失败：${error.message}`, {
              status: 500,
              documentSaved: false,
              htmlUpdated: false,
            });
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DocumentConflictError)
      throw new BlueprintError('CONFLICT', error.message, { status: 409 });
    if (error instanceof SyntaxError)
      throw new BlueprintError('VALIDATION_FAILED', '项目文档不是有效 JSON。');
    throw error;
  }
}
