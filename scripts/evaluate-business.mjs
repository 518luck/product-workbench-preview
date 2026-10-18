import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSession } from '../lib/analysis-session.mjs';
import { checkBusinessModel } from '../lib/business-model.mjs';

// These references stay with the grader, outside the agent's project/prompt.
// They grade operation/result identity, not arbitrary natural-language truth.
export const businessCases = [
  {
    id: 'notes',
    files: {
      'README.md':
        '# 便笺服务\n使用者可以新增非空便笺，也能按编号删除已有便笺。空文本和不存在的编号应拒绝。仅本机内存存储，没有云同步。\n',
      'service.mjs': `import http from 'node:http';
const notes=new Map();let serial=0;
export function createNote(text){if(!text.trim())throw new Error('empty');const id=String(++serial);notes.set(id,text);return {id,text};}
export function deleteNote(id){if(!notes.has(id))throw new Error('missing');notes.delete(id);return id;}
function dispatch(req,res){const input=JSON.parse(req.headers['x-input']||'{}');
if(req.url==='/notes' && req.method==='POST')return res.end(JSON.stringify(createNote(input.text)));
if(req.url==='/notes' && req.method==='DELETE')return res.end(deleteNote(input.id));}
http.createServer(dispatch);`,
    },
    atoms: [
      {
        trigger: { method: 'POST', path: '/notes' },
        result: { name: 'createNote', contains: 'return {id,text}' },
      },
      {
        trigger: { method: 'DELETE', path: '/notes' },
        result: { name: 'deleteNote', contains: 'return id' },
      },
    ],
  },
  {
    id: 'dispatch',
    files: {
      'README.md':
        '# 订阅控制\n用户通过 enable 开启订阅，通过 disable 关闭订阅；这两项可以独立调用。snapshot 仅是内部状态包装，不会改变订阅。未来计划导出 CSV，目前没有实现。\n',
      'cli.mjs': `let enabled=false;
export function enable(){enabled=true;return enabled;}
export function disable(){enabled=false;return enabled;}
export function snapshot(){return {enabled};}
const command=process.argv[2];switch(command){case 'enable':enable();break;case 'disable':disable();break;}`,
    },
    atoms: [
      { trigger: { command: 'enable' }, result: { name: 'enable', contains: 'enabled=true' } },
      { trigger: { command: 'disable' }, result: { name: 'disable', contains: 'enabled=false' } },
    ],
  },
  {
    id: 'workflow',
    files: {
      'README.md': '# 需求整理助手\n工作流只整理文档，不修改项目代码。源码工具只负责保存定义。\n',
      'SKILL.md':
        '# 需求维护\n读取用户修改和当前定义，整理目标、规则与影响，保存明确的产品定义后结束。不得实现项目代码。\n',
      'store.mjs':
        'export function saveDefinition(book,definition){book.definition=definition;return book;}',
    },
    atoms: [{ surface: 'workflow', result: { file: 'SKILL.md', quote: '不得实现项目代码' } }],
  },
  {
    id: 'python-routes',
    files: {
      'README.md':
        '# 订阅服务\n用户可以开启和关闭订阅；状态仅保存在本进程。HTTP 层分别注册两个操作，不能把 snapshot 当作开关。\n',
      'service.py': `from flask import Flask
app=Flask(__name__)
enabled=False
@app.post('/enable')
def enable():
    global enabled
    enabled=True
    return enabled
@app.post('/disable')
def disable():
    global enabled
    enabled=False
    return enabled
def snapshot(): return enabled
`,
    },
    atoms: [
      {
        trigger: { method: 'POST', path: '/enable' },
        result: { name: 'enable', contains: 'return enabled' },
      },
      {
        trigger: { method: 'POST', path: '/disable' },
        result: { name: 'disable', contains: 'return enabled' },
      },
    ],
  },
  {
    id: 'go-routes',
    files: {
      'README.md':
        '# 订阅服务\n用户可以开启和关闭订阅；两个操作各自修改内存状态并返回文字。snapshot 只查询，不修改。\n',
      'service.go': `package main
import "net/http"
var enabled=false
func enable(w http.ResponseWriter,r *http.Request){enabled=true;w.Write([]byte("enabled"))}
func disable(w http.ResponseWriter,r *http.Request){enabled=false;w.Write([]byte("disabled"))}
func snapshot()bool{return enabled}
func main(){http.HandleFunc("POST /enable",enable);http.HandleFunc("POST /disable",disable)}
`,
    },
    atoms: [
      {
        trigger: { method: 'POST', path: '/enable' },
        result: { name: 'enable', contains: 'w.Write' },
      },
      {
        trigger: { method: 'POST', path: '/disable' },
        result: { name: 'disable', contains: 'w.Write' },
      },
    ],
  },
  {
    id: 'cpp-routes',
    files: {
      'README.md':
        '# 订阅服务\n用户可以开启和关闭订阅，响应会返回不同文字。内存状态不持久化；snapshot 只是查询。\n',
      'service.cpp': `#include <httplib.h>
bool enabled=false;
void enable(const httplib::Request& req,httplib::Response& res){enabled=true;res.set_content("enabled","text/plain");}
void disable(const httplib::Request& req,httplib::Response& res){enabled=false;res.set_content("disabled","text/plain");}
bool snapshot(){return enabled;}
int main(){httplib::Server app;app.Post("/enable",enable);app.Post("/disable",disable);}
`,
    },
    atoms: [
      {
        trigger: { method: 'POST', path: '/enable' },
        result: { name: 'enable', contains: 'res.set_content' },
      },
      {
        trigger: { method: 'POST', path: '/disable' },
        result: { name: 'disable', contains: 'res.set_content' },
      },
    ],
  },
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function prepareBusinessCase(directory, item) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw Error('业务评测目录必须为空。');
  for (const [file, value] of Object.entries(item.files))
    fs.writeFileSync(path.join(directory, file), value);
  return Object.fromEntries(Object.entries(item.files).map(([k, v]) => [k, hash(v)]));
}
export function gradeBusinessCase(directory, item, original) {
  const errors = [];
  for (const [file, digest] of Object.entries(original))
    if (
      !fs.existsSync(path.join(directory, file)) ||
      hash(fs.readFileSync(path.join(directory, file))) !== digest
    )
      errors.push(`输入被修改：${file}`);
  let matched = 0,
    model,
    operations;
  try {
    const sessions = fs
      .readdirSync(path.join(directory, '.blueprint-analysis'))
      .filter((f) => f.startsWith('s-'));
    if (sessions.length !== 1) throw Error('评测需要唯一当前分析会话。');
    const session = path.join(directory, '.blueprint-analysis', sessions[0]);
    const report = checkBusinessModel(session);
    if (!report.valid) errors.push(...report.gaps.map((g) => g.message));
    const { state } = loadSession(session);
    model = report.model;
    operations = state.facts.operations;
    const distinct = new Set();
    for (const atom of item.atoms) {
      const ops = operations.filter(
        (op) =>
          (!atom.surface || op.surface === atom.surface) &&
          Object.entries(atom.trigger || {}).every(([k, v]) => op.trigger[k] === v),
      );
      const supported = model.capabilities.find(
        (c) =>
          c.operationIds.some((id) => ops.some((op) => op.id === id)) &&
          c.results.some((e) => {
            if (atom.result.quote)
              return (
                e.kind === 'context' &&
                state.contexts.find((ctx) => ctx.id === e.contextId)?.file === atom.result.file &&
                e.quote.includes(atom.result.quote)
              );
            const unit = state.units.find((u) => u.id === e.unitId);
            return (
              e.kind === 'code' &&
              unit?.name === atom.result.name &&
              unit.reviewPoints.some(
                (p) => p.id === e.pointId && p.code.includes(atom.result.contains),
              )
            );
          }),
      );
      if (!supported)
        errors.push(`遗漏操作或结果错映射：${JSON.stringify(atom.trigger || atom.surface)}`);
      else {
        matched++;
        distinct.add(supported.id);
      }
    }
    if (item.atoms.length > 1 && distinct.size < item.atoms.length)
      errors.push('此夹具的独立目标被合并，未分别保留其业务能力。');
  } catch (error) {
    errors.push(error.message);
  }
  return {
    valid: !errors.length,
    matchedAtoms: matched,
    expectedAtoms: item.atoms.length,
    errors,
    scope: '独立预设的操作/结果位置评分，不证明任意自然语言正确；新增主张和业务含义仍需盲审。',
  };
}

