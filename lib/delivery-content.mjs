const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && Boolean(value.trim());
const strings = (values) => Array.isArray(values) && values.length > 0 && values.every(text);

// Structural coverage, not a semantic judgment of the AI's explanations or test assertions.
export function checkDeliveryContent(document, review, { limitedSteps = {} } = {}) {
  const gaps = [];
  const add = (path, message) => gaps.push({ path, kind: 'content', message });
  const stepExists = (feature, step) =>
    Number.isSafeInteger(step) && step >= 0 && step < (feature?.flow?.length ?? 0);
  if (!Array.isArray(review.journeys) || !review.journeys.length)
    add('/review/journeys', '需要从用户入口到业务结果的核心旅程及其功能步骤映射。');
  else
    review.journeys.forEach((journey, index) => {
      const where = `/review/journeys/${index}`;
      if (
        !object(journey) ||
        !text(journey.title) ||
        !text(journey.outcome) ||
        !text(journey.evidence) ||
        !Array.isArray(journey.steps) ||
        !journey.steps.length
      )
        return add(where, '旅程需要名称、业务结果、项目材料依据和有序步骤。');
      for (const mapping of journey.steps)
        if (
          !object(mapping) ||
          typeof mapping.featureId !== 'string' ||
          !Object.hasOwn(document.features, mapping.featureId) ||
          !stepExists(document.features[mapping.featureId], mapping.step)
        )
          add(`${where}/steps`, '旅程引用了不存在的功能或步骤（步骤序号从 0 开始）。');
    });
  for (const item of review.features ?? []) {
    if (!object(item) || typeof item.id !== 'string' || !Object.hasOwn(document.features, item.id))
      continue;
    const feature = document.features[item?.id];
    if (!feature) continue;
    const where = `/features/${item.id}`;
    const details = feature.stepDetails ?? [];
    const decision = (present, value, path) => {
      if (!object(value)) return add(path, '缺少内容适用性判断。');
      if (present) {
        if (value.decision !== 'included') add(path, '已有内容必须作为 included 审阅。');
      } else if (value.decision !== 'skipped' || !text(value.reason))
        add(path, '内容为空时须说明具体不适用或缺少依据的原因。');
    };
    decision(
      strings(feature.rules) || details.some((detail) => strings(detail.rules)),
      item.content?.rules,
      `${where}/rules`,
    );
    decision(
      feature.dependencies.length > 0 || details.some((detail) => detail.dependencies.length),
      item.content?.dependencies,
      `${where}/dependencies`,
    );
    for (const id of feature.dependencies)
      if (!details.some((detail) => detail.dependencies.includes(id)))
        add(`${where}/dependencies`, `依赖 ${id} 未关联实际使用它的业务步骤。`);
    if (
      strings(feature.rules) &&
      details.length &&
      !details.some((detail) => strings(detail.rules))
    )
      add(`${where}/stepDetails`, '业务规则尚未关联到受其约束的步骤。');
    if (text(feature.sequence?.failure) && !feature.sequence.error?.length)
      add(`${where}/sequence/error`, '已有失败情形名称，但缺少实际异常交互分支。');
    // A skip justified by another diagram must point to a diagram that actually exists.
    for (const kind of ['sequence', 'dataflow']) {
      const alternative = item.diagrams?.[kind]?.alternative;
      if (!alternative) continue;
      if (
        !object(alternative) ||
        typeof alternative.diagram !== 'string' ||
        (alternative.featureId !== undefined && typeof alternative.featureId !== 'string')
      ) {
        add(`${where}/${kind}`, '替代图表引用需要有效的 diagram 及可选 featureId。');
        continue;
      }
      const source = alternative.featureId
        ? document.features[alternative.featureId]
        : document.diagrams;
      const model = source?.[alternative.diagram];
      const present =
        model?.nodes?.length ||
        (model?.roles?.length && (model.base?.length || model.normal?.length));
      if (!present || (alternative.featureId === item.id && alternative.diagram === kind))
        add(`${where}/${kind}`, '跳过理由引用的替代图表不存在或引用自身。');
    }
    if (item.outcome === 'implemented' && !strings(feature.checks))
      add(`${where}/checks`, '完成功能需要明确的业务验收条件，不能只填写命令名称。');
    if (!Array.isArray(item.acceptance)) {
      add(`${where}/acceptance`, '验收映射必须为数组；未验收的草稿使用空数组。');
      continue;
    }
    if (item.outcome !== 'implemented') continue;
    if (!item.acceptance.length) {
      add(
        `${where}/acceptance`,
        '需要将验收条件、步骤及正常／异常路径关联到实际执行记录和检查依据。',
      );
      continue;
    }
    const coverage = [];
    const executions = new Set(feature.implementation?.checks?.map((check) => check.executionId));
    for (const entry of item.acceptance) {
      if (
        !object(entry) ||
        !Number.isSafeInteger(entry.criterion) ||
        entry.criterion < 0 ||
        entry.criterion >= (feature.checks?.length ?? 0) ||
        !['normal', 'exception'].includes(entry.scenario) ||
        !text(entry.executionId) ||
        !executions.has(entry.executionId) ||
        !text(entry.evidence) ||
        !Array.isArray(entry.steps) ||
        !entry.steps.length ||
        entry.steps.some((step) => !stepExists(feature, step))
      ) {
        add(
          `${where}/acceptance`,
          '验收映射须引用当前功能的条件、步骤及已验证 executionId，并说明具体测试或交互检查。',
        );
        continue;
      }
      coverage.push(entry);
    }
    for (let index = 0; index < (feature.checks?.length ?? 0); index++)
      if (!coverage.some((entry) => entry.criterion === index))
        add(`${where}/checks/${index}`, '验收条件未关联实际检查。');
    const normalSteps = new Set(
      [...(feature.sequence?.base ?? []), ...(feature.sequence?.normal ?? [])].map(
        (message) => message[3],
      ),
    );
    const errorSteps = new Set((feature.sequence?.error ?? []).map((message) => message[3]));
    details.forEach((detail, index) => {
      // A supported limitation is reported as unverified, never as invented acceptance.
      if (limitedSteps[item.id]?.includes(index)) return;
      const errorOnly = errorSteps.has(index) && !normalSteps.has(index);
      if (
        !errorOnly &&
        !coverage.some((entry) => entry.scenario === 'normal' && entry.steps.includes(index))
      )
        add(`${where}/stepDetails/${index}`, '步骤的正常路径未关联实际验收。');
      if (
        (errorSteps.has(index) || text(detail.exception)) &&
        !coverage.some((entry) => entry.scenario === 'exception' && entry.steps.includes(index))
      )
        add(`${where}/stepDetails/${index}/exception`, '已定义的异常路径未关联实际验收。');
    });
  }
  return gaps;
}
