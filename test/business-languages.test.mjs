import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanAnalysis, loadSession } from '../lib/analysis-session.mjs';
import {
  recordBusinessModel,
  reviewBusinessModel,
  checkBusinessModel,
} from '../lib/business-model.mjs';

async function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-business-languages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files))
    fs.writeFileSync(path.join(root, file), content);
  const scan = await scanAnalysis(root);
  const state = loadSession(scan.session).state;
  return { ...scan, root, state, ops: state.facts.operations };
}

test('Python Flask/FastAPI 注册保留方法与身份；共用 handler 不吞操作，组件挂载单独保留未知', async (t) => {
  const f = await fixture(t, {
    'server.py': `from flask import Flask as Web, Blueprint
from fastapi import FastAPI as API, APIRouter
app=Web(__name__)
api=API()
bp=Blueprint('notes',__name__,url_prefix='/drafts')
router=APIRouter(prefix='/v1')
@app.route('/notes',methods=['POST','DELETE'])
def shared(): return 'saved'
app.add_url_rule('/more',view_func=shared,methods=['POST'])
@api.get('/status')
async def status(): return 'ready'
@bp.get('/local')
def local(): return 'local'
@router.post('/notes')
def create(): return 'created'
table={}
table.get('not-a-route')
`,
  });
  const routes = f.ops.filter((op) => op.surface === 'http');
  assert.equal(routes.length, 6);
  const shared = routes.filter((op) => op.trigger.path === '/notes');
  assert.deepEqual(shared.map((op) => op.trigger.method).sort(), ['DELETE', 'POST']);
  assert.equal(shared[0].unitId, shared[1].unitId);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.ok(shared.every((op) => op.certainty === 'declared'));
  assert.ok(
    routes.some((op) => op.trigger.path === '/more' && op.handlerStatus === 'resolved-local'),
  );
  assert.ok(routes.some((op) => op.trigger.path === '/status' && op.certainty === 'declared'));
  for (const route of ['/drafts/local', '/v1/notes']) {
    const op = routes.find((op) => op.trigger.path === route);
    assert.equal(op.certainty, 'candidate');
    assert.equal(op.trigger.local, true);
    assert.match(op.limitation, /挂载/);
  }
  assert.equal(f.state.facts.entries.filter((entry) => entry.operationId).length, 6);
});

test('Go net/http 包别名与 ServeMux 保留每次注册；客户端 Get 不冒充路由', async (t) => {
  const f = await fixture(t, {
    'server.go': `package main
import web "net/http"
func shared(w web.ResponseWriter,r *web.Request) { w.Write([]byte("ok")) }
func main(){mux:=web.NewServeMux();mux.HandleFunc("POST /notes",shared);mux.HandleFunc("DELETE /notes",shared);web.HandleFunc("/status",func(w web.ResponseWriter,r *web.Request){w.Write([]byte("ready"))});web.Get("https://example.invalid")}
`,
  });
  const routes = f.ops.filter((op) => op.surface === 'http');
  assert.equal(routes.length, 3);
  const shared = routes.filter((op) => op.trigger.path === '/notes');
  assert.equal(shared.length, 2);
  assert.equal(shared[0].unitId, shared[1].unitId);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.ok(routes.every((op) => op.certainty === 'declared'));
  assert.ok(
    routes.some(
      (op) =>
        op.trigger.path === '/status' &&
        f.state.units.find((u) => u.id === op.unitId).kind === 'function-expression',
    ),
  );
});

test('C++ 依据 include 与接收者类型识别 httplib Server；Client 和同名类不冒充服务器', async (t) => {
  const code = `// 😀中文位置
#include <httplib.h>
void shared(const httplib::Request& req,httplib::Response& res){res.set_content("ok","text/plain");}
int main(){httplib::Server server;httplib::Client client("localhost");server.Post("/notes",shared);server.Delete("/notes",shared);server.Get("/status",[](auto& req,auto& res){res.set_content("ready","text/plain");});client.Get("/client");}
`;
  const f = await fixture(t, {
    'server.cpp': code,
    'fake.cpp': `struct Server{}; void no(){Server server;server.Post("/fake",[](){return 1;});}`,
  });
  const routes = f.ops.filter((op) => op.surface === 'http');
  assert.equal(routes.length, 3);
  const shared = routes.filter((op) => op.trigger.path === '/notes');
  assert.equal(shared[0].unitId, shared[1].unitId);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.ok(routes.every((op) => op.certainty === 'declared'));
  for (const op of routes)
    assert.match(code.slice(op.registration.start, op.registration.end), /^server\./);
});

