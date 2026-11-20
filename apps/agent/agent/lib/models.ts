import { mockModel } from "eve/evals"
import { offlineMode } from "./offline/mode.js"
import { offlineResponder } from "./offline/responder.js"

// One place to change every agent's model. Ids are Vercel AI Gateway strings
// (<provider>/<model>), so routing, credentials, and fallbacks stay on the
// gateway and no provider SDK is wired in. Each agent.ts reads its entry
// through `modelFor` (model: modelFor("<role>")) instead of hardcoding a string.
//
// The chat model, the one every Slack turn runs on, is the cheap one (Haiku 5.5):
// a harder question asks a founder before a bigger model runs (request_bigger_model).
// The reviewer station stays on a different vendor than the implementer.
export const MODELS = {
  analyst: "openai/gpt-6.1-terra-fast",
  classifier: "openai/gpt-6.1-terra-fast",
  decision: "google/gemini-decision-1",
  implementer: "anthropic/claude-fable-5.2",
  orchestrator: "anthropic/claude-haiku-5.5",
  researcher: "anthropic/claude-opus-5.5",
  reviewer: "openai/gpt-6.1-sol-fast",
} as const

export { offlineMode }

export type FactoryModel = keyof typeof MODELS
export type FactoryAgent = Exclude<FactoryModel, "decision">

/** The model id a ledger row is recorded under for a chat turn. */
export const chatModelId = (): string => (offlineMode() ? "offline-mock" : MODELS.orchestrator)

/** The model for an agent's role: its gateway id, or a scripted model when offline. */
export function modelFor(role: FactoryModel) {
  return offlineMode() ? mockModel(offlineResponder) : MODELS[role]
}
