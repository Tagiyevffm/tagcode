// Example TagCode plugin (ESM).
//
// Enable it by adding the plugin name to plugins.enabled and the directory to
// plugins.directories, for example:
//
// {
//   "plugins": {
//     "directories": ["./examples/plugins/hello-world"],
//     "enabled": ["hello-world"]
//   }
// }
import { z } from "zod";

export default function activate(api) {
  api.registerTool({
    name: "greet",
    description: "Return a friendly greeting. Useful for verifying plugin loading.",
    permission: "read",
    parameters: z.object({ name: z.string().min(1).optional() }),
    execute: async (input) => ({
      ok: true,
      output: `Hello, ${input.name ?? "developer"}! The hello-world plugin is active.`,
    }),
  });

  api.registerCommand({
    name: "hello",
    description: "Print a greeting from the hello-world plugin",
    usage: "/plugin:hello-world:hello [name]",
    handler: (args) => `Hello, ${args[0] ?? "developer"}!`,
  });

  api.on("session_start", ({ sessionId }) => {
    api.log("info", `hello-world loaded for session ${sessionId}`);
  });
}
