import { defineTool } from "eve/tools"
import { z } from "zod"
import { ASK_CAPS, askFounder, subjectOf } from "../lib/work/attempts.js"

const option = z.object({
  id: z
    .string()
    .min(1)
    .max(ASK_CAPS.optionId)
    .describe("A short id for this option, unique among the options."),
  label: z
    .string()
    .min(1)
    .max(ASK_CAPS.optionLabel)
    .describe("What the founder reads on the button."),
  detail: z.string().min(1).max(ASK_CAPS.optionDetail).optional(),
})

const inputSchema = z
  .object({
    prompt: z
      .string()
      .max(ASK_CAPS.prompt)
      .refine((text) => text.trim() !== "", "The question must not be blank.")
      .describe("The question, written so a founder can answer it without the thread."),
    options: z
      .array(option)
      .min(2)
      .max(ASK_CAPS.options)
      .describe("Two to five answers the founder picks from."),
    defaultOptionId: z
      .string()
      .max(ASK_CAPS.optionId)
      .optional()
      .describe("The option you recommend. It is only shown on a button: nothing applies it."),
  })
  .superRefine((input, ctx) => {
    const ids = input.options.map((o) => o.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Option ids must be unique.", path: ["options"] })
    }
    if (input.defaultOptionId !== undefined && !ids.includes(input.defaultOptionId)) {
      ctx.addIssue({
        code: "custom",
        message: "defaultOptionId must be one of the options.",
        path: ["defaultOptionId"],
      })
    }
  })

/**
 * Puts a question to a founder and ends the attempt that is asking.
 *
 * @remarks
 * An ordinary tool: it writes to hq through the `askFounder` step of `lib/work/attempts.ts` and
 * touches nothing else. The question waits in hq until a founder answers it; the default option is
 * only a recommendation and is never applied on a timer, and an answer starts nothing by itself.
 * It resolves its work item through `subjectOf`, exactly as the stations do, so a run with no
 * recorded item (a summary-only run, an unstamped session, a mention) writes nothing and the
 * result says so. The question's text is the model's and untrusted: hq stores it capped and the
 * screens render it as text.
 */
export default defineTool({
  description:
    "Ask a founder a question and wait for their answer in hq: use it when you are blocked on " +
    "something only a person can decide, such as a choice between approaches, missing access, or " +
    "an ambiguous requirement. Give the question and two to five options, and say which one you " +
    "recommend with defaultOptionId (it is only a suggestion on a button; nothing is decided " +
    "until a founder answers). After it returns, say in your reply what you asked and stop: do " +
    "not guess an answer and do not carry on. The result says whether the question was recorded; " +
    "when it was not, put the question in your reply instead.",
  async execute(input, ctx) {
    const result = await askFounder({
      sessionId: ctx.session.id,
      subject: subjectOf(ctx.session.auth.current),
      prompt: input.prompt,
      options: input.options,
      ...(input.defaultOptionId === undefined ? {} : { defaultOptionId: input.defaultOptionId }),
    })
    if (!result.recorded) {
      return {
        recorded: false,
        message:
          "No question was recorded for a founder: this run has no work item in hq, or hq could " +
          "not take it. Put the question in your reply and stop.",
      }
    }
    return {
      recorded: true,
      message:
        "The question is waiting for a founder in hq. Say in your reply what you asked and stop: " +
        "do not guess an answer and do not run another station.",
    }
  },
  inputSchema,
  outputSchema: z.object({ message: z.string(), recorded: z.boolean() }),
})
