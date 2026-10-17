import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { businessFields } from './feature-operations.mjs';
import { assertFresh, loadSession, sessionFile } from './analysis-session.mjs';
import { BlueprintError } from './errors.mjs';
import { validateDocument } from './validation.mjs';
import { checkFlowRecord } from './flow.mjs';
import { bindVerificationScope, checkBoundScope } from './verification-plan.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const executionId = /^v-[a-f0-9-]{36}$/;
export const definitionHash = (feature) =>
  digest(JSON.stringify(businessFields.map((key) => [key, feature[key] ?? null])));
const recordHash = ({ hash, ...record }) => digest(JSON.stringify(record));
const readFeature = (filename, id) => {
  const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const report = validateDocument(document);
  if (!report.valid)
    throw new BlueprintError('VALIDATION_FAILED', '文档校验失败，未执行验收命令。', {
      details: report.errors,
    });
  if (!Object.hasOwn(document.features ?? {}, id))
    throw new BlueprintError('NOT_FOUND', `功能不存在：${id}。`);
  return document.features[id];
};

// This explicitly requested command executes an acceptance check. The scanner never executes code.
export async function runVerification(filename, id, session, input) {
  const scope =
    input && Object.hasOwn(input, 'scope')
      ? bindVerificationScope(filename, id, session, input.scope, input.flow)
      : undefined;
  const command = { ...input };
  delete command.scope;
  if (scope && command.purpose === 'environment')
    throw new BlueprintError('INVALID_ARGUMENT', '环境诊断不能作为业务场景验收。');
  const result = await executeVerification(filename, id, session, command);
  if (scope) {
    const record = JSON.parse(fs.readFileSync(result.record, 'utf8'));
    record.scope = scope;
    record.hash = recordHash(record);
    const temporary = result.record + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, result.record);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    try {
      checkBoundScope(record, loadSession(session).state, filename, readFeature(filename, id));
    } catch {
      result.valid = false;
      result.scopeStable = false;
    }
    result.scope = scope;
  }
  return result;
}
async function executeVerification(filename, id, session, input) {
  if (input?.flow) {
    const { runFlowVerification } = await import('./flow-runtime.mjs');
    return runFlowVerification(filename, id, session, input);
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['command', 'args', 'timeoutMs', 'purpose'].includes(key)) ||
    (input.purpose !== undefined && !['acceptance', 'environment'].includes(input.purpose)) ||
    typeof input.command !== 'string' ||
    !input.command.trim() ||
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== 'string')
  )
    throw new BlueprintError(
      'INVALID_ARGUMENT',
      '验收输入为 command、args 和可选 timeoutMs；不经过 shell。',
    );
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new BlueprintError('INVALID_ARGUMENT', 'timeoutMs 应为 1–600000 毫秒。');
  const { filename: stateFile, state } = loadSession(session);
  assertFresh(state);
  const documentPath = fs.realpathSync(filename),
    feature = readFeature(documentPath, id);
  const definition = definitionHash(feature),
    startedAt = new Date().toISOString();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: state.root,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    let size = 0,
      timedOut = false,
      outputExceeded = false,
      stopped = false;
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
      // Descendants may inherit pipes; never wait indefinitely for their output after stopping.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    for (const key of ['stdout', 'stderr'])
      child[key].on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
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
      });
    });
  });
  let sourceStable = true,
    documentStable = true;
  try {
    assertFresh(state);
  } catch {
    sourceStable = false;
  }
  try {
    const current = readFeature(documentPath, id);
    documentStable =
      current.revision === feature.revision && definitionHash(current) === definition;
  } catch {
    documentStable = false;
  }
  const directory = path.join(path.dirname(stateFile), 'verifications');
  fs.mkdirSync(directory, { recursive: true });
  const idValue = `v-${randomUUID()}`;
  const record = {
    version: 1,
    purpose: input.purpose ?? 'acceptance',
    id: idValue,
    documentPath,
    featureId: id,
    revision: feature.revision,
    definitionHash: definition,
    snapshotHash: state.snapshotHash,
    cwd: state.root,
    command: input.command,
    args: input.args,
    timeoutMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputExceeded: result.outputExceeded,
    sourceStable,
    documentStable,
    stdoutHash: digest(result.stdout),
    stderrHash: digest(result.stderr),
  };
  for (const stream of ['stdout', 'stderr'])
    fs.writeFileSync(path.join(directory, `${idValue}.${stream}.log`), result[stream], {
      flag: 'wx',
      mode: 0o600,
    });
  record.hash = recordHash(record);
  fs.writeFileSync(
    path.join(directory, `${idValue}.json`),
    JSON.stringify(record, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const valid =
    result.exitCode === 0 &&
    !result.signal &&
    !result.timedOut &&
    !result.outputExceeded &&
    sourceStable &&
    documentStable;
  return {
    valid,
    executionId: idValue,
    revision: feature.revision,
    snapshotHash: state.snapshotHash,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputExceeded: result.outputExceeded,
    sourceStable,
    documentStable,
    record: path.join(directory, `${idValue}.json`),
  };
}

export function checkVerification(
  filename,
  feature,
  implementation,
  state,
  session,
  { required = true } = {},
) {
  const gaps = [];
  const directory = path.join(path.dirname(sessionFile(session)), 'verifications');
  for (const check of implementation?.checks ?? []) {
    if (!check.executionId && !required) continue;
    const where = `/features/${feature.id}/implementation/checks`;
    try {
      if (!executionId.test(check.executionId ?? ''))
        throw new Error('缺少工具生成的 executionId。');
      const record = JSON.parse(
        fs.readFileSync(path.join(directory, `${check.executionId}.json`), 'utf8'),
      );
      if (
        record.id !== check.executionId ||
        ![1, 2].includes(record.version) ||
        record.hash !== recordHash(record)
      )
        throw new Error('验收记录被修改或格式无效。');
      if (
        record.documentPath !== fs.realpathSync(filename) ||
        record.featureId !== feature.id ||
        record.revision !== feature.revision ||
        record.definitionHash !== definitionHash(feature) ||
        record.snapshotHash !== state.snapshotHash ||
        implementation.sourceSnapshot?.snapshotHash !== state.snapshotHash
      )
        throw new Error('验收记录不属于此文档、功能、定义版本或当前源码。');
      if (record.scope) checkBoundScope(record, state, filename, feature);
      if (
        record.exitCode !== 0 ||
        record.signal ||
        record.timedOut ||
        record.outputExceeded ||
        !record.sourceStable ||
        !record.documentStable ||
        check.result !== 'passed' ||
        record.purpose === 'environment'
      )
        throw new Error('验收未通过，或执行期间源码／定义发生变化。');
      if (record.version === 2) {
        const flow = state.flows?.[record.flow?.id];
        const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (
          !flow ||
          flow.recordHash !== record.flow.recordHash ||
          !record.copyVerified ||
          !record.copyStable ||
          record.integrity?.length ||
          !checkFlowRecord(flow, state, document, session).valid
        )
          throw Error(
            '此执行记录关联的流程尚未严格通过；保留原功能历史，不用未核验流程登记新完成。',
          );
      }
      for (const stream of ['stdout', 'stderr'])
        if (
          digest(fs.readFileSync(path.join(directory, `${check.executionId}.${stream}.log`))) !==
          record[`${stream}Hash`]
        )
          throw new Error('验收输出缺失或被修改。');
      if (Date.parse(implementation.verifiedAt) < Date.parse(record.finishedAt))
        throw new Error('登记时间早于验收执行完成时间。');
    } catch (error) {
      gaps.push({ path: where, kind: 'verification', message: error.message });
    }
  }
  if (required && !implementation?.checks?.length)
    gaps.push({
      path: `/features/${feature.id}/implementation/checks`,
      kind: 'verification',
      message: '没有验收执行记录。',
    });
  return gaps;
}
