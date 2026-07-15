#!/usr/bin/env npx tsx
import { runReview } from "../packages/review-agent/src/cli.js";
import { runFix } from "../packages/fix-agent/src/cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  let exitCode: number;

  switch (command) {
    case "review":
      exitCode = await runReview(commandArgs);
      break;
    case "fix":
      exitCode = await runFix(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: git-agents <review|fix> [options]");
      exitCode = 1;
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
