/** @intent Minimal agent: one flow, one step, one response.
 *  @teaches createAgent, GeminiProvider, Flow, Step, respond
 *  @readAfter docs/start/02-first-agent.md */
import { createAgent, GeminiProvider } from "../src";

if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY");

const agent = createAgent({
    name: "Greeter",
    provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: "models/gemini-2.5-flash" }),
    schema: { type: "object", properties: { name: { type: "string" } } },
    flows: [{
        title: "Greet",
        requiredFields: ["name"],
        steps: [{ id: "ask_name", prompt: "What's your name?", collect: ["name"] }],
    }],
});

const response = await agent.respond({ history: [{ role: "user", content: "Hi, I'm Alice" }] });
console.log(response.message);
