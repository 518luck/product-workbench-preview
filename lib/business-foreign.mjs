import { digest } from './analysis-facts.mjs';

const kids = (node) => node?.namedChildren || [];
const field = (node, name) => node?.childForFieldName(name);
const calls = new Set(['call', 'call_expression']);
const functions = new Set([
  'function_definition',
  'function_declaration',
  'method_declaration',
  'func_literal',
  'lambda',
  'lambda_expression',
]);
const scopes = new Set([
  ...functions,
  'class_definition',
  'class_specifier',
  'namespace_definition',
]);
const verbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const walk = (node, visit) => {
  visit(node);
  kids(node).forEach((child) => walk(child, visit));
};
const single = (node) => {
  while (
    node &&
    ['expression_list', 'parenthesized_expression', 'condition_clause'].includes(node.type) &&
    kids(node).length === 1
  )
    node = kids(node)[0];
  return node;
};
const identifier = (node) => {
  while (node && !['identifier', 'field_identifier', 'package_identifier'].includes(node.type))
    node = field(node, 'declarator');
  return node;
};

// Per-file syntax adapters produce the same operation protocol as JS/TS. A
// registered name is not proof of mounting, execution, or business semantics.
export function indexForeignBusinessOperations(root, { file, language, owned, values }) {
  const valueMap = new Map(values.map((value) => [value.id, value]));
  const bindings = new Map(),
    operations = [],
    includes = new Set();
  const isScope = (node) =>
    scopes.has(node.type) ||
    (language !== 'python' &&
      [
        'block',
        'compound_statement',
        'if_statement',
        'expression_switch_statement',
        'for_statement',
      ].includes(node.type));
  const lexical = (node) => {
    for (let p = node?.parent; p; p = p.parent) if (isScope(p)) return p;
  };
  const bind = (name, node, value, scope = lexical(node)) => {
    if (!name) return;
    const key = `${scope?.id || 0}:${name}`;
    if (!bindings.has(key)) bindings.set(key, []);
    bindings.get(key).push({ node, ...value });
  };
  const lookup = (name, node) => {
    let passedFunction = false;
    for (let scope = lexical(node); ; scope = lexical(scope)) {
      // Python class attributes are available while evaluating the class body,
      // but are not an enclosing lexical namespace for a method body.
      if (language === 'python' && scope?.type === 'class_definition' && passedFunction) continue;
      if (functions.has(scope?.type)) passedFunction = true;
      const rows = bindings.get(`${scope?.id || 0}:${name}`);
      // Reassignments, shadowed parameters and ambiguous declarations are not
      // silently resolved by spelling or by whichever was visited last.
      if (rows) return rows.length === 1 ? rows[0] : undefined;
      if (!scope) return;
    }
  };
  const owner = (node) => {
    for (let p = node; p; p = p.parent) if (owned.has(p.id)) return owned.get(p.id);
  };
  const callee = (node) => field(node, 'function');
  const args = (node) => kids(field(node, 'arguments'));
  const positional = (node) => args(node).filter((arg) => arg.type !== 'keyword_argument');
  const keyword = (node, name) =>
    field(
      args(node).find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === name),
      'value',
    );
  const qualified = (node, seen = new Set()) => {
    node = single(node);
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    if (['attribute', 'selector_expression', 'field_expression'].includes(node.type)) {
      const base = qualified(
        field(node, 'object') || field(node, 'operand') || field(node, 'argument'),
        seen,
      );
      const name = field(node, 'attribute') || field(node, 'field');
      return base && name ? `${base}.${name.text}` : undefined;
    }
    if (node.type === 'qualified_identifier') return node.text.replaceAll('::', '.');
    const row = lookup(node.text, node);
    if (row?.qualified) return row.qualified;
    return row?.value && ['identifier', 'package_identifier'].includes(row.value.type)
      ? qualified(row.value, seen)
      : undefined;
  };
  const literal = (node, seen = new Set()) => {
    node = single(node);
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    if (
      ['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal'].includes(
        node.type,
      )
    ) {
      // Interpolation and escapes need the language's runtime meaning; never
      // equate raw source characters with a decoded route or command.
      const raw = node.text;
      if (
        raw.includes('\\') ||
        /^(?:[fFbB]|[uU][rR])/.test(raw) ||
        kids(node).some((c) => c.type === 'interpolation')
      )
        return;
      const match = raw.match(/^(?:[rRuU])?(['"`])([\s\S]*)\1$/);
      if (match && !match[2].includes(match[1])) return match[2];
      return;
    }
    const row = lookup(node.text, node);
    return row?.value ? literal(row.value, seen) : undefined;
  };
  const object = (node, seen = new Set()) => {
    node = single(node);
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    if (calls.has(node.type)) {
      const name = qualified(callee(node));
      if (name) return { name, constructor: node };
    }
    const row = lookup(node.text, node);
    if (row?.type) return { name: row.type, constructor: row.node };
    return row?.value ? object(row.value, seen) : undefined;
  };
  const target = (node) => {
    node = single(node);
    if (!node) return;
    if (owned.has(node.id) && functions.has(node.type)) return owned.get(node.id);
    const row = lookup(node.text, node);
    return row?.unit;
  };
  const add = (node, handler, surface, trigger, adapter, certain, limitation, execution) => {
    const resolved = target(handler),
      unit = resolved || owner(node);
    if (!unit || unit.role !== 'product') return;
    const registration = { file, start: node.startIndex, end: node.endIndex };
    operations.push({
      id: `op-${digest(JSON.stringify([registration, surface, trigger, unit.id])).slice(0, 24)}`,
      unitId: unit.id,
      file,
      surface,
      trigger,
      registration,
      adapter,
      ...(execution
        ? { execution: { file, start: execution.startIndex, end: execution.endIndex } }
        : {}),
      certainty: certain && Boolean(resolved) ? 'declared' : 'candidate',
      handlerStatus: resolved ? 'resolved-local' : 'unknown',
      ...(limitation || !resolved
        ? {
            limitation:
              limitation || '注册已识别；处理目标尚未解析，须沿导入、类型或运行证据继续核对。',
          }
        : {}),
    });
  };

  walk(root, (node) => {
    const unit = owned.get(node.id);
    if (unit && functions.has(node.type)) {
      if (!unit.name.startsWith('<anonymous')) bind(unit.name, node, { unit });
      for (const id of unit.parameters) {
        const parameter = valueMap.get(id);
        if (parameter) bind(parameter.name, node, { shadow: true }, node);
      }
    }
    if (language === 'python' && node.type === 'import_from_statement') {
      const module = field(node, 'module_name')?.text;
      for (const child of kids(node).filter((c) => c.id !== field(node, 'module_name')?.id)) {
        const name = field(child, 'name') || child;
        bind((field(child, 'alias') || name).text, node, { qualified: `${module}.${name.text}` });
      }
    }
    if (language === 'python' && node.type === 'import_statement') {
      for (const child of kids(node)) {
        const name = field(child, 'name') || child;
        const alias = field(child, 'alias');
        bind(alias?.text || name.text.split('.')[0], node, {
          qualified: alias ? name.text : name.text.split('.')[0],
        });
      }
    }
    if (language === 'go' && node.type === 'import_spec') {
      const module = literal(field(node, 'path'));
      if (module)
        bind(field(node, 'name')?.text || module.split('/').at(-1), node, { qualified: module });
    }
    if (
      [
        'assignment',
        'short_var_declaration',
        'var_spec',
        'const_spec',
        'assignment_statement',
        'augmented_assignment',
        'augmented_assignment_statement',
      ].includes(node.type)
    ) {
      const left = single(field(node, 'left') || field(node, 'name'));
      if (left?.type === 'identifier')
        bind(left.text, node, { value: single(field(node, 'right') || field(node, 'value')) });
      else if (['expression_list', 'pattern_list', 'tuple_pattern'].includes(left?.type))
        for (const child of kids(left))
          if (child.type === 'identifier') bind(child.text, node, { shadow: true });
    }
    if (language === 'cpp' && node.type === 'preproc_include')
      includes.add(field(node, 'path')?.text.replace(/^[<"]|[>"]$/g, ''));
    if (language === 'cpp' && ['declaration', 'parameter_declaration'].includes(node.type)) {
      const d = field(node, 'declarator'),
        name = identifier(d);
      if (name && node.type !== 'parameter_declaration')
        bind(name.text, node, {
          type: field(node, 'type')?.text.replaceAll('::', '.'),
          value: field(d, 'value'),
        });
    }
  });

  // Python route decorators and explicit registration use import provenance,
  // never an arbitrary object's .get(), .post() or identically named method.
  const pythonRoute = (node, handler) => {
    const fn = callee(node);
    if (fn?.type !== 'attribute') return;
    const receiver = object(field(fn, 'object')),
      method = field(fn, 'attribute')?.text;
    if (
      !receiver ||
      !['flask.Flask', 'flask.Blueprint', 'fastapi.FastAPI', 'fastapi.APIRouter'].includes(
        receiver.name,
      )
    )
      return;
    if (
      ![
        'route',
        'api_route',
        'add_url_rule',
        'add_api_route',
        ...[...verbs].map((v) => v.toLowerCase()),
      ].includes(method)
    )
      return;
    const routeNode = positional(node)[0] || keyword(node, 'path') || keyword(node, 'rule');
    const route = literal(routeNode);
    const methods = keyword(node, 'methods');
    const declared = verbs.has(method.toUpperCase())
      ? [method.toUpperCase()]
      : methods
        ? kids(methods).map((n) => literal(n))
        : ['GET'];
    const known =
      declared.length > 0 && declared.every((v) => typeof v === 'string' && verbs.has(v));
    const local = /(?:Blueprint|APIRouter)$/.test(receiver.name);
    const prefix = literal(
      keyword(receiver.constructor, receiver.name === 'flask.Blueprint' ? 'url_prefix' : 'prefix'),
    );
    for (const verb of known ? declared : ['*']) {
      add(
        node,
        handler ||
          keyword(node, 'view_func') ||
          keyword(node, 'endpoint') ||
          positional(node)[method === 'add_url_rule' ? 2 : 1],
        'http',
        {
          method: verb,
          ...(route === undefined
            ? {
                pathExpression: routeNode?.text || '<unknown>',
              }
            : { path: `${prefix || ''}${route}` }),
          ...(local ? { local: true } : {}),
        },
        receiver.name.startsWith('flask.') ? 'python-flask' : 'python-fastapi',
        route !== undefined && known && !local,
        local
          ? '组件内路径；Blueprint/APIRouter 的挂载、前缀和多次注册须另行核对。'
          : !known || route === undefined
            ? '路径或方法为动态表达式，静态清单未确认其值。'
            : undefined,
      );
    }
  };
  walk(root, (node) => {
    if (language === 'python' && node.type === 'decorated_definition') {
      const fn = field(node, 'definition');
      if (!owned.has(fn?.id)) return;
      for (const decorator of kids(node).filter((n) => n.type === 'decorator')) {
        const call = kids(decorator)[0];
        if (!calls.has(call?.type)) continue;
        pythonRoute(call, fn);
        const name = qualified(callee(call));
        if (name === 'click.command' || name === 'click.group') {
          const raw = positional(call)[0] || keyword(call, 'name'),
            command = raw ? literal(raw) : owned.get(fn.id).name.replaceAll('_', '-');
          add(
            call,
            fn,
            'cli',
            command === undefined ? { commandExpression: raw?.text || '<unknown>' } : { command },
            'python-click',
            command !== undefined && Boolean(raw),
            !raw
              ? '根据函数名给出默认命令名候选；须核对 Click 版本、命名规则及命令组挂载。'
              : name === 'click.group'
                ? '命令组注册；子命令及实际调用路径须单独核对。'
                : undefined,
          );
        }
      }
    }
    if (language === 'python' && calls.has(node.type) && node.parent?.type !== 'decorator')
      pythonRoute(node);
    if (language === 'go' && calls.has(node.type)) {
      const fn = callee(node),
        name = field(fn, 'field')?.text;
      if (!['HandleFunc', 'Handle'].includes(name)) return;
      const receiver = field(fn, 'operand'),
        provenance = qualified(receiver),
        obj = object(receiver);
      if (provenance !== 'net/http' && obj?.name !== 'net/http.NewServeMux') return;
      const raw = literal(args(node)[0]),
        pattern = raw?.match(/^(?:([A-Z]+) )?(\/.*)$/);
      add(
        node,
        args(node)[1],
        'http',
        pattern
          ? { method: pattern[1] || '*', path: pattern[2] }
          : { patternExpression: raw ?? args(node)[0]?.text ?? '<unknown>' },
        'go-net-http',
        Boolean(pattern),
        pattern ? undefined : '动态或带主机名的模式尚未拆解；须核对原始模式及实际路由。',
      );
    }
    if (language === 'cpp' && calls.has(node.type)) {
      const fn = callee(node),
        method = field(fn, 'field')?.text,
        receiver = object(field(fn, 'argument'));
      if (
        !['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options'].includes(method) ||
        !['httplib.Server', 'httplib.SSLServer'].includes(receiver?.name) ||
        !includes.has('httplib.h')
      )
        return;
      const path = literal(args(node)[0]);
      add(
        node,
        args(node)[1],
        'http',
        path === undefined
          ? { method: method.toUpperCase(), pathExpression: args(node)[0]?.text || '<unknown>' }
          : { method: method.toUpperCase(), path },
        'cpp-httplib',
        path !== undefined,
        path === undefined
          ? '路由模式为动态表达式，未推断其实际值。'
          : '源码声明的路由模式；监听、正则匹配与处理目标的运行结果须另行核对。',
      );
    }
  });

  const argv = (node, seen = new Set()) => {
    node = single(node);
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    const name = qualified(node);
    if (name === 'sys.argv' || name === 'os.Args') return true;
    if (language === 'cpp' && node.type === 'identifier') {
      for (let p = node.parent; p; p = p.parent) {
        const u = owned.get(p.id);
        if (u && functions.has(p.type)) {
          let declarator = field(p, 'declarator'),
            parameters;
          while (declarator && !parameters) {
            parameters = field(declarator, 'parameters');
            declarator = field(declarator, 'declarator');
          }
          const second = kids(parameters)[1];
          return (
            u.name === 'main' &&
            !lexical(p) &&
            lookup(node.text, node)?.shadow === true &&
            valueMap.get(u.parameters[1])?.name === node.text &&
            field(second, 'type')?.text === 'char' &&
            /\*.*(?:\*|\[)/.test(field(second, 'declarator')?.text || '')
          );
        }
      }
    }
    const row = lookup(node.text, node);
    if (row?.value && argv(row.value, seen)) return true;
    if (['subscript', 'subscript_expression', 'index_expression'].includes(node.type))
      return argv(
        field(node, 'value') || field(node, 'argument') || field(node, 'operand') || kids(node)[0],
        seen,
      );
    if (
      calls.has(node.type) &&
      ((language === 'cpp' && qualified(callee(node)) === 'std.string') ||
        (language === 'python' && callee(node)?.text === 'str' && !lookup('str', node)))
    )
      return args(node).some((a) => argv(a, seen));
    return false;
  };
  walk(root, (node) => {
    if (['if_statement', 'elif_clause'].includes(node.type)) {
      const condition = single(field(node, 'condition'));
      const left = field(condition, 'left') || kids(condition)[0],
        right = field(condition, 'right') || kids(condition).at(-1);
      // Only equality comparisons declare an exact command. Inequality,
      // substring matches and arbitrary transformations remain unclassified.
      if (!condition?.children.some((c) => c.text === '==')) return;
      for (const [a, b] of [
        [left, right],
        [right, left],
      ]) {
        const command = literal(b);
        if (command !== undefined && argv(a))
          add(
            node,
            null,
            'cli',
            { command },
            `${language}-argv`,
            false,
            '参数分支候选；需核对分支内业务结果，未把分派函数当作业务实现。',
            field(node, 'consequence'),
          );
      }
    }
    if (
      language === 'go' &&
      node.type === 'expression_switch_statement' &&
      argv(field(node, 'value'))
    ) {
      for (const branch of kids(node).filter((n) => n.type === 'expression_case'))
        for (const value of kids(field(branch, 'value'))) {
          const command = literal(value);
          if (command !== undefined)
            add(
              branch,
              null,
              'cli',
              { command },
              'go-argv',
              false,
              '命令分派分支；实际处理结果须沿分支核对。',
            );
        }
    }
    if (language === 'go' && node.type === 'go_statement') {
      const call = kids(node).find((n) => calls.has(n.type));
      if (call)
        add(
          node,
          callee(call),
          'task',
          { expression: callee(call)?.text || '<unknown>' },
          'go-goroutine',
          false,
          '并发调用候选；尚未证明外部触发、调度周期、并发数据或运行结果。',
        );
    }
  });
  return [...new Map(operations.map((op) => [op.id, op])).values()];
}
