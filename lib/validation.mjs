import { validSourceSnapshot } from './source-status.mjs';

const featureId = /^[a-z][a-z0-9-]{0,63}$/;
const graphId = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const stringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const timestampPattern =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function timestamp(value) {
  if (typeof value !== 'string') return false;
  const parts = timestampPattern.exec(value);
  if (!parts || Number.isNaN(Date.parse(value))) return false;
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function validateDocument(document) {
  const errors = [];
  const error = (where, message) => errors.push({ path: where, message });
  const optionalText = (record, fields, where) => {
    for (const field of fields)
      if (record[field] !== undefined && typeof record[field] !== 'string')
        error(`${where}/${field}`, '说明应为文字。');
  };
  const optionalTexts = (record, fields, where) => {
    for (const field of fields)
      if (record[field] !== undefined && !stringArray(record[field]))
        error(`${where}/${field}`, '说明应为文字数组。');
  };
  const implementationRecord = (implementation, recordPath, maximumRevision) => {
    if (!object(implementation)) error(recordPath, '实现记录应为对象。');
    else {
      if (!revision(implementation.revision) || implementation.revision > maximumRevision)
        error(`${recordPath}/revision`, '实现记录版本应为非负安全整数，且不能超过定义版本。');
      if (!timestamp(implementation.verifiedAt))
        error(
          `${recordPath}/verifiedAt`,
          '验证时间应为包含时区的有效日期时间，例如 2026-10-13T00:00:00Z。',
        );
      if (
        !Array.isArray(implementation.checks) ||
        !implementation.checks.length ||
        implementation.checks.some(
          (check) =>
            !object(check) ||
            !text(check.name) ||
            check.result !== 'passed' ||
            (check.executionId !== undefined &&
              (typeof check.executionId !== 'string' ||
                !/^v-[a-f0-9-]{36}$/.test(check.executionId))),
        )
      )
        error(`${recordPath}/checks`, '实现记录必须包含实际通过的检查。');
      optionalText(implementation, ['commit'], recordPath);
      if (
        implementation.sourceSnapshot !== undefined &&
        !validSourceSnapshot(implementation.sourceSnapshot)
      )
        error(`${recordPath}/sourceSnapshot`, '源码快照需要有效范围、文件清单和一致的内容指纹。');
    }
  };
  const assessmentRecord = (record, where, maximumRevision) => {
    if (
      !object(record) ||
      !revision(record.revision) ||
      record.revision > maximumRevision ||
      !/^[a-f0-9]{64}$/.test(record.definitionHash || '') ||
      !timestamp(record.assessedAt) ||
      !validSourceSnapshot(record.sourceSnapshot) ||
      !Array.isArray(record.items) ||
      !record.items.length
    ) {
      error(where, '实现核对需要有效版本、定义指纹、时间、源码基线和逐项结论。');
      return;
    }
    const seen = new Set();
    for (const item of record.items) {
      if (
        !object(item) ||
        !/^\/(description|(?:rules|checks|flow)\/[0-9]+)$/.test(item.target || '') ||
        seen.has(item.target) ||
        !['implemented', 'missing', 'unknown'].includes(item.state) ||
        !text(item.detail) ||
        ![item.unitIds || [], item.contextIds || []].every(stringArray) ||
        (item.state !== 'unknown' &&
          !(item.unitIds?.length || item.contextIds?.length || item.requirement)) ||
        (item.requirement !== undefined &&
          (item.state !== 'missing' ||
            !object(item.requirement) ||
            !['user', 'document'].includes(item.requirement.source) ||
            !text(item.requirement.text)))
      )
        error(where, '实现核对项需要不重复的业务位置、具体结论、说明及来源。');
      seen.add(item?.target);
    }
  };
  if (!object(document))
    return {
      valid: false,
      featureCount: 0,
      dependencyCount: 0,
      errors: [{ path: '/', message: '文档必须是 JSON 对象。' }],
    };
  if (document.schemaVersion !== 1) error('/schemaVersion', '当前仅支持文档版本 1。');
  if (!object(document.product) || !text(document.product.name))
    error('/product/name', '请填写产品名称。');
  if (object(document.product))
    optionalText(document.product, ['background', 'repository'], '/product');
  if (document.product?.actors !== undefined && !stringArray(document.product.actors))
    error('/product/actors', '使用者应为文字数组。');
  if (!object(document.features)) error('/features', '功能应按稳定编号保存为对象。');
  if (!Array.isArray(document.dependencies)) error('/dependencies', '依赖应为数组。');
  const dependencies = Array.isArray(document.dependencies) ? document.dependencies : [];
  const ids = new Set();
  const features = object(document.features) ? document.features : {};
  dependencies.forEach((dependency, index) => {
    const where = `/dependencies/${index}`;
    if (
      !object(dependency) ||
      typeof dependency.id !== 'string' ||
      !featureId.test(dependency.id)
    ) {
      error(where, '依赖需要有效的稳定编号。');
      return;
    }
    if (ids.has(dependency.id)) error(`${where}/id`, '依赖编号重复。');
    ids.add(dependency.id);
    if (!text(dependency.name)) error(`${where}/name`, '请填写依赖名称。');
    optionalText(
      dependency,
      ['category', 'purpose', 'description', 'responsibility', 'failure'],
      where,
    );
    optionalTexts(dependency, ['openQuestions'], where);
    if (dependency.relations !== undefined) {
      if (!stringArray(dependency.relations)) error(`${where}/relations`, '关联功能应为编号数组。');
      else
        for (const id of dependency.relations)
          if (!Object.hasOwn(features, id)) error(`${where}/relations`, `关联的功能不存在：${id}`);
    }
  });
  const references = (values, where) => {
    if (!stringArray(values)) {
      error(where, '依赖引用应为编号数组。');
      return;
    }
    for (const id of values) if (!ids.has(id)) error(where, `依赖不存在：${id}`);
  };
  const graph = (model, where) => {
    if (!object(model) || !Array.isArray(model.nodes) || !Array.isArray(model.edges)) {
      error(where, '图表需要 nodes 和 edges 数组。');
      return;
    }
    if (!text(model.title)) error(`${where}/title`, '图表需要名称。');
    const nodes = new Set();
    model.nodes.forEach((node, index) => {
      if (
        !object(node) ||
        typeof node.id !== 'string' ||
        !graphId.test(node.id) ||
        !text(node.title)
      ) {
        error(`${where}/nodes/${index}`, '节点需要有效编号和名称。');
        return;
      }
      if (nodes.has(node.id)) error(`${where}/nodes/${index}/id`, '节点编号重复。');
      nodes.add(node.id);
      optionalText(node, ['type', 'kind', 'subtitle', 'description'], `${where}/nodes/${index}`);
      if (node.rules !== undefined && !stringArray(node.rules))
        error(`${where}/nodes/${index}/rules`, '节点规则应为文字数组。');
      if (node.fields !== undefined && !stringArray(node.fields))
        error(`${where}/nodes/${index}/fields`, '字段应为文字数组。');
      if (node.dependencies !== undefined)
        references(node.dependencies, `${where}/nodes/${index}/dependencies`);
      if (node.dependency !== undefined)
        references([node.dependency], `${where}/nodes/${index}/dependency`);
    });
    model.edges.forEach((edge, index) => {
      if (!object(edge) || !nodes.has(edge.from) || !nodes.has(edge.to))
        error(`${where}/edges/${index}`, '关系引用了不存在的节点。');
      if (edge?.label !== undefined && typeof edge.label !== 'string')
        error(`${where}/edges/${index}/label`, '关系含义应为文字。');
      for (const field of ['dashed', 'relation'])
        if (edge?.[field] !== undefined && typeof edge[field] !== 'boolean')
          error(`${where}/edges/${index}/${field}`, '关系标记应为布尔值。');
    });
  };
  for (const [id, feature] of Object.entries(features)) {
    const where = `/features/${id}`;
    if (!featureId.test(id) || !object(feature) || feature.id !== id) {
      error(where, '功能编号需要有效，并与对象的键保持一致。');
      continue;
    }
    if (!text(feature.title) || feature.title.length > 80)
      error(`${where}/title`, '功能名称为 1–80 字。');
    if (!text(feature.description) || feature.description.length > 5000)
      error(`${where}/description`, '功能定义为 1–5000 字。');
    optionalText(feature, ['overview', 'notes'], where);
    optionalTexts(feature, ['actors', 'checks', 'impact'], where);
    if (!stringArray(feature.rules)) error(`${where}/rules`, '业务规则应为文字数组。');
    references(feature.dependencies, `${where}/dependencies`);
    if (
      !Array.isArray(feature.groupPath) ||
      feature.groupPath.length > 5 ||
      feature.groupPath.some((part) => !text(part) || part.length > 40 || /[\/／>]/.test(part))
    )
      error(`${where}/groupPath`, '分组最多 5 层，每层为 1–40 字。');
    if (!revision(feature.revision)) error(`${where}/revision`, '定义版本应为非负安全整数。');
    if (feature.editRevision !== undefined && !revision(feature.editRevision))
      error(`${where}/editRevision`, '编辑版本应为非负安全整数。');
    if (!revision(feature.flowRevision) || feature.flowRevision > feature.revision)
      error(`${where}/flowRevision`, '图表版本应为非负安全整数，且不能超过定义版本。');
    if (feature.implementedRevision !== null) {
      if (!revision(feature.implementedRevision) || feature.implementedRevision > feature.revision)
        error(
          `${where}/implementedRevision`,
          '完成版本应为非负安全整数，且不能超过定义版本；未完成应为 null。',
        );
      if (
        !object(feature.implementation) ||
        feature.implementation.revision !== feature.implementedRevision
      )
        error(`${where}/implementation`, '完成记录必须对应完成版本。');
      if (
        feature.implementedRevision === feature.revision &&
        (feature.flowRevision !== feature.revision ||
          !Array.isArray(feature.flow) ||
          !feature.flow.length)
      )
        error(`${where}/flowRevision`, '完成功能的业务流程必须非空并同步至当前定义版本。');
    }
    if (feature.implementation !== undefined)
      implementationRecord(feature.implementation, `${where}/implementation`, feature.revision);
    if (feature.implementationHistory !== undefined) {
      if (!Array.isArray(feature.implementationHistory))
        error(`${where}/implementationHistory`, '验收历史应为记录数组。');
      else
        feature.implementationHistory.forEach((record, index) =>
          implementationRecord(record, `${where}/implementationHistory/${index}`, feature.revision),
        );
    }
    if (feature.implementationAssessment !== undefined)
      assessmentRecord(
        feature.implementationAssessment,
        `${where}/implementationAssessment`,
        feature.revision,
      );
    if (feature.implementationAssessmentHistory !== undefined) {
      if (!Array.isArray(feature.implementationAssessmentHistory))
        error(`${where}/implementationAssessmentHistory`, '实现核对历史应为数组。');
      else
        feature.implementationAssessmentHistory.forEach((record, index) =>
          assessmentRecord(
            record,
            `${where}/implementationAssessmentHistory/${index}`,
            feature.revision,
          ),
        );
    }
    if (
      !Array.isArray(feature.flow) ||
      feature.flow.some(
        (step) =>
          !Array.isArray(step) || step.length < 2 || !text(step[0]) || typeof step[1] !== 'string',
      )
    )
      error(`${where}/flow`, '流程步骤需要名称和说明。');
    if (!Array.isArray(feature.stepDetails) || feature.stepDetails.length !== feature.flow?.length)
      error(`${where}/stepDetails`, '步骤详情需要与流程步骤逐一对应。');
    else
      feature.stepDetails.forEach((detail, index) => {
        if (!object(detail)) {
          error(`${where}/stepDetails/${index}`, '步骤详情应为对象。');
          return;
        }
        for (const field of ['actor', 'description', 'result', 'exception', 'acceptance'])
          if (typeof detail[field] !== 'string')
            error(`${where}/stepDetails/${index}/${field}`, '步骤说明应为文字，待补充时可留空。');
        if (!stringArray(detail.rules))
          error(`${where}/stepDetails/${index}/rules`, '规则应为文字数组。');
        references(detail.dependencies, `${where}/stepDetails/${index}/dependencies`);
        if (
          detail.dependenciesPending !== undefined &&
          typeof detail.dependenciesPending !== 'boolean'
        )
          error(`${where}/stepDetails/${index}/dependenciesPending`, '待确认标记应为布尔值。');
        if (
          !Array.isArray(detail.interactions) ||
          detail.interactions.some(
            (message) =>
              !Array.isArray(message) ||
              message.length !== 3 ||
              message.some((value) => typeof value !== 'string'),
          )
        )
          error(`${where}/stepDetails/${index}/interactions`, '交互应记录发送者、接收者和行为。');
      });
    if (feature.annotations !== undefined) {
      if (!Array.isArray(feature.annotations)) error(`${where}/annotations`, '批注应为数组。');
      else {
        const annotationIds = new Set();
        feature.annotations.forEach((annotation, index) => {
          const position = `${where}/annotations/${index}`;
          if (
            !object(annotation) ||
            !featureId.test(annotation.id ?? '') ||
            annotationIds.has(annotation.id) ||
            !text(annotation.text) ||
            annotation.text.length > 5000 ||
            !timestamp(annotation.createdAt) ||
            (annotation.updatedAt !== undefined && !timestamp(annotation.updatedAt)) ||
            !revision(annotation.definitionRevision) ||
            annotation.definitionRevision > feature.revision
          )
            error(position, '批注需要唯一编号、1–5000 字的内容、有效时间及对应的定义版本。');
          else annotationIds.add(annotation.id);
        });
      }
    }
    if (feature.sequence !== undefined) {
      const sequence = feature.sequence;
      if (
        !object(sequence) ||
        !stringArray(sequence.roles) ||
        !sequence.roles.length ||
        sequence.roles.some((role) => !text(role))
      )
        error(`${where}/sequence`, '时序图需要参与者。');
      else {
        optionalText(sequence, ['success', 'failure'], `${where}/sequence`);
        for (const key of ['base', 'normal', 'error']) {
          if (key === 'error' && sequence[key] === undefined) continue;
          if (!Array.isArray(sequence[key])) {
            error(`${where}/sequence/${key}`, '时序消息应为数组。');
            continue;
          }
          sequence[key].forEach((message, index) => {
            if (
              !Array.isArray(message) ||
              message.length < 4 ||
              message.length > 5 ||
              ![message[0], message[1]].every(
                (value) => revision(value) && value < sequence.roles.length,
              ) ||
              !text(message[2]) ||
              !revision(message[3]) ||
              message[3] >= feature.flow?.length ||
              (message.length === 5 && !['return', 'error'].includes(message[4]))
            )
              error(`${where}/sequence/${key}/${index}`, '消息的参与者、所属步骤或返回标记无效。');
          });
        }
      }
    }
    if (feature.dataflow !== undefined) graph(feature.dataflow, `${where}/dataflow`);
  }
  if (document.diagrams !== undefined) {
    if (!object(document.diagrams)) error('/diagrams', '项目图表应为对象。');
    else
      for (const key of ['architecture', 'entities'])
        if (document.diagrams[key] !== undefined) graph(document.diagrams[key], `/diagrams/${key}`);
  }
  return {
    valid: errors.length === 0,
    featureCount: Object.keys(features).length,
    dependencyCount: dependencies.length,
    errors,
  };
}
