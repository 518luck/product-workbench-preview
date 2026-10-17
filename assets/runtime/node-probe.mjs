import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';

const config = JSON.parse(fs.readFileSync(process.env.PRODUCT_BLUEPRINT_PROBE_CONFIG, 'utf8'));
const storage = new AsyncLocalStorage(),
  registered = new WeakMap(),
  objects = new WeakMap();
const facts = new Map(config.values.map((value) => [value.id, value]));
const units = new Map(config.units.map((unit) => [unit.id, unit]));
const calls = new Map(
  config.units.flatMap((unit) => unit.calls.map((call) => [call.id, { ...call, owner: unit.id }])),
);
let sequence = 0,
  objectSequence = 0;
function fingerprint(value) {
  const type = value === null ? 'null' : typeof value;
  if (['object', 'function'].includes(type)) {
    if (!objects.has(value)) objects.set(value, `object-${++objectSequence}`);
    return { valueType: type, objectId: objects.get(value) };
  }
  let safe = value;
  if (type === 'number' && !Number.isFinite(value)) safe = String(value);
  if (type === 'bigint' || type === 'symbol') safe = String(value);
  return {
    valueType: type,
    valueHash: createHash('sha256')
      .update(JSON.stringify({ type, value: safe }))
      .digest('hex'),
  };
}
function observedFields(frame, kind, value, factId) {
  const fields = {};
  for (const observation of config.observations || []) {
    if (
      !observation.path ||
      observation.unitId !== frame.unitId ||
      observation.event !== kind ||
      (observation.factId && observation.factId !== factId)
    )
      continue;
    let current = value,
      present = true;
    for (const part of observation.path
      .slice(1)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      // Reading a getter would change program behavior. Observe only own data.
      if (current === null || typeof current !== 'object' || types.isProxy(current)) {
        present = false;
        break;
      }
      const property = Object.getOwnPropertyDescriptor(current, part);
      if (!property || !Object.hasOwn(property, 'value')) {
        present = false;
        break;
      }
      current = property.value;
    }
    if (present) fields[observation.path] = fingerprint(current);
  }
  return fields;
}
function emit(kind, frame, extra = {}) {
  const event = {
    runId: config.runId,
    seq: ++sequence,
    kind,
    traceId: frame.traceId,
    spanId: frame.id,
    unitId: frame.unitId,
    parentSpanId: frame.parent?.id || null,
    parentUnitId: frame.parent?.unitId || null,
    ...extra,
  };
  // A dedicated inherited pipe is deliberately separate from user stdout/stderr.
  fs.writeSync(3, JSON.stringify(event) + '\n');
}
function binding(frame, sourceId, targetId, sourceSpanId, targetSpanId, callId) {
  if (sourceId && targetId && facts.has(sourceId) && facts.has(targetId))
    emit('binding', frame, { sourceId, targetId, sourceSpanId, targetSpanId, callId });
}
const probe = Object.freeze({
  register(unitId, fn, name) {
    registered.set(fn, unitId);
    if (!fn.name && name && !name.startsWith('<'))
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    return fn;
  },
  frame(unitId, args) {
    const context = storage.getStore(),
      linked = context?.pending?.calleeUnit === unitId;
    const parent = linked ? context.frame : null;
    return {
      id: randomUUID(),
      traceId: parent?.traceId || randomUUID(),
      unitId,
      parent,
      call: linked ? context.pending : null,
      args,
    };
  },
  run(frame, callback) {
    return storage.run({ frame, pending: null }, () => {
      emit('enter', frame, { callId: frame.call?.id || null });
      if (frame.call) {
        frame.call.entered = frame;
        for (const [index, item] of frame.args.entries())
          binding(
            frame,
            frame.call.arguments.get(index),
            item.id,
            frame.parent?.id,
            frame.id,
            frame.call.id,
          );
      }
      for (const item of frame.args)
        emit('value', frame, { factId: item.id, ...fingerprint(item.value) });
      const done = (value) => {
        emit('exit', frame);
        return value;
      };
      const fail = (error) => {
        emit('throw', frame, {
          ...fingerprint(error),
          errorName: error?.name || '',
          errorMessage: typeof error?.message === 'string' ? error.message : '',
        });
        throw error;
      };
      try {
        const value = callback();
        if (value instanceof Promise) return value.then(done, fail);
        return done(value);
      } catch (error) {
        return fail(error);
      }
    });
  },
  invoke(frame, callId, fn, receiver, args, construct = false) {
    const call = calls.get(callId),
      calleeUnit = registered.get(fn);
    const pending = {
      id: callId,
      calleeUnit,
      arguments: new Map(args.map((argument, index) => [index, argument.id])),
    };
    emit('call', frame, { callId, targetUnitId: calleeUnit || null });
    const finish = (value) => {
      if (pending.entered?.returnId && call?.resultId)
        binding(
          frame,
          pending.entered.returnId,
          call.resultId,
          pending.entered.id,
          frame.id,
          callId,
        );
      if (call?.resultId)
        emit('value', frame, {
          factId: call.resultId,
          ...fingerprint(value),
          fields: observedFields(frame, 'value', value, call.resultId),
        });
      return value;
    };
    return storage.run({ frame, pending }, () => {
      const value = construct
        ? Reflect.construct(
            fn,
            args.map((argument) => argument.value),
          )
        : Reflect.apply(
            fn,
            receiver,
            args.map((argument) => argument.value),
          );
      return value instanceof Promise ? value.then(finish) : finish(value);
    });
  },
  returned(frame, factId, value) {
    frame.returnId = factId;
    const capture = (result) => {
      emit('return', frame, {
        factId,
        ...fingerprint(result),
        fields: observedFields(frame, 'return', result, factId),
      });
      return result;
    };
    return value instanceof Promise ? value.then(capture) : capture(value);
  },
  value(frame, factId, value) {
    emit('value', frame, {
      factId,
      ...fingerprint(value),
      fields: observedFields(frame, 'value', value, factId),
    });
    return value;
  },
  branch(frame, pointId, value) {
    emit('branch', frame, { pointId, decision: Boolean(value), ...fingerprint(value) });
    return value;
  },
  point(frame, pointId, value) {
    emit('point', frame, { pointId });
    return value;
  },
});
Object.defineProperty(globalThis, Symbol.for('product-blueprint.runtime'), {
  value: probe,
  configurable: false,
});
