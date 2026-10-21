import { expect, test } from "bun:test"
import { frameContains, startSession, waitForFrame } from "./harness"

test("colony shows real instances, concurrent tools, separate output and handoffs", async () => {
  const s = await startSession("auto", {cols:160,rows:45,workers:["bee","builder","builder#2","verifier"]})
  try {
    s.type("1")
    s.ipc.send({type:"task_update",task_id:"colony-task",status:"running"})
    for (const [id,to] of [["one","builder"],["two","builder#2"]]) {
      s.ipc.send({type:"swarm_collaboration",event_id:id,delegation_id:id,task_id:"colony-task",session_id:s.sessionId,
        from:"bee",to,kind:"delegation",summary:`Implement ${to}`,at:Date.now()})
    }
    for (const [id,tool] of [["read-two","fs_read"],["run-two","shell_executor"]]) {
      s.ipc.send({type:"tool_call",task_id:"colony-task",agent:"builder#2",tool,call_id:id,args_summary:"src/auth.ts",bee_state:"reading",at:Date.now()})
    }
    let frame = await waitForFrame(s.iter,f => frameContains(f,"@BUILDER#2") && frameContains(f,"(+1)"))
    expect(frameContains(frame,"@BUILDER ·")).toBe(true)
    expect(frameContains(frame,"delega")).toBe(true)
    s.ipc.send({type:"thought_chunk",task_id:"colony-task",coordinator:"builder#2",phase:"thinking",content:"REASONING_DETAIL_SENTINEL"})
    s.ipc.send({type:"narrative_chunk",task_id:"colony-task",coordinator:"builder#2",phase:"narrative",content:"NARRATION_SENTINEL"})
    s.type("\x1b[1;3B\x1b[1;3B\x1b[1;3B")
    frame = await waitForFrame(s.iter,f => frameContains(f,"Instancia: builder#2") && frameContains(f,"NARRATION_SENTINEL") && frameContains(f,"Razonamiento"))
    expect(frameContains(frame,"fs_read")).toBe(true)
    expect(frameContains(frame,"shell_executor")).toBe(true)
    expect(frameContains(frame,"REASONING_DETAIL_SENTINEL")).toBe(false)
    s.type("/lupa\r")
    frame = await waitForFrame(s.iter,f => frameContains(f,"REASONING_DETAIL_SENTINEL"))
    expect(frameContains(frame,"NARRATION_SENTINEL")).toBe(true)
    s.ipc.send({type:"tool_done",task_id:"colony-task",agent:"builder#2",tool:"fs_read",call_id:"read-two",ok:false,duration_ms:23,result_summary:"READ_ERROR_SENTINEL",at:Date.now()})
    await waitForFrame(s.iter,f => frameContains(f,"READ_ERROR_SENTINEL"))
    s.ipc.send({type:"swarm_collaboration",event_id:"end",delegation_id:"two",task_id:"colony-task",from:"bee",to:"builder#2",kind:"handoff",summary:"HANDOFF_SENTINEL",at:Date.now()})
    frame = await waitForFrame(s.iter,f => frameContains(f,"HANDOFF_SENTINEL") && frameContains(f,"terminado"))
    expect(frameContains(frame,"Activa:")).toBe(false)
    s.type("\r")
    await waitForFrame(s.iter,f => f.tab === "codigo")
    expect(s.ipc.received.some(m => m.type === "submit")).toBe(false)
  } finally {s.dispose()}
},15000)

test("scroll pauses follow until returning to live; old task events stay outside the scene", async () => {
  const s = await startSession("auto",{cols:120,rows:30,workers:["bee","builder"]})
  try {
    s.type("1")
    s.ipc.send({type:"task_update",task_id:"current",status:"running"})
    s.ipc.send({type:"worker_update",task_id:"current",worker:"builder",phase:"work",status:"running"})
    for (let n=0;n<20;n++) {
      s.ipc.send({type:"narrative_chunk",task_id:"current",coordinator:"builder",phase:"narrative",content:`EVENT_${n}\n`})
    }
    s.type("\x1b[1;3B")
    await waitForFrame(s.iter,f => frameContains(f,"Tarea:") && frameContains(f,"EVENT_19"))
    s.type("\x1b[5~")
    const paused = await waitForFrame(s.iter,f => frameContains(f,"volver al directo"))
    expect(frameContains(paused,"EVENT_19")).toBe(false)
    s.ipc.send({type:"narrative_chunk",task_id:"current",coordinator:"builder",phase:"narrative",content:"NEWEST_SENTINEL\n"})
    const stillPaused = await waitForFrame(s.iter,f => frameContains(f,"volver al directo") && !frameContains(f,"EVENT_19"))
    expect(frameContains(stillPaused,"NEWEST_SENTINEL")).toBe(false)
    s.type("/directo\r")
    await waitForFrame(s.iter,f => frameContains(f,"NEWEST_SENTINEL") && frameContains(f,"EN VIVO"))
    s.ipc.send({type:"narrative_chunk",task_id:"old",coordinator:"builder",phase:"narrative",content:"STALE_SENTINEL"})
    s.ipc.send({type:"narrative_chunk",task_id:"current",coordinator:"builder",phase:"narrative",content:"CURRENT_SENTINEL"})
    const current = await waitForFrame(s.iter,f => frameContains(f,"CURRENT_SENTINEL"))
    expect(frameContains(current,"STALE_SENTINEL")).toBe(false)
  } finally {s.dispose()}
},15000)
