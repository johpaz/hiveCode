"""Minimal stdio MCP server for tests. Never contacts anything. Modes: normal, exit, error."""
import json
import os
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
receipt = sys.argv[2] if len(sys.argv) > 2 else None


def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


for raw in sys.stdin:
    request = json.loads(raw)
    method, id = request.get("method"), request.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": id, "result": {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}}, "serverInfo": {"name": "peer", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": id, "result": {"tools": [
            {"name": "add", "description": "Add two integers",
             "inputSchema": {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
                             "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                             "required": ["a", "b"], "additionalProperties": False}},
            {"name": "bad name!", "description": "cannot be a wire name",
             "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        args = request["params"]["arguments"]
        if receipt:
            with open(receipt, "a") as out:
                out.write(json.dumps({"name": request["params"]["name"], "arguments": args}) + "\n")
        if mode == "exit":
            os._exit(0)
        if mode == "error":
            send({"jsonrpc": "2.0", "id": id, "result": {"isError": True,
                  "content": [{"type": "text", "text": "no se pudo"}]}})
        else:
            send({"jsonrpc": "2.0", "id": id, "result": {
                "content": [{"type": "text", "text": str(args["a"] + args["b"])}]}})
