import assert from "node:assert/strict";
import { test } from "node:test";
import { jetbrains, parseJetBrainsXML, parseJetBrainsLog } from "../src/providers/jetbrains.ts";
import { HttpError, NotConfigured } from "../src/providers/types.ts";
import { fakeContext, NOW } from "./helpers.ts";

function xml(quota: unknown, refill: unknown = { next: "2027-01-01T00:00:00Z", tariff: { duration: "PT720H" } }) {
  const escape = (value: unknown) => JSON.stringify(value).replaceAll('"', "&quot;");
  return `<application><component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="${escape(quota)}" /><option value="${escape(refill)}" name="nextRefill" /></component></application>`;
}
const fixture = { type: "Available", current: "50000", maximum: "2000000", tariffQuota: { current: "25000", maximum: "100000", available: "75000" }, topUpQuota: { maximum: "1000000", available: "1000000" } };
test("JetBrains: parses tariff and topup independently", async () => {
  const context = fakeContext({ dirs: { "/home/test/.config/JetBrains": ["DataGrip2026.2"] }, files: {
    "/home/test/.config/JetBrains/DataGrip2026.2/options/AIAssistantQuotaManager2.xml": xml(fixture),
  } });
  const [account] = await jetbrains.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.windows[0].minutes, 43200);
  assert.equal(account.windows[1].value, "10.00 cr");
});
test("JetBrains: missing IDE", async () => { await assert.rejects(jetbrains.fetch(fakeContext({})), NotConfigured); });
test("JetBrains: invalid local quota is sanitized", async () => {
  await assert.rejects(jetbrains.fetch(fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { jetbrains: { jetbrainsIDEBasePath: "/ide" } } }),
    "/ide/options/AIAssistantQuotaManager2.xml": "secret malformed",
  } })), HttpError);
});
test("JetBrains: legacy flat quota", () => {
  assert.equal(parseJetBrainsXML(xml({ current: "50", maximum: "100" }), NOW)?.[0].used_percent, 50);
  assert.equal(parseJetBrainsXML(xml({ current: "50", maximum: "0" }), NOW), null);
});
test("JetBrains: latest log state and refill", () => {
  const log = "2026-11-13 12:00:00,000 INFO QuotaManager2Impl - New quota state is: Available(current=50, maximum=100, until=2027-01-01T00:00:00Z, tariffQuota=QuotaDetails(current=25, maximum=100, available=75))\n"
    + "2026-11-13 12:00:00,001 INFO QuotaManager2Impl - New quota refill state is: Known(next=2027-01-01T00:00:00Z, tariff=QuotaRefillInfoTariff(amount=100, duration=30d))\n";
  assert.equal(parseJetBrainsLog(log, NOW)?.[0].used_percent, 25);
  assert.equal(parseJetBrainsLog(log.trimEnd(), NOW), null);
  assert.equal(parseJetBrainsLog(log + "2026-11-13 12:00:01,000 INFO QuotaManager2Impl - New quota state is: Unknown\n", NOW), null);
});
test("JetBrains: Junie amount envelopes", () => {
  const amount = (value: number) => ({ amount: String(value) });
  const payload = { until: (NOW + 86400) * 1000, tariffQuota: { current: amount(25), maximum: amount(100), available: amount(75) } };
  const log = `2026-11-13 12:00:00,000 INFO AiaActivationTransmitter - Received message from junie: quota_update:${JSON.stringify(payload)}\n`;
  assert.equal(parseJetBrainsLog(log, NOW)?.[0].used_percent, 25);
});

test("JetBrains: multiple XML sources require an explicit IDE without mtime support", async () => {
  const context = fakeContext({ dirs: { "/home/test/.config/JetBrains": ["DataGrip2026.2", "Rider2026.2"] }, files: {
    "/home/test/.config/JetBrains/DataGrip2026.2/options/AIAssistantQuotaManager2.xml": xml(fixture),
    "/home/test/.config/JetBrains/Rider2026.2/options/AIAssistantQuotaManager2.xml": xml(fixture),
  } });
  await assert.rejects(jetbrains.fetch(context), NotConfigured);
});
