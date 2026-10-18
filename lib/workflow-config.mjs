import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './analysis-facts.mjs';
import { BlueprintError } from './errors.mjs';
import { withFileLock } from './file-lock.mjs';

export const workflowConfigName = '.blueprint-workflow.json';
export const initStages = ['discover', 'analyze', 'compose'];
const skillNames = ['init', 'verify', 'implement'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
const fields = (v, keys, label) => {
  if (!object(v) || Object.keys(v).some((k) => !keys.includes(k))) invalid(`${label} 含无效字段。`);
};

export function normalizeWorkflowConfig(input) {
  fields(input, ['version', 'skills'], '工作流配置');
  if (input.version !== undefined && input.version !== 1) invalid('工作流配置需要 version:1。');
  fields(input.skills, skillNames, 'skills');
  const skills = {};
  for (const name of skillNames) {
    const value = input.skills[name];
    fields(value, name === 'init' ? ['enabled', 'stages'] : ['enabled'], name);
    if (typeof value.enabled !== 'boolean') invalid(`${name}.enabled 必须是布尔值。`);
    skills[name] = { enabled: value.enabled };
    if (name === 'init') {
      const stages = value.stages ?? initStages;
      if (
        !Array.isArray(stages) ||
        stages.some((s) => !initStages.includes(s)) ||
        new Set(stages).size !== stages.length ||
        (value.enabled && !stages.length)
      )
        invalid('init.stages 使用不重复的 discover/analyze/compose；启用时至少选择一项。');
      skills[name].stages = initStages.filter((s) => stages.includes(s));
    }
  }
  return { version: 1, skills };
}

function projectRoot(project) {
  const root = fs.realpathSync(path.resolve(project));
  if (!fs.statSync(root).isDirectory()) invalid('工作流目标需要项目目录。');
  return root;
}

export function getWorkflowConfig(project) {
  const root = projectRoot(project),
    filename = path.join(root, workflowConfigName);
  const configured = fs.existsSync(filename);
  if (configured && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()))
    invalid('工作流配置必须是普通文件，不能是符号链接。');
  let config;
  try {
    config = configured
      ? JSON.parse(fs.readFileSync(filename, 'utf8'))
      : {
          version: 1,
          skills: {
            init: { enabled: true, stages: initStages },
            verify: { enabled: true },
            implement: { enabled: true },
          },
        };
  } catch (error) {
    if (error instanceof SyntaxError) invalid('工作流配置不是有效 JSON；不会退回默认流程。');
    throw error;
  }
  config = normalizeWorkflowConfig(config);
  return {
    root,
    filename,
    configured,
    config,
    configHash: digest(JSON.stringify([root, configured, config])),
  };
}

export async function setWorkflowConfig(project, input, expectedHash) {
  const before = getWorkflowConfig(project),
    config = normalizeWorkflowConfig(input);
  if (typeof expectedHash !== 'string' || !expectedHash)
    invalid('保存配置需要先读取并传入 expected-hash。');
  return withFileLock(before.filename, () => {
    const current = getWorkflowConfig(before.root);
    if (current.configHash !== expectedHash)
      throw new BlueprintError('CONFLICT', '工作流配置已变化，请重新读取后评估。', {
        status: 409,
        expectedHash,
        actualHash: current.configHash,
      });
    const temp = before.filename + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (getWorkflowConfig(before.root).configHash !== expectedHash)
        throw new BlueprintError('CONFLICT', '工作流配置在保存期间变化。', { status: 409 });
      fs.renameSync(temp, before.filename);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return getWorkflowConfig(before.root);
  });
}

export function workflowPlan(project, { skill = 'init', stage } = {}) {
  if (!skillNames.includes(skill)) invalid('skill 使用 init/verify/implement。');
  if (stage !== undefined && (skill !== 'init' || !initStages.includes(stage)))
    invalid('stage 仅用于初始化的 discover/analyze/compose。');
  const current = getWorkflowConfig(project),
    enabled = current.config.skills[skill].enabled;
  const gaps = [];
  if (!enabled)
    gaps.push({ kind: 'disabled', message: `配置已关闭 ${skill}，不会执行或自动开启。` });
  if (skill === 'implement' && !current.config.skills.verify.enabled)
    gaps.push({
      kind: 'dependency',
      message: '实现后的核验已关闭；先明确调整配置，不能跳过核验或开始写代码。',
    });
  const selected = skill === 'init' ? (stage ? [stage] : current.config.skills.init.stages) : [];
  if (stage && !current.config.skills.init.stages.includes(stage))
    gaps.push({ kind: 'disabled', message: `配置未开启 ${stage}。` });
  const full = selected.length === initStages.length;
  // First independent stage. Legacy full workflows remain available; isolated
  // analyze/compose must never silently fall back to an expensive full run.
  if (skill === 'init' && !full && !(selected.length === 1 && selected[0] === 'discover'))
    gaps.push({
      kind: 'unavailable',
      message: '本版本仅 discover 可独立运行；analyze/compose 的独立分片尚未实现，不会改跑全套。',
    });
  return {
    ...current,
    skill,
    valid: gaps.length === 0,
    executionMode:
      skill === 'init' ? (full ? 'legacy-full' : 'discovery-only') : 'selected-features',
    stages: initStages.map((name) => ({
      name,
      selected: skill === 'init' && enabled && selected.includes(name),
      independent: name === 'discover',
    })),
    gaps,
    initializationComplete: false,
    scope:
      '配置控制产品蓝图任务，不是宿主应用 Skill 的安装开关；启用不表示自动执行或授权代码修改。',
  };
}

export function requireWorkflow(project, options) {
  const plan = workflowPlan(project, options);
  if (!plan.valid)
    throw new BlueprintError('WORKFLOW_BLOCKED', plan.gaps.map((g) => g.message).join(' '), {
      details: plan.gaps.map((g) => ({ path: workflowConfigName, ...g })),
    });
  return plan;
}