test('接收者重赋值、参数遮蔽和伪造 API 名称不能获得已声明路由', async (t) => {
  const f = await fixture(t, {
    'fake.py': `from flask import Flask
app=Flask(__name__)
app=object()
@app.post('/changed')
def changed(): return 1
def nested(app):
    @app.get('/shadow')
    def shadow(): return 2
class Fake:
    def get(self,x): return x
fake=Fake()
fake.get('/fake')
`,
    'fake.go': `package main
import http "net/http"
func shadow(http interface{}){http.HandleFunc("/fake",func(){})}
func main(){mux:=http.NewServeMux();mux=unknown();mux.HandleFunc("/changed",func(){})}
`,
    'fake.cpp': `#include <httplib.h>
int main(){httplib::Client client("localhost");client.Post("/fake",[](){return 1;});}
`,
  });
  assert.equal(f.ops.filter((op) => op.surface === 'http').length, 0);
});

test('动态方法、动态路径及未解析 handler 保留候选，不静默升级为真实业务入口', async (t) => {
  const f = await fixture(t, {
    'dynamic.py': `from flask import Flask
app=Flask(__name__)
@app.route(prefix,methods=runtime_methods)
def dynamic(): return 1
app.add_url_rule('/external',view_func=external)
`,
    'dynamic.go': `package main
import "net/http"
func main(){http.HandleFunc(pattern,external)}
`,
    'dynamic.cpp': `#include <httplib.h>
int main(){httplib::Server server;server.Post(route,external);}
`,
  });
  const routes = f.ops.filter((op) => op.surface === 'http');
  assert.equal(routes.length, 4);
  assert.ok(routes.every((op) => op.certainty === 'candidate' && op.limitation));
  assert.ok(routes.some((op) => op.trigger.pathExpression === 'prefix'));
  assert.ok(routes.some((op) => op.trigger.patternExpression === 'pattern'));
  assert.ok(routes.some((op) => op.trigger.pathExpression === 'route'));
});

test('Go/C++ 块内遮蔽不污染外层注册；Python 方法不能把类属性当作闭包变量', async (t) => {
  const f = await fixture(t, {
    'scope.go': `package main\nimport "net/http"\nfunc handler(){}\nfunc main(){mux:=http.NewServeMux();{mux:=fake();mux.HandleFunc("/fake",handler)};mux.HandleFunc("/real",handler)}`,
    'scope.cpp': `#include <httplib.h>\nvoid handler(){}\nint main(){httplib::Server server;{Fake server;server.Post("/fake",handler);}server.Post("/real",handler);}`,
    'scope.py': `from flask import Flask\nclass Views:\n    app=Flask(__name__)\n    def register(self):\n        @app.post('/not-lexical')\n        def handler(): return 1\n`,
  });
  const routes = f.ops.filter((o) => o.surface === 'http');
  assert.deepEqual(routes.map((o) => [o.file, o.trigger.path]).sort(), [
    ['scope.cpp', '/real'],
    ['scope.go', '/real'],
  ]);
});

test('三种语言原生 argv 分派保留独立命令，不把比较常量和普通字符串当命令', async (t) => {
  const f = await fixture(t, {
    'cli.py': `import sys as system
command=system.argv[1]
if command == 'enable': print('enabled')
elif command == 'disable': print('disabled')
if other == 'fake': print('fake')
`,
    'cli.go': `package main
import "os"
func main(){command:=os.Args[1];switch command{case "enable":println("enabled");case "disable":println("disabled")};if other=="fake"{println(other)}}
`,
    'cli.cpp': `#include <string>
int main(int count,char* values[]){if(std::string(values[1])=="enable") return 1;if(std::string(values[1])=="disable")return 2;if(other=="fake")return 3;}
`,
  });
  for (const file of ['cli.py', 'cli.go', 'cli.cpp'])
    assert.deepEqual(
      f.ops
        .filter((op) => op.file === file && op.surface === 'cli')
        .map((op) => op.trigger.command)
        .sort(),
      ['disable', 'enable'],
    );
});

