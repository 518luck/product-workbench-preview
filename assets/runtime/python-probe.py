"""CLI-owned probe. Ordinary output is never read as evidence."""
import contextvars
import functools
import inspect
import json
import math
import os
import threading
import uuid

with open(os.environ["PRODUCT_BLUEPRINT_PROBE_CONFIG"], encoding="utf-8") as stream:
    config = json.load(stream)
units = {unit["id"]: unit for unit in config["units"]}
calls = {call["id"]: call for unit in config["units"] for call in unit["calls"]}
context = contextvars.ContextVar("product_blueprint_frame", default=None)
registered = {}
sequence, lock = 0, threading.RLock()

def fingerprint(value):
    kind = "null" if value is None else "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "string" if isinstance(value, str) else "object"
    if kind == "object": return {"valueType": kind, "objectId": str(id(value))}
    # The collector hashes JSON scalars with the shared protocol. Python's 3.0
    # and JSON/JavaScript's 3 must not produce different evidence fingerprints.
    if kind == "number" and isinstance(value, float) and not math.isfinite(value):
        return {"valueType": kind}
    return {"valueType": kind, "rawScalar": value}

def emit(kind, frame, **extra):
    global sequence
    with lock:
        sequence += 1
        parent = frame.get("parent")
        event = dict(runId=config["runId"], seq=sequence, kind=kind, traceId=frame["traceId"], spanId=frame["id"], unitId=frame["unitId"], parentSpanId=parent["id"] if parent else None, parentUnitId=parent["unitId"] if parent else None, **extra)
        os.write(3, (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode())

def binding(frame, source, target, source_span, target_span, call):
    if source and target: emit("binding", frame, sourceId=source, targetId=target, sourceSpanId=source_span, targetSpanId=target_span, callId=call)

def register(unit_id):
    def decorate(fn):
        signature = inspect.signature(fn)
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            previous = context.get()
            pending = previous.get("pending") if previous else None
            linked = pending and pending["target"] == unit_id
            parent = previous["frame"] if linked else None
            frame = dict(id=str(uuid.uuid4()), traceId=parent["traceId"] if parent else str(uuid.uuid4()), unitId=unit_id, parent=parent)
            if linked: pending["entered"] = frame
            token = context.set(dict(frame=frame, pending=None))
            try:
                emit("enter", frame, callId=pending["id"] if linked else None)
                bound = signature.bind(*args, **kwargs); bound.apply_defaults()
                for index, (name, value) in enumerate(bound.arguments.items()):
                    if index >= len(units[unit_id]["parameters"]): break
                    fact = units[unit_id]["parameters"][index]
                    if linked and index < len(pending["arguments"]): binding(frame, pending["arguments"][index], fact, parent["id"], frame["id"], pending["id"])
                    emit("value", frame, factId=fact, **fingerprint(value))
                result = fn(*args, **kwargs)
                emit("exit", frame)
                return result
            except BaseException as error:
                emit("throw", frame, errorName=type(error).__name__, **fingerprint(error))
                raise
            finally:
                context.reset(token)
        registered[wrapped] = unit_id
        return wrapped
    return decorate

def invoke(unit_id, call_id, fn, arguments):
    current = context.get()
    if not current or current["frame"]["unitId"] != unit_id: return fn(*[arg["value"] for arg in arguments])
    frame = current["frame"]
    pending = dict(id=call_id, target=registered.get(fn), arguments=[arg["id"] for arg in arguments])
    token = context.set(dict(frame=frame, pending=pending))
    emit("call", frame, callId=call_id, targetUnitId=pending["target"])
    try:
        result = fn(*[arg["value"] for arg in arguments])
        entered, call = pending.get("entered"), calls[call_id]
        if entered and entered.get("returnId"): binding(frame, entered["returnId"], call["resultId"], entered["id"], frame["id"], call_id)
        emit("value", frame, factId=call["resultId"], **fingerprint(result))
        return result
    finally:
        context.reset(token)

def returned(unit_id, fact_id, value):
    current = context.get()
    if current and current["frame"]["unitId"] == unit_id:
        frame = current["frame"]; frame["returnId"] = fact_id
        emit("return", frame, factId=fact_id, **fingerprint(value))
    return value

def branch(unit_id, point_id, value):
    current = context.get()
    if current and current["frame"]["unitId"] == unit_id: emit("branch", current["frame"], pointId=point_id, decision=bool(value), **fingerprint(bool(value)))
    return value

def point(unit_id, point_id, value):
    current=context.get()
    if current and current["frame"]["unitId"]==unit_id: emit("point",current["frame"],pointId=point_id)
    return value
