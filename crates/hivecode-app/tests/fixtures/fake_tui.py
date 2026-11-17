#!/usr/bin/env python3
"""A stand-in for hivetui in tests: connects to HIVECODE_IPC, plays FAKE_TUI_STEPS, logs what it receives.

Steps: {"until": type[, "where": {field: value}]} reads until such a message arrives;
       {"send": {...}} writes a TuiMessage; {"approve": true|false} answers the next approval request.
"""
import json
import os
import socket

path = os.environ["HIVECODE_IPC"]
steps = json.loads(os.environ["FAKE_TUI_STEPS"])
log_path = os.environ["FAKE_TUI_LOG"]
sock = socket.socket(socket.AF_UNIX)
sock.settimeout(30)
sock.connect(path)
reader = sock.makefile("r", encoding="utf-8")
log = []


def save():
    # Written aside and renamed: the reader must never see a half-written log.
    with open(log_path + ".tmp", "w") as out:
        json.dump(log, out)
    os.replace(log_path + ".tmp", log_path)


def read_until(kind, where=None):
    while True:
        line = reader.readline()
        if not line:
            raise SystemExit("socket closed while waiting for " + kind)
        message = json.loads(line)
        log.append(message)
        save()
        if message["type"] != kind:
            continue
        if where and any(message["payload"].get(k) != v for k, v in where.items()):
            continue
        return message


def send(value):
    sock.sendall((json.dumps(value) + "\n").encode())


for step in steps:
    if "until" in step:
        read_until(step["until"], step.get("where"))
    elif "send" in step:
        send(step["send"])
    elif "approve" in step:
        request = read_until("tool_approval_request")
        send({"type": "tool_approval_response", "request_id": request["payload"]["request_id"], "approve": step["approve"]})
save()