test('Python 关键字路由和 Click 导入别名保留身份；伪造同名命令装饰器不被识别', async (t) => {
  const f = await fixture(t, {
    'commands.py': `from flask import Flask
from click import command as action
app=Flask(__name__)
@app.route(rule='/kw',methods=['POST'])
def save(): return 'saved'
app.add_url_rule(rule='/other',view_func=save)
@action(name='publish')
def publish(): return 'published'
@action()
def remove_note(): return 'removed'
@unknown.command('fake')
def fake(): return 'fake'
`,
  });
  assert.deepEqual(
    f.ops
      .filter((o) => o.surface === 'http')
      .map((o) => o.trigger.path)
      .sort(),
    ['/kw', '/other'],
  );
  assert.deepEqual(
    f.ops
      .filter((o) => o.surface === 'cli')
      .map((o) => o.trigger.command)
      .sort(),
    ['publish', 'remove-note'],
  );
});

test('公开 CLI 实际结果与独立预期一致；四种语言的错误输出变体即使退出成功也不能通过', async (t) => {
  const cases = [
    {
      language: 'javascript',
      file: 'main.mjs',
      command: process.execPath,
      args: ['main.mjs'],
      source: `const command=process.argv[2];if(command==='enable')console.log('enabled');if(command==='disable')console.log('disabled');`,
    },
    {
      language: 'python',
      file: 'main.py',
      command: 'python3',
      args: ['main.py'],
      source: `import sys\ncommand=sys.argv[1]\nif command=='enable': print('enabled')\nif command=='disable': print('disabled')\n`,
    },
    {
      language: 'go',
      file: 'main.go',
      command: './sample',
      args: [],
      build: ['go', ['build', '-o', 'sample', 'main.go']],
      source: `package main\nimport "os"\nimport "fmt"\nfunc main(){command:=os.Args[1];switch command{case "enable":fmt.Println("enabled");case "disable":fmt.Println("disabled")}}`,
    },
    {
      language: 'cpp',
      file: 'main.cpp',
      command: './sample',
      args: [],
      build: ['clang++', ['-std=c++17', 'main.cpp', '-o', 'sample']],
      source: `#include <string>\n#include <iostream>\nint main(int argc,char** input){if(std::string(input[1])=="enable")std::cout<<"enabled";if(std::string(input[1])=="disable")std::cout<<"disabled";}`,
    },
  ];
  const expected = { enable: 'enabled', disable: 'disabled' };
  for (const sample of cases)
    await t.test(sample.language, async (t) => {
      const tool = sample.build?.[0] || sample.command;
      if (spawnSync(tool, ['--version'], { encoding: 'utf8' }).error)
        return t.skip(`环境缺少 ${tool}`);
      const f = await fixture(t, { [sample.file]: sample.source });
      assert.deepEqual(
        f.ops
          .filter((o) => o.surface === 'cli')
          .map((o) => o.trigger.command)
          .sort(),
        ['disable', 'enable'],
      );
      const execute = (command) =>
        spawnSync(sample.command, [...sample.args, command], {
          cwd: f.root,
          encoding: 'utf8',
          timeout: 30000,
        });
      const build = () => {
        if (!sample.build) return;
        const built = spawnSync(sample.build[0], sample.build[1], {
          cwd: f.root,
          encoding: 'utf8',
          timeout: 30000,
        });
        assert.equal(built.status, 0, built.stderr);
      };
      build();
      for (const [command, value] of Object.entries(expected)) {
        const run = execute(command);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout.trim(), value);
      }
      // The independent expected result stays fixed in this controlled trial.
      fs.writeFileSync(
        path.join(f.root, sample.file),
        sample.source.replaceAll('disabled', 'enabled'),
      );
      build();
      const wrong = execute('disable');
      assert.equal(wrong.status, 0);
      assert.notEqual(wrong.stdout.trim(), expected.disable, '成功退出不能掩盖业务结果错误');
      assert.throws(() => checkBusinessModel(f.session), { code: 'ANALYSIS_STALE' });
    });
});