export async function evaluateBusiness(
  agent,
  {
    trials = 1,
    timeoutMs = 300000,
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-business-eval-')),
  } = {},
) {
  if (
    typeof agent?.command !== 'string' ||
    !Array.isArray(agent.args) ||
    agent.args.some((a) => typeof a !== 'string') ||
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    trials > 10 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw Error('提供外部 agent command/args、1–10 次 trials 和正数 timeoutMs；不自动选择模型。');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw Error('评测输出目录必须为空。');
  const repository = fileURLToPath(new URL('../', import.meta.url)),
    results = [];
  for (const item of businessCases)
    for (let trial = 1; trial <= trials; trial++) {
      const project = path.join(directory, `${item.id}-${trial}`),
        original = prepareBusinessCase(project, item);
      const prompt = `在 ${project} 只做业务发现，使用 ${path.join(repository, 'skills/product-blueprint-init/references/business-discovery.md')}。CLI 入口 ${path.join(repository, 'bin/product-blueprint.mjs')}。读取当前项目原文和上下文，保存有依据的业务地图并检查。无需生成产品书、运行服务、修改源码或完成全部分析；不提交Git。`;
      const started = Date.now();
      const log = fs.openSync(path.join(directory, `${item.id}-${trial}.log`), 'wx', 0o600);
      const execution = await new Promise((resolve) => {
        const child = spawn(agent.command, agent.args, {
          cwd: project,
          shell: false,
          stdio: ['pipe', log, log],
          detached: process.platform !== 'win32',
        });
        let timedOut = false,
          failure;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* process already exited */
          }
        }, timeoutMs);
        child.on('error', (e) => {
          failure = e.message;
        });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          resolve({ exitCode, timedOut, ...(failure ? { failure } : {}) });
        });
      });
      fs.closeSync(log);
      const grade = gradeBusinessCase(project, item, original);
      results.push({
        case: item.id,
        trial,
        ...execution,
        elapsedMs: Date.now() - started,
        ...grade,
        valid: grade.valid && execution.exitCode === 0 && !execution.timedOut,
      });
    }
  const report = { results, passed: results.filter((r) => r.valid).length, total: results.length };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  return { directory, ...report };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw Error('需要外部 agent 配置 JSON 路径；不在产品 CLI 内调用模型。');
  console.log(
    JSON.stringify(await evaluateBusiness(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2),
  );
}
