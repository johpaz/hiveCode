import { describe, expect, test } from "bun:test"
import { parsePartialJson } from "../packages/code/src/workers/partial-json"

describe("parsePartialJson", () => {
  test("JSON completo se parsea igual", () => {
    expect(parsePartialJson('{"a":1}')).toEqual({ a: 1 })
  })
  test("cierra un string abierto", () => {
    expect(parsePartialJson('{"adr":{"title":"Usar JW')).toEqual({ adr: { title: "Usar JW" } })
  })
  test("descarta clave sin valor y coma colgante", () => {
    expect(parsePartialJson('{"adr":{"title":"X"},"phases":')).toEqual({ adr: { title: "X" } })
    expect(parsePartialJson('{"a":1,')).toEqual({ a: 1 })
  })
  test("array de fases a medias", () => {
    expect(parsePartialJson('{"phases":[{"name":"A","coordinator":"backend"},{"name":"B","coo')).toEqual({
      phases: [{ name: "A", coordinator: "backend" }, { name: "B" }],
    })
  })
  test("escape cortado y números/literales a medias", () => {
    expect(parsePartialJson('{"a":"x\\')).toEqual({ a: "x" })
    expect(parsePartialJson('{"a":1,"b":tru')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a":1,"b":-')).toEqual({ a: 1 })
  })
  test("vacío o basura devuelve undefined", () => {
    expect(parsePartialJson("")).toBeUndefined()
    expect(parsePartialJson("hola")).toBeUndefined()
  })
})

import { draftFromPartialPlanArgs } from "../packages/code/src/workers/plan-parser"

describe("draftFromPartialPlanArgs", () => {
  test("nada mostrable aún", () => {
    expect(draftFromPartialPlanArgs('{"adr":{')).toBeUndefined()
  })
  test("título parcial y luego fases con niveles", () => {
    expect(draftFromPartialPlanArgs('{"adr":{"title":"Usar JW')?.adr_title).toBe("Usar JW")
    const d = draftFromPartialPlanArgs(
      '{"adr":{"title":"JWT","context":"c"},"phases":[{"name":"API","coordinator":"backend","description":"d"},{"name":"UI","coordinator":"frontend","description":"x","dependsOn":["backend"]},{"name":"Te',
    )!
    expect(d.adr_content).toBe("c")
    expect(d.phases.map((p) => p.name)).toEqual(["API", "UI", "Te"])
    expect(d.phases[0].level).toBe(0)
    expect(d.phases[1].level).toBe(1)
  })
})
