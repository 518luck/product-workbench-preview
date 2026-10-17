import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertFresh, loadSession } from './analysis-session.mjs';
import { readSnapshot } from './document-operations.mjs';
import { flowDigest, featureDefinitionHash, primitiveFingerprint } from './flow.mjs';
import { digest } from './analysis-facts.mjs';
import { instrumentJavaScript } from './flow-instrument-javascript.mjs';
import { BlueprintError } from './errors.mjs';
import { runtimeFingerprint } from './flow-protocol.mjs';

const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
function commandInput(input) {
  if (
    !plain(input) ||
    typeof input.command !== 'string' ||
    !input.command.trim() ||
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== 'string')
  )
    invalid('执行输入需要 command 和字符串 args；不经过 shell。');
}
function safeRelative(file) {
  if (
    typeof file !== 'string' ||
    !file ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/).some((part) => ['..', '.git', 'node_modules'].includes(part))
  )
    invalid('夹具必须使用副本内的相对路径，不能访问父目录、Git 或依赖目录。');
  return file;
}
export async function executeCommand(input, cwd, { env = {}, events = false } = {}) {
  commandInput(input);
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    invalid('timeoutMs 应为 1–600000 毫秒。');
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', ...(events ? ['pipe'] : [])],
    });
    const chunks = { stdout: [], stderr: [], events: [] };
    let size = 0,
      eventSize = 0,
      stopped = false,
      timedOut = false,
      outputExceeded = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code === 'EPERM') child.kill('SIGKILL');
        else if (error.code !== 'ESRCH') reject(error);
      }
      for (const stream of child.stdio.filter(Boolean)) stream.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    for (const [index, key] of [[1, 'stdout'], [2, 'stderr'], ...(events ? [[3, 'events']] : [])])
      child.stdio[index].on('data', (chunk) => {
        if (key === 'events') eventSize += chunk.length;
        else size += chunk.length;
        if (size > 1024 * 1024 || eventSize > 16 * 1024 * 1024) {
          outputExceeded = true;
          stop();
        } else chunks[key].push(chunk);
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        outputExceeded,
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
        events: Buffer.concat(chunks.events),
      });
    });
  });
}
export function copyProject(state, destination) {
  const excluded = new Set(['.git', '.blueprint-analysis', '.blueprint', 'releases']);
  fs.cpSync(state.root, destination, {
    recursive: true,
    dereference: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (filename) => {
      const relative = path.relative(state.root, filename);
      return !relative.split(path.sep).some((part) => excluded.has(part));
    },
  });
  for (const item of state.manifest.filter(
    (item) => item.hash && ['source', 'types', 'context', 'unsupported'].includes(item.kind),
  )) {
    const filename = path.join(destination, item.file);
    if (!fs.existsSync(filename) || digest(fs.readFileSync(filename)) !== item.hash)
      throw new BlueprintError('ANALYSIS_STALE', `运行副本与源码快照不一致：${item.file}。`);
  }
}
function validateEvents(events, state, runId) {
  const gaps = [],
    spans = new Map(),
    unitMap = new Map(state.units.map((unit) => [unit.id, unit]));
  const values = new Map(state.facts.values.map((value) => [value.id, value]));
  let last = 0;
  for (const event of events) {
    const unit = unitMap.get(event.unitId);
    if (
      event.runId !== runId ||
      !Number.isSafeInteger(event.seq) ||
      event.seq <= last ||
      !unit ||
      typeof event.traceId !== 'string' ||
      typeof event.spanId !== 'string'
    ) {
      gaps.push('观测的执行、顺序、源码单元或请求编号无效。');
      break;
    }
    last = event.seq;
    if (event.kind === 'enter') {
      if (spans.has(event.spanId)) {
        gaps.push('同一调用编号被重复创建。');
        break;
      }
      if (event.parentSpanId) {
        const parent = spans.get(event.parentSpanId),
          call = unitMap.get(parent?.unitId)?.calls.find((call) => call.id === event.callId);
        if (
          !parent ||
          parent.traceId !== event.traceId ||
          parent.unitId !== event.parentUnitId ||
          (event.callId && (!call || (call.target && call.target !== unit.id)))
        )
          gaps.push('调用观测与当前源码目标或父请求不一致。');
      }
      spans.set(event.spanId, event);
    } else if (!spans.has(event.spanId)) gaps.push('观测缺少对应的函数进入记录。');
    if (event.factId && values.get(event.factId)?.unitId !== unit.id)
      gaps.push('观测数据不属于当前源码单元。');
    if (event.pointId && !unit.reviewPoints.some((point) => point.id === event.pointId))
      gaps.push('观测分支不存在。');
    if (event.kind === 'binding') {
      const from = spans.get(event.sourceSpanId),
        to = spans.get(event.targetSpanId);
      const call = state.units
        .flatMap((unit) => unit.calls)
        .find((call) => call.id === event.callId);
      const source = values.get(event.sourceId),
        target = values.get(event.targetId);
      const argument =
        from &&
        to &&
        to.parentSpanId === from.spanId &&
        to.callId === call?.id &&
        call.argumentIds.includes(event.sourceId) &&
        unitMap.get(to.unitId)?.parameters.includes(event.targetId);
      const returned =
        from &&
        to &&
        from.parentSpanId === to.spanId &&
        from.callId === call?.id &&
        unitMap.get(from.unitId)?.returns.includes(event.sourceId) &&
        call.resultId === event.targetId;
      if (
        !from ||
        !to ||
        from.traceId !== to.traceId ||
        from.traceId !== event.traceId ||
        source?.unitId !== from.unitId ||
        target?.unitId !== to.unitId ||
        !(argument || returned)
      )
        gaps.push('数据绑定没有来自同一次真实调用的参数或返回位置。');
    }
  }
  return [...new Set(gaps)];
}
export async function runFlowVerification(filename, featureId, session, input, observation) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (key) =>
        !['command', 'args', 'timeoutMs', 'flow', 'fixtures', 'setup', 'build', 'browser'].includes(
          key,
        ),
    )
  )
    invalid('流程验收输入字段无效。');
  if (input.browser !== undefined && typeof input.browser !== 'boolean')
    invalid('browser 必须为布尔值。');
  commandInput(input);
  const requestedTimeout = input.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > 600000)
    invalid('timeoutMs 应为 1–600000 毫秒。');
  if (
    !plain(input.flow) ||
    Object.keys(input.flow).some((key) => !['id', 'scenarioId'].includes(key))
  )
    invalid('flow 需要 id 与 scenarioId。');
  const { state, filename: stateFile } = loadSession(session);
  assertFresh(state);
  const snapshot = readSnapshot(filename);
  let flow = state.flows?.[input.flow.id];
  if (observation) {
    const plan = state.verificationPlans?.[observation.planId],
      scenario = plan?.scenarios.find((s) => s.id === observation.scenarioId);
    if (
      !plan ||
      !scenario ||
      plan.recordHash !== observation.recordHash ||
      plan.featureId !== featureId ||
      plan.snapshotHash !== state.snapshotHash
    )
      invalid('组件方案绑定无效。');
    flow = {
      id: input.flow.id,
      documentPath: fs.realpathSync(filename),
      snapshotHash: state.snapshotHash,
      verifierHash: runtimeFingerprint(),
      featureBindings: {
        [featureId]: { revision: plan.revision, definitionHash: plan.definitionHash },
      },
      nodes: plan.steps
        .filter((s) => scenario.steps.includes(s.step))
        .flatMap((s) => (s.unitIds || []).map((unitId) => ({ unitId }))),
      scenarios: [scenario],
    };
    flow.recordHash = flowDigest(flow);
  }
  if (
    !flow ||
    flow.snapshotHash !== state.snapshotHash ||
    flow.verifierHash !== runtimeFingerprint() ||
    flow.documentPath !== fs.realpathSync(filename) ||
    flow.recordHash !== flowDigest(flow) ||
    !flow.scenarios.some((scenario) => scenario.id === input.flow.scenarioId)
  )
    invalid('流程或场景不存在、已过期，或不属于当前产品书。');
  if (!flow.featureBindings[featureId]) invalid('流程没有关联此功能。');
  for (const [id, binding] of Object.entries(flow.featureBindings))
    if (
      !snapshot.document.features[id] ||
      featureDefinitionHash(snapshot.document.features[id]) !== binding.definitionHash ||
      snapshot.document.features[id].revision !== binding.revision
    )
      invalid('功能定义已变化，请先更新流程映射。');
  if (input.fixtures !== undefined && !Array.isArray(input.fixtures))
    invalid('fixtures 必须为数组。');
  if (input.setup !== undefined && !Array.isArray(input.setup)) invalid('setup 必须为命令数组。');
  if (input.build !== undefined && !Array.isArray(input.build)) invalid('build 必须为命令数组。');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'product-blueprint-flow-'));
  const root = path.join(temporary, 'project'),
    id = `v-${randomUUID()}`,
    startedAt = new Date().toISOString();
  const selected = new Set(
    flow.nodes.flatMap((node) => [node.unitId, ...(node.relatedUnitIds || [])]).filter(Boolean),
  );
  // Include resolved callees; unknown dynamic targets are observed only if independently mapped.
  for (const unitId of selected)
    for (const call of state.units.find((unit) => unit.id === unitId)?.calls || [])
      if (call.target) selected.add(call.target);
  let result,
    events = [],
    integrity = [],
    unsupported = [],
    probeHash,
    fixturesHash,
    copyStable = true;
  try {
    copyProject(state, root);
    for (const fixture of input.fixtures || []) {
      if (
        !plain(fixture) ||
        Object.keys(fixture).some((key) => !['file', 'content'].includes(key)) ||
        typeof fixture.content !== 'string'
      )
        invalid('夹具需要 file、content。');
      const destination = path.join(root, safeRelative(fixture.file));
      if (fs.existsSync(destination)) invalid(`夹具不能覆盖副本中的原有文件：${fixture.file}。`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, fixture.content, { flag: 'wx' });
    }
    fixturesHash = digest(JSON.stringify(input.fixtures || []));
    const remapPath = (arg) => {
      let canonical = arg;
      if (path.isAbsolute(arg) && fs.existsSync(arg)) canonical = fs.realpathSync(arg);
      return canonical === state.root || canonical.startsWith(state.root + path.sep)
        ? root + canonical.slice(state.root.length)
        : arg;
    };
    const remap = (command) => ({
      ...command,
      command: remapPath(command.command),
      args: command.args.map(remapPath),
    });
    for (const setup of input.setup || []) {
      commandInput(setup);
      const report = await executeCommand(remap(setup), root);
      if (report.exitCode !== 0 || report.timedOut || report.outputExceeded) {
        result = report;
        integrity.push('运行副本准备命令失败。');
        break;
      }
    }
    // Preparation can create build files; it may never change the copied business snapshot.
    for (const item of state.manifest.filter(
      (item) => item.hash && ['source', 'types', 'context', 'unsupported'].includes(item.kind),
    ))
      if (digest(fs.readFileSync(path.join(root, item.file))) !== item.hash)
        invalid(`准备命令修改了业务源码或上下文：${item.file}。`);
    if (!result) {
      unsupported = instrumentJavaScript(root, state, selected);
      const foreign = [...selected]
        .map((id) => state.units.find((unit) => unit.id === id))
        .filter((unit) => unit && unit.language !== 'javascript');
      if (foreign.length) {
        const { instrumentForeign } = await import('./flow-instrument-foreign.mjs');
        unsupported.push(...(await instrumentForeign(root, state, selected)));
      }
      const config = path.join(temporary, 'probe.json');
      fs.writeFileSync(
        config,
        JSON.stringify({
          runId: id,
          units: state.units,
          values: state.facts.values,
          observations: observation
            ? state.verificationPlans[observation.planId].scenarios.find(
                (s) => s.id === observation.scenarioId,
              ).observations
            : [],
        }),
      );
      const probe = fileURLToPath(new URL('../assets/runtime/node-probe.mjs', import.meta.url));
      probeHash = runtimeFingerprint();
      const env = {
        PRODUCT_BLUEPRINT_PROBE_CONFIG: config,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${probe}`.trim(),
        PRODUCT_BLUEPRINT_EVENT_FD: '3',
      };
      const instrumented = new Map(
        state.manifest
          .filter((item) => item.hash && fs.existsSync(path.join(root, item.file)))
          .map((item) => [item.file, digest(fs.readFileSync(path.join(root, item.file)))]),
      );
      for (const build of input.build || []) {
        commandInput(build);
        const report = await executeCommand(remap(build), root);
        if (report.exitCode !== 0 || report.timedOut || report.outputExceeded) {
          result = report;
          integrity.push('探针副本编译失败。');
          break;
        }
      }
      for (const [file, hash] of instrumented)
        if (digest(fs.readFileSync(path.join(root, file))) !== hash)
          integrity.push(`编译命令修改了探针副本源码：${file}。`);
      if (!result) {
        if (input.browser) {
          const { executeBrowser } = await import('./flow-browser.mjs');
          result = await executeBrowser(
            remap(input),
            root,
            JSON.parse(fs.readFileSync(config, 'utf8')),
            env,
          );
        } else result = await executeCommand(remap(input), root, { env, events: true });
      }
      for (const [file, hash] of instrumented)
        if (
          !fs.existsSync(path.join(root, file)) ||
          digest(fs.readFileSync(path.join(root, file))) !== hash
        )
          copyStable = false;
      try {
        events = result.events
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const event = JSON.parse(line);
            if (Object.hasOwn(event, 'rawScalar')) {
              const value = event.rawScalar;
              if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
                event.valueHash = primitiveFingerprint(value);
                event.valueType = value === null ? 'null' : typeof value;
              }
              delete event.rawScalar;
            }
            for (const field of Object.values(event.fields || {})) {
              if (Object.hasOwn(field, 'rawScalar')) {
                field.valueHash = primitiveFingerprint(field.rawScalar);
                delete field.rawScalar;
              }
            }
            return event;
          });
        integrity.push(...validateEvents(events, state, id));
      } catch {
        integrity.push('探针观测无法解析，不能作为业务证据。');
      }
    }
    let sourceStable = true,
      documentStable = true;
    try {
      assertFresh(state);
    } catch {
      sourceStable = false;
    }
    try {
      const current = readSnapshot(filename).document;
      documentStable = Object.entries(flow.featureBindings).every(
        ([id, binding]) =>
          current.features[id]?.revision === binding.revision &&
          featureDefinitionHash(current.features[id]) === binding.definitionHash,
      );
    } catch {
      documentStable = false;
    }
    const feature = snapshot.document.features[featureId],
      eventsText = JSON.stringify(events);
    const record = {
      version: 2,
      id,
      documentPath: fs.realpathSync(filename),
      featureId,
      revision: feature.revision,
      definitionHash: featureDefinitionHash(feature),
      snapshotHash: state.snapshotHash,
      ...(observation
        ? { observation }
        : {
            flow: { id: flow.id, recordHash: flow.recordHash, scenarioId: input.flow.scenarioId },
          }),
      command: input.command,
      args: input.args,
      timeoutMs: input.timeoutMs ?? 60000,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputExceeded: result.outputExceeded,
      sourceStable,
      documentStable,
      copyVerified: true,
      copyStable,
      browser: Boolean(input.browser),
      probeHash,
      fixturesHash,
      setup: input.setup || [],
      build: input.build || [],
      unsupported,
      integrity,
      stdoutHash: digest(result.stdout),
      stderrHash: digest(result.stderr),
      eventsHash: digest(eventsText),
      eventCount: events.length,
    };
    record.hash = digest(JSON.stringify(record));
    const directory = path.join(path.dirname(stateFile), 'verifications');
    fs.mkdirSync(directory, { recursive: true });
    for (const [suffix, content] of [
      ['stdout.log', result.stdout],
      ['stderr.log', result.stderr],
      ['events.json', eventsText],
      ['json', JSON.stringify(record, null, 2) + '\n'],
    ])
      fs.writeFileSync(path.join(directory, `${id}.${suffix}`), content, {
        flag: 'wx',
        mode: 0o600,
      });
    return {
      valid:
        result.exitCode === 0 &&
        !result.signal &&
        !result.timedOut &&
        !result.outputExceeded &&
        sourceStable &&
        documentStable &&
        copyStable &&
        !integrity.length,
      executionId: id,
      exitCode: result.exitCode,
      eventCount: events.length,
      integrity,
      unsupported,
      record: path.join(directory, `${id}.json`),
      message: '执行证据已保存；流程是否成立由 flow check 根据实际连接、数据与结果判断。',
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
