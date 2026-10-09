import { test, expect } from "bun:test";
import { MCPClientManager } from "../../packages/mcp/src/manager";

function harness() {
 let connects = 0, closes = 0;
 const factories = {
  transport: () => ({ close: async () => {} }) as any,
  client: () => ({
   connect: async () => { connects++; await new Promise(resolve => setTimeout(resolve, 5)); },
   close: async () => { closes++; },
   listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }), listPrompts: async () => ({ prompts: [] }),
  }) as any,
 };
 const manager = new MCPClientManager({ servers: { demo: { transport: "stdio", command: "demo", env: { A: "secret", B: "secret2" } } } }, factories);
 return { manager, counts: () => ({ connects, closes }) };
}

test("shared connect and normalized config do not duplicate clients", async () => {
 const { manager, counts } = harness();
 await manager.initialize(); await manager.disconnectServer("demo");
 await Promise.all([manager.connectServer("demo"), manager.connectServer("demo")]);
 expect(counts().connects).toBe(2);
 await manager.updateConfig({ servers: { demo: { env: { B: "secret2", A: "secret" }, command: "demo", transport: "stdio" } } });
 expect(counts().connects).toBe(2);
 expect(JSON.stringify(manager.getServerDetails("demo"))).not.toContain("secret");
 await manager.updateConfig({ servers: { demo: { transport: "stdio", command: "changed" } } });
 expect(counts().connects).toBe(3);
 await manager.disconnectAll();
});

test("disable during connect cannot resurrect server", async () => {
 const { manager } = harness();
 const first = manager.initialize();
 await manager.updateConfig({ servers: {} });
 await first;
 expect(manager.getServerStatus("demo")).toBeUndefined();
 await manager.disconnectAll();
});
