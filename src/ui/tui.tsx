import { render } from "ink";
import type { SessionController } from "../controller.js";
import { App } from "./App.js";

export type RunTuiOptions = {
  controller: SessionController;
  resumeLatest?: boolean;
};

/**
 * Mount the interactive terminal UI. The controller is initialized inside the
 * React tree so the first frame appears immediately, including warnings from
 * slower subsystems such as MCP servers.
 */
export async function runTui({ controller, resumeLatest }: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "TagCode's interactive UI needs a TTY. Use `tgc run <prompt>` for non-interactive use.\n",
    );
    await controller.dispose();
    return 1;
  }

  let instance: ReturnType<typeof render> | undefined;
  const clearScreen = (): void => {
    try {
      instance?.clear();
    } catch {
      // The instance may not be mounted yet.
    }
    process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
  };

  try {
    instance = render(
      <App controller={controller} resumeLatest={resumeLatest} clearScreen={clearScreen} />,
      {
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 30,
      },
    );
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    process.stderr.write(`TagCode UI failed: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await controller.dispose();
  }
}