test('四种语言共用地图与审阅协议；漏掉任一注册会报告缺口，不按功能名称或函数数量评分', async (t) => {
  const fixtures = {
    javascript: {
      'app.mjs': `import express from 'express';const app=express();function shared(){return 'saved'}app.post('/notes',shared);app.delete('/notes',shared);`,
    },
    python: {
      'app.py': `from flask import Flask\napp=Flask(__name__)\n@app.route('/notes',methods=['POST','DELETE'])\ndef shared(): return 'saved'\n`,
    },
    go: {
      'app.go': `package main\nimport "net/http"\nfunc shared(w http.ResponseWriter,r *http.Request){w.Write([]byte("saved"))}\nfunc main(){http.HandleFunc("POST /notes",shared);http.HandleFunc("DELETE /notes",shared)}`,
    },
    cpp: {
      'app.cpp': `#include <httplib.h>\nvoid shared(){save();}\nint main(){httplib::Server server;server.Post("/notes",shared);server.Delete("/notes",shared);}`,
    },
  };
  for (const [language, files] of Object.entries(fixtures))
    await t.test(language, async (t) => {
      const f = await fixture(t, files),
        routes = f.ops.filter((op) => op.surface === 'http');
      assert.equal(routes.length, 2);
      const unit = f.state.units.find((u) => u.name === 'shared'),
        point = unit.reviewPoints.find((p) => ['return', 'call'].includes(p.kind));
      const capability = {
        id: 'notes',
        title: '便笺操作',
        actor: '便笺用户',
        goal: '按请求变更便笺',
        outcome: '返回处理结果',
        operationIds: f.ops.filter((op) => op.unitId === unit.id).map((op) => op.id),
        results: [
          {
            kind: 'code',
            unitId: unit.id,
            pointId: point.id,
            detail: '核对真实处理结果；同一函数支持多个操作，不声称已经运行。',
          },
        ],
      };
      const input = {
        version: 1,
        capabilities: [capability],
        dispositions: f.ops
          .filter((op) => !capability.operationIds.includes(op.id))
          .map((op) => ({
            operationId: op.id,
            source: op.registration.file,
            reason: '该入口仅负责共享注册设置；本样例单独核对处理函数的操作与结果。',
          })),
      };
      const saved = await recordBusinessModel(f.session, input);
      assert.equal(saved.valid, true);
      assert.equal(saved.semanticStatus, 'unreviewed');
      await reviewBusinessModel(f.session, {
        modelHash: saved.model.recordHash,
        reviewer: 'language-fixture',
        decisions: [
          {
            capabilityId: 'notes',
            verdict: 'supported',
            reason: '仅核对两个注册的保留和结果位置，不推断业务授权和持久化。',
            evidence: capability.results,
          },
        ],
        exclusions: input.dispositions.map((d) => {
          const op = f.ops.find((o) => o.id === d.operationId),
            owner = f.state.units.find((u) => u.id === op.unitId);
          return {
            operationId: op.id,
            verdict: 'supported',
            reason: d.reason,
            evidence: [
              {
                kind: 'code',
                unitId: owner.id,
                pointId: owner.reviewPoints.find((p) => p.kind === 'call').id,
                detail: '主入口注册处理函数；它不是处理函数已执行的证明。',
              },
            ],
          };
        }),
      });
      assert.equal(checkBusinessModel(f.session).semanticStatus, 'reviewed');
      capability.operationIds = capability.operationIds.filter((id) => id !== routes[1].id);
      assert.equal((await recordBusinessModel(f.session, input)).valid, false);
      assert.equal(checkBusinessModel(f.session).semanticStatus, 'unreviewed');
    });
});
