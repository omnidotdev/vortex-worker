import { describe, expect, it } from "bun:test"
import template from "./beacon-conversation-actor.json"

describe("beacon-conversation-actor template", () => {
  it("uses temporal executor for durable conversation state", () => {
    expect(template.executor).toBe("temporal")
  })

  it("starts with an event trigger on beacon.conversation.started", () => {
    const trigger = template.steps.find((s: { type: string }) => s.type === "trigger")
    expect(trigger).toBeDefined()
  })

  it("has a state_wait step for message signal handling", () => {
    expect(template.steps.some((s: { type: string }) => s.type === "state_wait")).toBe(true)
  })

  it("has an llm step for response generation", () => {
    expect(template.steps.some((s: { type: string }) => s.type === "llm")).toBe(true)
  })
})
