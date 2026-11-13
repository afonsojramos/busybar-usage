#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pushFeed } from "./bar.ts";
import { Collector } from "./collector.ts";
import { systemContext } from "./context.ts";
import { providers } from "./providers/index.ts";

const HELP = `Usage: busybar-usage [options]

Reads the AI subscriptions this computer is signed in to and sends their usage
to the AI Usage app on a BUSY Bar, every minute until stopped.

Options:
  --host <address>       the bar's address (default: 10.0.4.20, the bar over USB;
                         BUSYBAR_HOST also sets it)
  --interval <seconds>   how often to update (default: 60, minimum: 30)
  --providers <ids>      comma-separated providers to read (default: all)
  --once                 update once and exit
  --print                print the usage instead of sending it to the bar
  -h, --help             show this help

Set BUSYBAR_HTTP_PASSWORD if the bar has an HTTP access password.
Providers: ${providers.map((provider) => provider.id).join(", ")}`;

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

function options() {
  const args = process.argv.slice(2);
  // Package runners such as `nub run start -- --once` pass the "--" separator through.
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string" },
      interval: { type: "string", default: "60" },
      providers: { type: "string" },
      once: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const interval = Number(values.interval);
  if (!Number.isInteger(interval) || interval < 30) throw new Error("--interval must be a whole number of seconds, at least 30");
  const wanted = values.providers?.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = wanted?.filter((id) => !providers.some((provider) => provider.id === id)) ?? [];
  if (unknown.length > 0) throw new Error(`unknown provider: ${unknown.join(", ")}`);
  return {
    host: values.host ?? process.env.BUSYBAR_HOST ?? "10.0.4.20",
    password: process.env.BUSYBAR_HTTP_PASSWORD || undefined,
    interval,
    selected: wanted ? providers.filter((provider) => wanted.includes(provider.id)) : providers,
    once: values.once,
    print: values.print,
  };
}

async function main(): Promise<void> {
  const settings = options();
  const collector = new Collector(settings.selected, systemContext(), log);
  let pushStatus = "";

  const tick = async () => {
    const feed = await collector.collect();
    if (settings.print) {
      console.log(JSON.stringify(feed, null, 2));
      return;
    }
    try {
      await pushFeed(feed, settings);
      if (pushStatus !== "ok") log(`sent usage for ${feed.accounts.length} account(s) to the bar at ${settings.host}`);
      pushStatus = "ok";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pushStatus !== message) log(`could not reach the bar at ${settings.host}: ${message}`);
      pushStatus = message;
      if (settings.once) process.exitCode = 1;
    }
  };

  if (settings.once) {
    await tick();
    return;
  }
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // The next update waits for this one, so slow providers never overlap.
  for (;;) {
    await tick().catch((error) => log(error instanceof Error ? error.message : String(error)));
    await new Promise((resolve) => setTimeout(resolve, settings.interval * 1000));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
