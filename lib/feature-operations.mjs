import { isDeepStrictEqual } from 'node:util';
import { validateDocument } from './validation.mjs';
import { BlueprintError } from './errors.mjs';

export const businessFields = [
  'description',
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
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVersion = (value) => Number.isSafeInteger(value) && value >= 0;
const validName = (value) => typeof value === 'string' && value.trim() && value.trim().length <= 80;
const validGroup = (value) =>
  Array.isArray(value) &&
  value.length <= 5 &&
  value.every(
    (part) =>
      typeof part === 'string' && part.trim() && part.trim().length <= 40 && !/[\/／>]/.test(part),
  );

function requireId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    throw new BlueprintError('INVALID_ARGUMENT', '功能编号无效。');
}

function requireDocument(document, { status, message }) {
  const report = validateDocument(document);
  if (!report.valid)
    throw new BlueprintError('VALIDATION_FAILED', message, { status, details: report.errors });
}

export function createFeature(id, fields, { page = false } = {}) {
  requireId(id);
  if (!object(fields)) throw new BlueprintError('INVALID_ARGUMENT', '功能内容应为对象。');
  const input = page
    ? { title: fields.title, description: fields.description, groupPath: fields.groupPath ?? [] }
    : { ...fields };
  if (!validName(input.title))
    throw new BlueprintError('INVALID_ARGUMENT', '请填写 1–80 字的功能名称。');
  if (
    typeof input.description !== 'string' ||
    !input.description.trim() ||
    input.description.length > 5000
  )
    throw new BlueprintError('INVALID_ARGUMENT', '请填写 1–5000 字的功能定义。');
  if (input.groupPath !== undefined && !validGroup(input.groupPath))
    throw new BlueprintError('INVALID_ARGUMENT', '分组最多 5 层，每层名称为 1–40 字。');
  // 初始版本及实现记录始终由工具建立，不能接受调用者的完成声明。
  for (const field of [
    'revision',
    'editRevision',
    'flowRevision',
    'implementedRevision',
    'implementation',
    'isNew',
    'updatedAt',
  ])
    delete input[field];
  return {
    rules: [],
    flow: [],
    stepDetails: [],
    dependencies: [],
    actors: [],
    checks: [],
    impact: [],
    overview: '',
    ...input,
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    groupPath: input.groupPath?.map((part) => part.trim()) ?? [],
    revision: 1,
    editRevision: 1,
    flowRevision: 0,
    implementedRevision: null,
    ...(page ? { isNew: true } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function finalizeFeature(previous, candidate, { forceRevision = false, unset = [] } = {}) {
  if (!object(previous) || !object(candidate))
    throw new BlueprintError('INVALID_ARGUMENT', '功能内容应为对象。');
  requireId(previous.id);
  if (candidate.id !== undefined && candidate.id !== previous.id)
    throw new BlueprintError('INVALID_ARGUMENT', '已有功能的编号不能修改。');
  if (
    !Array.isArray(unset) ||
    unset.some(
      (field) =>
        !['overview', 'notes', 'actors', 'checks', 'impact', 'sequence', 'dataflow'].includes(
          field,
        ),
    )
  )
    throw new BlueprintError('INVALID_ARGUMENT', '只能明确移除可选的业务说明或图表。');
  const editRevision = previous.editRevision ?? 0;
  if (!validVersion(previous.revision) || !validVersion(editRevision))
    throw new BlueprintError('VALIDATION_FAILED', '文档版本无效，未保存。');
  const feature = {
    ...previous,
    ...candidate,
    id: previous.id,
    revision: previous.revision,
    ...(previous.editRevision === undefined ? {} : { editRevision }),
  };
  // 传入的保存版本和时间不影响变更判断，也不能绕过共享版本规则。
  delete feature.editRevision;
  if (previous.editRevision !== undefined) feature.editRevision = editRevision;
  if (previous.updatedAt === undefined) delete feature.updatedAt;
  else feature.updatedAt = previous.updatedAt;
  for (const field of unset) delete feature[field];
  const definitionChanged =
    forceRevision ||
    businessFields.some((field) => !isDeepStrictEqual(previous[field], feature[field]));
  const changed = definitionChanged || !isDeepStrictEqual(previous, feature);
  if (!changed) return { changed: false, feature: previous };
  if (
    !Number.isSafeInteger(editRevision + 1) ||
    (definitionChanged && !Number.isSafeInteger(previous.revision + 1))
  )
    throw new BlueprintError('CONFLICT', '文档版本已达到上限，未保存。', { status: 409 });
  feature.revision = previous.revision + (definitionChanged ? 1 : 0);
  feature.editRevision = editRevision + 1;
  feature.updatedAt = new Date().toISOString();
  return { changed: true, feature };
}

export function savePageFeature(body) {
  requireId(body.id);
  return (document) => {
    requireDocument(document, { status: 500, message: '项目文档校验失败，未保存。' });
    const previous = Object.hasOwn(document.features, body.id)
      ? document.features[body.id]
      : undefined;
    const description = body.description.trim();
    const groupPath = body.groupPath?.map((part) => part.trim()) ?? previous?.groupPath ?? [];
    if (body.create) {
      if (previous) {
        if (
          previous.isNew &&
          previous.revision === 1 &&
          previous.title === body.context.title.trim() &&
          previous.description === description &&
          isDeepStrictEqual(previous.groupPath || [], groupPath)
        )
          return { changed: false, result: previous };
        throw new BlueprintError('CONFLICT', '这个功能已存在，请刷新查看。', { status: 409 });
      }
      if (
        body.expectedRevision !== 0 ||
        (body.expectedEditRevision !== undefined && body.expectedEditRevision !== 0)
      )
        throw new BlueprintError('CONFLICT', '新功能的初始版本应为 0，请刷新后重试。', {
          status: 409,
        });
      document.features[body.id] = createFeature(
        body.id,
        { title: body.context.title, description, groupPath },
        { page: true },
      );
    } else {
      if (!previous)
        throw new BlueprintError(
          'NOT_FOUND',
          '这个功能已不存在，请刷新查看。输入内容仍保留在页面。',
          { status: 404 },
        );
      const editRevision = previous.editRevision ?? 0;
      if (
        previous.revision !== body.expectedRevision ||
        (body.expectedEditRevision === undefined
          ? editRevision !== 0
          : editRevision !== body.expectedEditRevision)
      )
        throw new BlueprintError('CONFLICT', '文档已更新，请刷新后再保存。输入内容仍保留在页面。', {
          status: 409,
        });
      const update = finalizeFeature(previous, {
        title: body.title?.trim() ?? previous.title,
        description,
        groupPath,
      });
      if (!update.changed) return { changed: false, result: previous };
      document.features[body.id] = update.feature;
    }
    requireDocument(document, { status: 400, message: '文档内容不完整，未保存。' });
    return { changed: true, result: document.features[body.id] };
  };
}

export function savePageAnnotation(body) {
  requireId(body.id);
  if (
    typeof body.annotationId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(body.annotationId) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    body.text.length > 5000 ||
    !validVersion(body.expectedRevision) ||
    !validVersion(body.expectedEditRevision)
  )
    throw new BlueprintError('INVALID_ARGUMENT', '请填写 1–5000 字的批注并携带有效版本。', {
      status: 400,
    });
  return (document) => {
    requireDocument(document, { status: 500, message: '项目文档校验失败，未保存批注。' });
    const previous = Object.hasOwn(document.features, body.id) ? document.features[body.id] : null;
    if (!previous)
      throw new BlueprintError('NOT_FOUND', '功能已不存在，请刷新后重试。', { status: 404 });
    const annotations = previous.annotations ?? [];
    const existing = annotations.find((item) => item.id === body.annotationId);
    if (existing) {
      if (
        existing.text === body.text.trim() &&
        existing.definitionRevision === body.expectedRevision
      )
        return { changed: false, result: previous };
      throw new BlueprintError('CONFLICT', '批注编号已存在，输入内容仍保留。', { status: 409 });
    }
    if (
      previous.revision !== body.expectedRevision ||
      (previous.editRevision ?? 0) !== body.expectedEditRevision
    )
      throw new BlueprintError('CONFLICT', '文档已更新，请刷新后保存批注。输入内容仍保留。', {
        status: 409,
      });
    const annotation = {
      id: body.annotationId,
      text: body.text.trim(),
      createdAt: new Date().toISOString(),
      definitionRevision: previous.revision,
    };
    document.features[body.id] = finalizeFeature(previous, {
      annotations: [...annotations, annotation],
    }).feature;
    requireDocument(document, { status: 400, message: '批注内容无效，未保存。' });
    return { changed: true, result: document.features[body.id] };
  };
}

export function changePageAnnotation(body, { remove = false } = {}) {
  requireId(body.id);
  requireId(body.annotationId);
  if (
    !validVersion(body.expectedRevision) ||
    !validVersion(body.expectedEditRevision) ||
    (!remove && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 5000))
  )
    throw new BlueprintError('INVALID_ARGUMENT', '批注内容或保存版本无效，未保存。', {
      status: 400,
    });
  return (document) => {
    requireDocument(document, { status: 500, message: '项目文档校验失败，未修改批注。' });
    const previous = Object.hasOwn(document.features, body.id) ? document.features[body.id] : null;
    if (!previous)
      throw new BlueprintError('NOT_FOUND', '功能已不存在，请刷新后重试。', { status: 404 });
    const annotations = previous.annotations ?? [];
    const index = annotations.findIndex((item) => item.id === body.annotationId);
    if (index < 0)
      throw new BlueprintError('NOT_FOUND', '批注已不存在，请刷新后重试。', { status: 404 });
    if (
      previous.revision !== body.expectedRevision ||
      (previous.editRevision ?? 0) !== body.expectedEditRevision
    )
      throw new BlueprintError('CONFLICT', '文档已更新，请刷新后重试。批注输入仍保留。', {
        status: 409,
      });
    if (!remove && annotations[index].text === body.text.trim())
      return { changed: false, result: previous };
    const updated = [...annotations];
    if (remove) updated.splice(index, 1);
    else
      updated[index] = {
        ...annotations[index],
        text: body.text.trim(),
        definitionRevision: previous.revision,
        updatedAt: new Date().toISOString(),
      };
    document.features[body.id] = finalizeFeature(previous, { annotations: updated }).feature;
    requireDocument(document, { status: 400, message: '批注内容无效，未保存。' });
    return { changed: true, result: document.features[body.id] };
  };
}
