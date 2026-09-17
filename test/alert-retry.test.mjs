import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

for (const miles of [8, 17, 30, 55]) {
  test(`retry a failed alert at ${miles} miles without new strikes`, async (t) => {
    const RealDate = Date;
    let clock = RealDate.now();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    t.after(() => { globalThis.Date = RealDate; });
    t.mock.method(console, "log", () => {});

    const kv = new Map([
      ["monitor_state", JSON.stringify({
        tracking_enabled: true,
        latitude: 10,
        longitude: 20,
        garmin_link: "https://messenger.garmin.com/web/reply/test"
      })],
      ["garmin_send_reply_action_id", "a".repeat(40)]
    ]);
    const env = { LIGHTNING_STATE: {
      async get(key, options) {
        const value = kv.get(key);
        return value == null ? null : options?.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) { kv.set(key, value); }
    } };
    const state = () => JSON.parse(kv.get("monitor_state"));
    let posts = 0;
    let weatherCalls = 0;
    let fail = true;
    let quiet = false;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).startsWith("https://data.api.xweather.com/")) {
        weatherCalls++;
        return Response.json({ success: true, response: quiet ? [] :
          Array.from({ length: 3 }, (_, i) => ({
            id: `strike-${i}`,
            loc: { lat: 10.1, long: 20.1 },
            age: 60,
            relativeTo: { distanceMI: miles, bearing: 45 }
          }))
        });
      }
      assert.equal(String(url), "https://messenger.garmin.com/web/reply/test");
      if (options?.method === "POST") {
        posts++;
        return new Response(fail ? "unavailable" : "accepted", { status: fail ? 503 : 200 });
      }
      return new Response("<html></html>");
    });
    async function tick() {
      let pending;
      await worker.scheduled({}, env, { waitUntil(promise) { pending = promise; } });
      await pending;
      assert.equal(state().last_scheduler_error, undefined);
    }

    await tick();
    assert.equal(state().last_lightning_alert_success, false);
    assert.equal(posts, 1);
    await tick();
    assert.equal(weatherCalls, 1, "normal cadence prevents an immediate retry");
    assert.equal(posts, 1);

    clock += 120001;
    fail = false;
    await tick();
    assert.equal(state().last_new_strike_count, 0);
    assert.equal(posts, 2, "unchanged strikes are retried after a send failure");
    assert.equal(state().last_lightning_alert_success, true);
    assert.equal(state().last_lightning_alert_reason, "retry_failed_alert");

    clock += 120001;
    await tick();
    assert.equal(posts, 2, "success restores normal duplicate suppression");

    // A failed retry must still honor the no-lightning and tracking-off guards.
    await env.LIGHTNING_STATE.put("monitor_state", JSON.stringify({
      ...state(), last_lightning_alert_success: false, next_check_at: null
    }));
    quiet = true;
    await tick();
    assert.equal(state().last_lightning_alert_decision, "no_lightning");
    assert.equal(posts, 2);
    await env.LIGHTNING_STATE.put("monitor_state", JSON.stringify({
      ...state(), tracking_enabled: false, next_check_at: null
    }));
    quiet = false;
    const callsBeforeStop = weatherCalls;
    await tick();
    assert.equal(weatherCalls, callsBeforeStop);
    assert.equal(posts, 2);
  });
}
