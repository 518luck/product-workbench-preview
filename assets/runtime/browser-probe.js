// Injected by the CLI proxy before project scripts. Request roots use separate traces.
((config) => {
  const registered = new WeakMap(),
    calls = new Map(config.units.flatMap((unit) => unit.calls.map((call) => [call.id, call])));
  const fetchEvent = globalThis.fetch.bind(globalThis),
    queue = [];
  let context = null,
    sequence = 0;
  const fingerprint = (value) => {
    const type = value === null ? 'null' : typeof value;
    return ['null', 'string', 'boolean', 'number'].includes(type)
      ? { rawScalar: value, valueType: type }
      : { valueType: type };
  };
  const emit = (kind, frame, extra = {}) => {
    queue.push({
      runId: config.runId,
      seq: ++sequence,
      kind,
      unitId: frame.unitId,
      traceId: frame.traceId,
      spanId: frame.id,
      parentSpanId: frame.parent?.id || null,
      parentUnitId: frame.parent?.unitId || null,
      ...extra,
    });
  };
  const flush = async () => {
    if (!queue.length) return;
    const events = queue.splice(0);
    await fetchEvent('/__blueprint/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blueprint-run': config.token },
      body: JSON.stringify(events),
      keepalive: true,
    });
  };
  const timer = setInterval(() => flush().catch(() => {}), 100);
  const binding = (frame, sourceId, targetId, sourceSpanId, targetSpanId, callId) => {
    if (sourceId && targetId)
      emit('binding', frame, { sourceId, targetId, sourceSpanId, targetSpanId, callId });
  };
  const probe = Object.freeze({
    register(unitId, fn, name) {
      registered.set(fn, unitId);
      if (!fn.name && name && !name.startsWith('<'))
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
      return fn;
    },
    frame(unitId, args) {
      const linked = context?.pending?.calleeUnit === unitId,
        parent = linked ? context.frame : null;
      return {
        id: crypto.randomUUID(),
        traceId: parent?.traceId || crypto.randomUUID(),
        unitId,
        parent,
        call: linked ? context.pending : null,
        args,
      };
    },
    run(frame, callback) {
      const previous = context;
      context = { frame, pending: null };
      emit('enter', frame, { callId: frame.call?.id || null });
      if (frame.call) {
        frame.call.entered = frame;
        frame.args.forEach((arg, index) =>
          binding(
            frame,
            frame.call.arguments[index],
            arg.id,
            frame.parent.id,
            frame.id,
            frame.call.id,
          ),
        );
      }
      for (const arg of frame.args)
        emit('value', frame, { factId: arg.id, ...fingerprint(arg.value) });
      const done = (value) => {
          emit('exit', frame);
          return value;
        },
        fail = (error) => {
          emit('throw', frame, { errorName: error?.name || '', ...fingerprint(error) });
          throw error;
        };
      try {
        const value = callback();
        return value instanceof Promise ? value.then(done, fail) : done(value);
      } catch (error) {
        return fail(error);
      } finally {
        context = previous;
      }
    },
    invoke(frame, callId, fn, receiver, args, construct = false) {
      const previous = context,
        pending = {
          id: callId,
          calleeUnit: registered.get(fn),
          arguments: args.map((arg) => arg.id),
        };
      context = { frame, pending };
      emit('call', frame, { callId, targetUnitId: pending.calleeUnit || null });
      const finish = (value) => {
        const call = calls.get(callId);
        if (pending.entered?.returnId && call?.resultId)
          binding(
            frame,
            pending.entered.returnId,
            call.resultId,
            pending.entered.id,
            frame.id,
            callId,
          );
        if (call?.resultId) emit('value', frame, { factId: call.resultId, ...fingerprint(value) });
        return value;
      };
      try {
        const value = construct
          ? Reflect.construct(
              fn,
              args.map((arg) => arg.value),
            )
          : Reflect.apply(
              fn,
              receiver,
              args.map((arg) => arg.value),
            );
        return value instanceof Promise ? value.then(finish) : finish(value);
      } finally {
        context = previous;
      }
    },
    returned(frame, factId, value) {
      frame.returnId = factId;
      emit('return', frame, { factId, ...fingerprint(value) });
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
    value(frame, factId, value) {
      emit('value', frame, { factId, ...fingerprint(value) });
      return value;
    },
  });
  Object.defineProperty(globalThis, Symbol.for('product-blueprint.runtime'), { value: probe });
  Object.defineProperty(globalThis, Symbol.for('product-blueprint.browser-finish'), {
    value: async () => {
      clearInterval(timer);
      await flush();
      return fetchEvent('/__blueprint/finish', {
        method: 'POST',
        headers: { 'x-blueprint-run': config.token },
      });
    },
  });
  const controls = () => {
    const button = document.createElement('button');
    button.textContent = '结束本次流程采集';
    button.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:10px';
    button.addEventListener('click', () =>
      globalThis[Symbol.for('product-blueprint.browser-finish')](),
    );
    document.body.append(button);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', controls, { once: true });
  else controls();
})(__PRODUCT_BLUEPRINT_CONFIG__);
