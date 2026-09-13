// GARMIN inREACH LIGHTNING MONITOR - Cloudflare Worker
//
// PUBLIC-REPO SAFETY:
// - Do not hard-code API credentials, email addresses, coordinates, Garmin
//   reply links, account IDs, or Cloudflare namespace IDs in this file.
// - XWEATHER_CLIENT_ID and XWEATHER_CLIENT_SECRET must be Cloudflare Secrets.
// - The public HTTP endpoint intentionally exposes only non-identifying health
//   information. Runtime GPS coordinates and Garmin reply links remain in KV.
// - This project uses Garmin's public consumer reply page, which is undocumented
//   and may change without notice.
//
// Required:
// KV binding: LIGHTNING_STATE
// Secrets: XWEATHER_CLIENT_ID, XWEATHER_CLIENT_SECRET
//
// Cron: every minute.
// Worker internally limits Xweather calls to:
// - ~5 minutes when quiet
// - ~2 minutes when lightning is active

const GARMIN_ORIGIN = "https://messenger.garmin.com";

const GARMIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

const GARMIN_ACTION_CACHE_KEY = "garmin_send_reply_action_id";
const GARMIN_ACTION_META_KEY = "garmin_send_reply_action_meta";
const STATE_KEY = "monitor_state";

const LIGHTNING_RADIUS_MILES = 60;
const QUIET_CHECK_MINUTES = 5;
const ACTIVE_CHECK_MINUTES = 2;
const CLUSTER_THRESHOLD_MILES = 12;


// =====================================================
// BASIC HELPERS
// =====================================================

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(minutes) {
  return new Date(
    Date.now() + minutes * 60_000
  ).toISOString();
}

function validLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}


function isAllowedGarminSender(fromAddress) {
  if (!fromAddress) return false;

  // Cloudflare Email Routing exposes the SMTP envelope sender here.
  // Accept garmin.com and its subdomains, e.g. inreacheml.garmin.com.
  return /@(?:[a-z0-9-]+\.)*garmin\.com$/i.test(String(fromAddress).trim());
}


function minutesSince(iso) {
  if (!iso) return Infinity;

  const t = new Date(iso).getTime();

  if (!Number.isFinite(t)) {
    return Infinity;
  }

  return Math.max(
    0,
    (Date.now() - t) / 60_000
  );
}

function formatAge(seconds) {
  if (
    seconds == null ||
    !Number.isFinite(Number(seconds))
  ) {
    return null;
  }

  const sec = Math.max(
    0,
    Number(seconds)
  );

  if (sec < 60) {
    return `${Math.round(sec)}s`;
  }

  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);

  return s
    ? `${m}m${s}s`
    : `${m}m`;
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function haversineMiles(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 3958.7613;

  const dLat =
    toRad(lat2 - lat1);

  const dLon =
    toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function initialBearing(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);

  const y =
    Math.sin(dLon) *
    Math.cos(phi2);

  const x =
    Math.cos(phi1) *
      Math.sin(phi2) -
    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(dLon);

  return (
    Math.atan2(y, x) *
      180 /
      Math.PI +
    360
  ) % 360;
}

function bearingToCompass(bearing) {
  if (!Number.isFinite(bearing)) {
    return null;
  }

  const labels = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];

  return labels[
    Math.round(bearing / 22.5) % 16
  ];
}

function circularMeanBearing(
  bearings
) {
  const clean =
    bearings.filter(
      Number.isFinite
    );

  if (!clean.length) {
    return null;
  }

  let x = 0;
  let y = 0;

  for (const b of clean) {
    const r = toRad(b);

    x += Math.sin(r);
    y += Math.cos(r);
  }

  return (
    Math.atan2(x, y) *
      180 /
      Math.PI +
    360
  ) % 360;
}


// =====================================================
// STATE HELPERS
// =====================================================

async function getState(env) {
  return (
    await env.LIGHTNING_STATE.get(
      STATE_KEY,
      { type: "json" }
    )
  ) || {};
}

async function mergeState(
  env,
  updates
) {
  const current =
    await getState(env);

  const next = {
    ...current,
    ...updates
  };

  await env.LIGHTNING_STATE.put(
    STATE_KEY,
    JSON.stringify(next)
  );

  return next;
}


// =====================================================
// GARMIN COOKIE HELPERS
// =====================================================

function collectSetCookies(response) {
  try {
    if (
      response.headers &&
      typeof response.headers.getSetCookie ===
        "function"
    ) {
      return response.headers.getSetCookie();
    }
  } catch (_) {}

  const single =
    response.headers.get(
      "set-cookie"
    );

  return single
    ? [single]
    : [];
}

function updateCookieJar(
  cookieJar,
  response
) {
  for (
    const setCookie
    of collectSetCookies(response)
  ) {
    const firstPart =
      setCookie.split(";")[0];

    const eq =
      firstPart.indexOf("=");

    if (eq === -1) {
      continue;
    }

    const name =
      firstPart
        .slice(0, eq)
        .trim();

    const value =
      firstPart
        .slice(eq + 1)
        .trim();

    if (name) {
      cookieJar[name] =
        value;
    }
  }
}

function cookieHeader(
  cookieJar
) {
  return Object.entries(
    cookieJar
  )
    .map(
      ([name, value]) =>
        `${name}=${value}`
    )
    .join("; ");
}

function garminBrowserHeaders(
  cookieJar = null,
  extra = {}
) {
  const headers = {
    "User-Agent":
      GARMIN_USER_AGENT,

    "Accept-Language":
      "en-US,en;q=0.9",

    ...extra
  };

  if (cookieJar) {
    const cookies =
      cookieHeader(cookieJar);

    if (cookies) {
      headers.Cookie =
        cookies;
    }
  }

  return headers;
}

async function fetchFollowingRedirects(
  startUrl,
  cookieJar,
  maxRedirects = 8
) {
  let currentUrl =
    startUrl;

  for (
    let i = 0;
    i <= maxRedirects;
    i++
  ) {
    const response =
      await fetch(
        currentUrl,
        {
          method: "GET",

          headers:
            garminBrowserHeaders(
              cookieJar
            ),

          redirect:
            "manual"
        }
      );

    updateCookieJar(
      cookieJar,
      response
    );

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location =
        response.headers.get(
          "location"
        );

      if (!location) {
        return {
          response,
          finalUrl:
            currentUrl
        };
      }

      currentUrl =
        new URL(
          location,
          currentUrl
        ).toString();

      continue;
    }

    return {
      response,
      finalUrl:
        currentUrl
    };
  }

  throw new Error(
    "Too many Garmin redirects"
  );
}


// =====================================================
// GARMIN SERVER ACTION AUTO-DISCOVERY
// =====================================================

function scoreGarminBundle(url) {
  let score = 0;

  if (
    url.includes(
      "/app/(reply)/reply/"
    ) ||
    url.includes(
      "/app/%28reply%29/reply/"
    )
  ) {
    score += 1000;
  }

  if (
    url.includes(
      "%5BtinyUrlId%5D"
    ) ||
    url.includes(
      "%255BtinyUrlId%255D"
    )
  ) {
    score += 500;
  }

  if (
    /\/page-[a-f0-9]+\.js/i.test(
      url
    )
  ) {
    score += 250;
  }

  if (
    url.includes("(reply)") ||
    url.includes("%28reply%29")
  ) {
    score += 100;
  }

  return score;
}

function extractGarminScriptUrls(
  html,
  pageUrl
) {
  const urls =
    new Set();

  let match;

  // Normal script tags.

  const scriptTagRegex =
    /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi;

  while (
    (
      match =
        scriptTagRegex.exec(html)
    ) !== null
  ) {
    try {
      urls.add(
        new URL(
          match[1],
          pageUrl
        ).toString()
      );
    } catch (_) {}
  }


  // Next.js chunks hidden in inline Flight data.

  const inlineChunkRegex =
    /(?:\/web\/_next\/)?static\/chunks\/[^"'\\\s<>]+?\.js/gi;

  while (
    (
      match =
        inlineChunkRegex.exec(html)
    ) !== null
  ) {
    try {
      let path =
        match[0]
          .replace(
            /\\\//g,
            "/"
          );

      if (
        path.startsWith(
          "static/chunks/"
        )
      ) {
        path =
          "/web/_next/" +
          path;
      }

      else if (
        path.startsWith(
          "/static/chunks/"
        )
      ) {
        path =
          "/web/_next" +
          path;
      }

      else if (
        path.startsWith(
          "web/_next/"
        )
      ) {
        path =
          "/" + path;
      }

      else if (
        path.startsWith(
          "_next/"
        )
      ) {
        path =
          "/web/" + path;
      }

      else if (
        path.startsWith(
          "/_next/"
        )
      ) {
        path =
          "/web" + path;
      }

      urls.add(
        new URL(
          path,
          pageUrl
        ).toString()
      );

    } catch (_) {}
  }

  const list =
    [...urls];

  list.sort(
    (a, b) =>
      scoreGarminBundle(b) -
      scoreGarminBundle(a)
  );

  return list;
}

function findSendReplyActionId(
  javascript
) {
  if (!javascript) {
    return null;
  }

  const primary =
    javascript.match(
      /["']([a-f0-9]{40,64})["'][\s\S]{0,800}?["']sendReplyAction["']/i
    );

  if (primary) {
    return primary[1];
  }

  const actionIndex =
    javascript.indexOf(
      "sendReplyAction"
    );

  if (
    actionIndex === -1
  ) {
    return null;
  }

  const nearby =
    javascript.slice(
      Math.max(
        0,
        actionIndex - 1500
      ),
      actionIndex + 300
    );

  const candidates = [
    ...nearby.matchAll(
      /["']([a-f0-9]{40,64})["']/gi
    )
  ];

  return candidates.length
    ? candidates[
        candidates.length - 1
      ][1]
    : null;
}

async function discoverGarminActionId(
  pageHtml,
  replyUrl,
  cookieJar,
  env
) {
  let actionId =
    findSendReplyActionId(
      pageHtml
    );

  if (actionId) {
    const meta = {
      action_id:
        actionId,

      discovered_at:
        nowIso(),

      source:
        "reply_page_html"
    };

    await env.LIGHTNING_STATE.put(
      GARMIN_ACTION_CACHE_KEY,
      actionId
    );

    await env.LIGHTNING_STATE.put(
      GARMIN_ACTION_META_KEY,
      JSON.stringify(meta)
    );

    return meta;
  }

  const scriptUrls =
    extractGarminScriptUrls(
      pageHtml,
      replyUrl
    );

  if (!scriptUrls.length) {
    throw new Error(
      "Could not find Garmin JavaScript bundles on reply page"
    );
  }

  const errors = [];

  for (
    const scriptUrl
    of scriptUrls
  ) {
    try {
      const response =
        await fetch(
          scriptUrl,
          {
            method: "GET",

            headers:
              garminBrowserHeaders(
                cookieJar,
                {
                  Accept: "*/*",
                  Referer:
                    replyUrl
                }
              )
          }
        );

      if (!response.ok) {
        errors.push(
          `${response.status} ${scriptUrl}`
        );

        continue;
      }

      const javascript =
        await response.text();

      actionId =
        findSendReplyActionId(
          javascript
        );

      if (!actionId) {
        continue;
      }

      const meta = {
        action_id:
          actionId,

        discovered_at:
          nowIso(),

        source:
          scriptUrl
      };

      await env.LIGHTNING_STATE.put(
        GARMIN_ACTION_CACHE_KEY,
        actionId
      );

      await env.LIGHTNING_STATE.put(
        GARMIN_ACTION_META_KEY,
        JSON.stringify(meta)
      );

      return meta;

    } catch (error) {
      errors.push(
        `${scriptUrl}: ${String(
          error?.message ||
          error
        )}`
      );
    }
  }

  throw new Error(
    "Could not discover Garmin sendReplyAction ID. " +
    `Searched ${scriptUrls.length} JavaScript bundles. ` +
    errors
      .slice(0, 5)
      .join(" | ")
  );
}

async function getGarminActionId(
  pageHtml,
  replyUrl,
  cookieJar,
  env,
  forceRediscovery = false
) {
  if (!forceRediscovery) {
    const cached =
      await env.LIGHTNING_STATE.get(
        GARMIN_ACTION_CACHE_KEY
      );

    if (
      cached &&
      /^[a-f0-9]{40,64}$/i.test(
        cached
      )
    ) {
      return {
        action_id:
          cached,

        source:
          "kv_cache",

        discovered_at:
          null
      };
    }
  }

  return discoverGarminActionId(
    pageHtml,
    replyUrl,
    cookieJar,
    env
  );
}

async function postGarminReply(
  replyUrl,
  token,
  messageText,
  actionId,
  cookieJar
) {
  const response =
    await fetch(
      replyUrl,
      {
        method:
          "POST",

        headers:
          garminBrowserHeaders(
            cookieJar,
            {
              "Content-Type":
                "text/plain;charset=UTF-8",

              Accept:
                "text/x-component",

              "Next-Action":
                actionId,

              Origin:
                GARMIN_ORIGIN,

              Referer:
                replyUrl
            }
          ),

        body:
          JSON.stringify(
            [
              token,
              messageText
            ]
          ),

        redirect:
          "manual"
      }
    );

  updateCookieJar(
    cookieJar,
    response
  );

  return {
    ok:
      response.ok,

    status:
      response.status,

    text:
      await response.text()
  };
}

async function sendGarminReply(
  garminLink,
  messageText,
  env
) {
  if (!garminLink) {
    throw new Error(
      "No Garmin reply link available"
    );
  }

  if (
    !messageText ||
    messageText.length > 160
  ) {
    throw new Error(
      `Garmin reply must contain 1-160 characters. Got ${messageText?.length || 0}.`
    );
  }

  const cookieJar = {};

  const first =
    await fetchFollowingRedirects(
      garminLink,
      cookieJar
    );

  const finalUrl =
    first.finalUrl;

  let token = null;

  const replyMatch =
    finalUrl.match(
      /\/web\/reply\/([^/?#]+)/
    );

  if (replyMatch) {
    token =
      decodeURIComponent(
        replyMatch[1]
      );
  }

  if (!token) {
    try {
      const parsed =
        new URL(finalUrl);

      token =
        parsed.searchParams.get(
          "extId"
        );
    } catch (_) {}
  }

  if (!token) {
    token =
      garminLink
        .replace(/\/$/, "")
        .split("/")
        .pop();
  }

  if (!token) {
    throw new Error(
      "Could not determine Garmin reply token"
    );
  }

  const replyUrl =
    `${GARMIN_ORIGIN}/web/reply/` +
    encodeURIComponent(token);

  const replyPageResult =
    await fetchFollowingRedirects(
      replyUrl,
      cookieJar
    );

  const replyPage =
    replyPageResult.response;

  if (!replyPage.ok) {
    throw new Error(
      `Garmin reply page failed: HTTP ${replyPage.status}`
    );
  }

  const pageHtml =
    await replyPage.text();

  let action =
    await getGarminActionId(
      pageHtml,
      replyUrl,
      cookieJar,
      env,
      false
    );

  let result =
    await postGarminReply(
      replyUrl,
      token,
      messageText,
      action.action_id,
      cookieJar
    );

  const staleAction =
    result.status === 404 ||
    /server action not found/i.test(
      result.text
    );

  if (staleAction) {
    action =
      await getGarminActionId(
        pageHtml,
        replyUrl,
        cookieJar,
        env,
        true
      );

    result =
      await postGarminReply(
        replyUrl,
        token,
        messageText,
        action.action_id,
        cookieJar
      );

    if (!result.ok) {
      throw new Error(
        `Garmin reply retry failed: HTTP ${result.status}. ` +
        result.text.slice(
          0,
          300
        )
      );
    }

    return {
      success: true,
      status: result.status,
      action_id: action.action_id,
      action_source: action.source,
      rediscovered: true
    };
  }

  if (!result.ok) {
    throw new Error(
      `Garmin reply failed: HTTP ${result.status}. ` +
      result.text.slice(
        0,
        300
      )
    );
  }

  return {
    success: true,
    status: result.status,
    action_id: action.action_id,
    action_source: action.source,
    rediscovered: false
  };
}


// =====================================================
// LIGHTNING NORMALIZATION
// =====================================================

function normalizeStrike(
  raw,
  latitude,
  longitude
) {
  const lat =
    Number(
      raw?.loc?.lat
    );

  const lon =
    Number(
      raw?.loc?.long
    );

  if (
    !validLatLon(
      lat,
      lon
    )
  ) {
    return null;
  }

  let distance =
    Number(
      raw?.relativeTo?.distanceMI
    );

  if (!Number.isFinite(distance)) {
    distance =
      haversineMiles(
        latitude,
        longitude,
        lat,
        lon
      );
  }

  let bearing =
    Number(
      raw?.relativeTo?.bearing
    );

  if (!Number.isFinite(bearing)) {
    bearing =
      initialBearing(
        latitude,
        longitude,
        lat,
        lon
      );
  }

  let age =
    Number(
      raw?.age ??
      raw?.ob?.age
    );

  if (!Number.isFinite(age)) {
    const timestamp =
      raw?.ob?.timestamp;

    if (
      Number.isFinite(
        Number(timestamp)
      )
    ) {
      age =
        Math.max(
          0,
          Date.now() / 1000 -
          Number(timestamp)
        );
    } else {
      age = 0;
    }
  }

  return {
    id:
      String(
        raw?.id ||
        `${lat},${lon},${raw?.ob?.timestamp || age}`
      ),

    loc: {
      lat,
      long: lon
    },

    age,

    peakamp:
      raw?.peakamp ??
      raw?.ob?.pulse?.peakamp ??
      null,

    ob:
      raw?.ob || {},

    relativeTo: {
      distanceMI:
        distance,

      bearing,

      bearingENG:
        raw?.relativeTo?.bearingENG ||
        bearingToCompass(
          bearing
        )
    }
  };
}


// =====================================================
// CLUSTER LIGHTNING
// =====================================================

function clusterStrikes(
  strikes,
  thresholdMiles =
    CLUSTER_THRESHOLD_MILES
) {
  const groups = [];

  const sorted =
    [...strikes].sort(
      (a, b) =>
        a.relativeTo.distanceMI -
        b.relativeTo.distanceMI
    );

  for (
    const strike
    of sorted
  ) {
    let bestGroup = null;
    let bestDistance = Infinity;

    for (
      const group
      of groups
    ) {
      const centerDistance =
        haversineMiles(
          strike.loc.lat,
          strike.loc.long,
          group.centerLat,
          group.centerLon
        );

      if (
        centerDistance <=
          thresholdMiles &&
        centerDistance <
          bestDistance
      ) {
        bestGroup = group;
        bestDistance =
          centerDistance;
      }
    }

    if (!bestGroup) {
      bestGroup = {
        strikes: [],
        centerLat:
          strike.loc.lat,
        centerLon:
          strike.loc.long
      };

      groups.push(
        bestGroup
      );
    }

    bestGroup.strikes.push(
      strike
    );

    bestGroup.centerLat =
      bestGroup.strikes.reduce(
        (sum, s) =>
          sum + s.loc.lat,
        0
      ) /
      bestGroup.strikes.length;

    bestGroup.centerLon =
      bestGroup.strikes.reduce(
        (sum, s) =>
          sum + s.loc.long,
        0
      ) /
      bestGroup.strikes.length;
  }

  return groups.map(
    group => {
      const distances =
        group.strikes.map(
          s =>
            s.relativeTo.distanceMI
        );

      const bearings =
        group.strikes.map(
          s =>
            s.relativeTo.bearing
        );

      const ages =
        group.strikes.map(
          s => s.age
        );

      const types =
        group.strikes.map(
          s =>
            s.ob?.pulse?.type ||
            null
        );

      const meanBearing =
        circularMeanBearing(
          bearings
        );

      const freshestAge =
        Math.min(
          ...ages
        );

      return {
        strike_count:
          group.strikes.length,

        nearest_distance_miles:
          Math.min(
            ...distances
          ),

        farthest_distance_miles:
          Math.max(
            ...distances
          ),

        direction:
          bearingToCompass(
            meanBearing
          ),

        mean_bearing:
          Math.round(
            meanBearing
          ),

        freshest_age_seconds:
          freshestAge,

        freshest_age:
          formatAge(
            freshestAge
          ),

        cg_count:
          types.filter(
            t => t === "cg"
          ).length,

        ic_count:
          types.filter(
            t => t === "ic"
          ).length,

        center_latitude:
          group.centerLat,

        center_longitude:
          group.centerLon
      };
    }
  );
}


// =====================================================
// SUMMARIZE LIGHTNING
// =====================================================

function summarizeLightning(
  strikes
) {
  if (!strikes.length) {
    return {
      strike_count: 0,
      active_within_60mi: false,
      nearest_strike: null,
      groups: []
    };
  }

  const sorted =
    [...strikes].sort(
      (a, b) =>
        a.relativeTo.distanceMI -
        b.relativeTo.distanceMI
    );

  const nearest =
    sorted[0];

  const groups =
    clusterStrikes(
      sorted
    )
      .sort(
        (a, b) =>
          a.nearest_distance_miles -
          b.nearest_distance_miles
      )
      .slice(0, 5);

  return {
    strike_count:
      strikes.length,

    active_within_60mi:
      true,

    nearest_strike: {
      id:
        nearest.id,

      distance_miles:
        Math.round(
          nearest.relativeTo.distanceMI *
          10
        ) / 10,

      direction:
        nearest.relativeTo.bearingENG,

      bearing:
        nearest.relativeTo.bearing,

      age_seconds:
        nearest.age,

      age:
        formatAge(
          nearest.age
        ),

      type:
        nearest.ob?.pulse?.type ||
        null,

      peakamp:
        nearest.peakamp ??
        null,

      timestamp:
        nearest.ob?.dateTimeISO ??
        null
    },

    groups
  };
}


// =====================================================
// XWEATHER QUERY
// =====================================================

async function queryLightning(
  env,
  latitude,
  longitude
) {
  if (
    !validLatLon(
      latitude,
      longitude
    )
  ) {
    throw new Error(
      "No valid Garmin location stored"
    );
  }

  const xweatherUrl =
    `https://data.api.xweather.com/lightning/` +
    `${latitude},${longitude}` +
    `?client_id=${encodeURIComponent(
      env.XWEATHER_CLIENT_ID
    )}` +
    `&client_secret=${encodeURIComponent(
      env.XWEATHER_CLIENT_SECRET
    )}` +
    `&radius=${LIGHTNING_RADIUS_MILES}mi` +
    `&limit=1000`;

  const response =
    await fetch(
      xweatherUrl
    );

  let data;

  try {
    data =
      await response.json();
  } catch (_) {
    throw new Error(
      `Xweather returned HTTP ${response.status} with invalid JSON`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Xweather HTTP ${response.status}: ` +
      JSON.stringify(data).slice(
        0,
        300
      )
    );
  }

  const raw =
    Array.isArray(
      data?.response
    )
      ? data.response
      : [];

  const strikes =
    raw
      .map(
        strike =>
          normalizeStrike(
            strike,
            latitude,
            longitude
          )
      )
      .filter(Boolean)
      .filter(
        strike =>
          strike.relativeTo.distanceMI <=
          LIGHTNING_RADIUS_MILES
      );

  return {
    status:
      response.status,

    strikes,

    summary:
      summarizeLightning(
        strikes
      )
  };
}
// =====================================================
// DEDUPING
// =====================================================
//
// Xweather returns the last ~5 minutes of strikes on
// every query. Without deduping, the same strikes could
// repeatedly trigger alerts.
//
// We store recently seen strike IDs in KV.
// =====================================================

const SEEN_STRIKES_KEY =
  "seen_lightning_strikes";

const LIGHTNING_HISTORY_KEY =
  "lightning_cluster_history";


async function getSeenStrikes(
  env
) {
  const stored =
    await env
      .LIGHTNING_STATE
      .get(
        SEEN_STRIKES_KEY,
        {
          type: "json"
        }
      );

  if (
    !stored ||
    typeof stored !== "object"
  ) {
    return {};
  }

  return stored;
}


async function updateSeenStrikes(
  env,
  strikes
) {
  const existing =
    await getSeenStrikes(
      env
    );

  const now =
    Date.now();


  // -------------------------------------------------
  // Remove old IDs.
  //
  // Xweather's standard lightning endpoint only
  // contains roughly the last 5 minutes anyway.
  //
  // Keeping IDs for 30 minutes gives us plenty of
  // protection against duplicate notifications.
  // -------------------------------------------------

  const cutoff =
    now -
    30 * 60 * 1000;


  for (
    const [
      id,
      timestamp
    ]
    of Object.entries(
      existing
    )
  ) {
    if (
      Number(timestamp) <
      cutoff
    ) {
      delete existing[id];
    }
  }


  const newStrikes =
    [];


  for (
    const strike
    of strikes
  ) {
    if (
      !existing[
        strike.id
      ]
    ) {
      newStrikes.push(
        strike
      );
    }

    existing[
      strike.id
    ] =
      now;
  }


  await env
    .LIGHTNING_STATE
    .put(
      SEEN_STRIKES_KEY,
      JSON.stringify(
        existing
      )
    );


  return newStrikes;
}


// =====================================================
// CLUSTER HISTORY
// =====================================================
//
// Store current storm centers.
//
// We are not yet using this to make safety claims.
// It gives us the data needed later to say things like:
//
// "WNW cluster moved 6 mi closer in 10 min."
// =====================================================

async function saveClusterHistory(
  env,
  summary
) {
  const existing =
    (
      await env
        .LIGHTNING_STATE
        .get(
          LIGHTNING_HISTORY_KEY,
          {
            type:
              "json"
          }
        )
    ) || [];


  const snapshot = {
    timestamp:
      nowIso(),

    strike_count:
      summary
        ?.strike_count ??
      0,

    nearest_distance_miles:
      summary
        ?.nearest_strike
        ?.distance_miles ??
      null,

    groups:
      (
        summary
          ?.groups ||
        []
      ).map(
        group => ({
          direction:
            group.direction,

          mean_bearing:
            group.mean_bearing,

          strike_count:
            group.strike_count,

          nearest_distance_miles:
            group
              .nearest_distance_miles,

          farthest_distance_miles:
            group
              .farthest_distance_miles,

          center_latitude:
            group.center_latitude,

          center_longitude:
            group.center_longitude
        })
      )
  };


  existing.push(
    snapshot
  );


  // Keep about two hours of snapshots.
  //
  // At a 2-minute active interval that is ~60 records.
  // Give ourselves some extra room.

  const trimmed =
    existing.slice(
      -100
    );


  await env
    .LIGHTNING_STATE
    .put(
      LIGHTNING_HISTORY_KEY,
      JSON.stringify(
        trimmed
      )
    );
}


// =====================================================
// ALERT LEVEL
// =====================================================
//
// These are OUR messaging/cadence bands.
//
// They are not official NWS safety thresholds.
//
// 0-10 mi  = critical
// 11-20 mi = close
// 21-40 mi = nearby
// 41-60 mi = distant
// =====================================================

function getAlertLevel(
  nearestMiles
) {
  if (
    !Number.isFinite(
      nearestMiles
    )
  ) {
    return "none";
  }


  if (
    nearestMiles <= 10
  ) {
    return "critical";
  }


  if (
    nearestMiles <= 20
  ) {
    return "close";
  }


  if (
    nearestMiles <= 40
  ) {
    return "nearby";
  }


  if (
    nearestMiles <= 60
  ) {
    return "distant";
  }


  return "none";
}


// =====================================================
// FIND NEAREST NEW STRIKE
// =====================================================

function getNearestStrike(
  strikes
) {
  if (
    !strikes ||
    !strikes.length
  ) {
    return null;
  }


  return [...strikes]
    .sort(
      (a, b) =>
        a
          .relativeTo
          .distanceMI -
        b
          .relativeTo
          .distanceMI
    )[0];
}


// =====================================================
// SHOULD WE SEND AN ALERT?
// =====================================================
//
// Goal:
// - NO lightning -> silence
// - Same strikes -> don't repeat them endlessly
// - Far lightning -> avoid Garmin spam
// - Closer lightning -> alert more aggressively
// - <=10 mi -> every newly detected close strike can
//              warrant another notification
// =====================================================

function shouldSendLightningAlert(
  state,
  summary,
  newStrikes
) {
  if (
    !summary ||
    summary.strike_count === 0 ||
    !summary.nearest_strike
  ) {
    return {
      send:
        false,

      reason:
        "no_lightning"
    };
  }


  const nearest =
    summary
      .nearest_strike
      .distance_miles;


  const level =
    getAlertLevel(
      nearest
    );


  const lastAlertAt =
    state
      ?.last_lightning_alert_at ??
    null;


  const sinceLastAlert =
    minutesSince(
      lastAlertAt
    );


  const previousNearest =
    Number(
      state
        ?.last_alert_nearest_miles
    );


  const newNearestStrike =
    getNearestStrike(
      newStrikes
    );


  const newNearestMiles =
    newNearestStrike
      ? newNearestStrike
          .relativeTo
          .distanceMI
      : null;


  // -------------------------------------------------
  // CRITICAL: <= 10 miles
  //
  // Send for every newly detected strike <=10 mi.
  //
  // Also permit a reminder after 5 minutes if there
  // is still active lightning <=10 mi.
  // -------------------------------------------------

  if (
    level ===
      "critical"
  ) {
    const newCritical =
      newStrikes.some(
        strike =>
          strike
            .relativeTo
            .distanceMI <=
          10
      );


    if (
      newCritical
    ) {
      return {
        send:
          true,

        reason:
          "new_strike_within_10mi",

        level
      };
    }


    if (
      sinceLastAlert >=
      5
    ) {
      return {
        send:
          true,

        reason:
          "critical_activity_reminder",

        level
      };
    }


    return {
      send:
        false,

      reason:
        "critical_but_recently_alerted",

      level
    };
  }


  // -------------------------------------------------
  // CLOSE: 11-20 miles
  //
  // Alert if:
  // - there is a new strike <=20 mi
  // - nearest activity moved substantially closer
  // - or 5 minutes passed with continued activity
  // -------------------------------------------------

  if (
    level ===
      "close"
  ) {
    const newClose =
      newStrikes.some(
        strike =>
          strike
            .relativeTo
            .distanceMI <=
          20
      );


    if (
      newClose
    ) {
      return {
        send:
          true,

        reason:
          "new_strike_within_20mi",

        level
      };
    }


    if (
      Number.isFinite(
        previousNearest
      ) &&
      nearest <=
        previousNearest - 5
    ) {
      return {
        send:
          true,

        reason:
          "lightning_moved_5mi_closer",

        level
      };
    }


    if (
      sinceLastAlert >=
      5
    ) {
      return {
        send:
          true,

        reason:
          "close_activity_reminder",

        level
      };
    }


    return {
      send:
        false,

      reason:
        "close_but_recently_alerted",

      level
    };
  }


  // -------------------------------------------------
  // NEARBY: 21-40 miles
  //
  // Alert for meaningful NEW activity.
  //
  // Avoid sending for every individual strike.
  // -------------------------------------------------

  if (
    level ===
      "nearby"
  ) {
    if (
      !lastAlertAt &&
      newStrikes.length >
      0
    ) {
      return {
        send:
          true,

        reason:
          "first_nearby_activity",

        level
      };
    }


    if (
      Number.isFinite(
        newNearestMiles
      ) &&
      newNearestMiles <=
      40 &&
      (
        !Number.isFinite(
          previousNearest
        ) ||
        newNearestMiles <=
          previousNearest - 5
      )
    ) {
      return {
        send:
          true,

        reason:
          "new_activity_meaningfully_closer",

        level
      };
    }


    // New cluster/burst:
    // at least 3 newly detected strikes.

    if (
      newStrikes.length >=
        3 &&
      sinceLastAlert >=
        5
    ) {
      return {
        send:
          true,

        reason:
          "new_nearby_burst",

        level
      };
    }


    // Continued nearby lightning:
    // no more than roughly one summary every 10 min.

    if (
      newStrikes.length >
        0 &&
      sinceLastAlert >=
        10
    ) {
      return {
        send:
          true,

        reason:
          "continued_nearby_activity",

        level
      };
    }


    return {
      send:
        false,

      reason:
        "nearby_no_meaningful_change",

      level
    };
  }


  // -------------------------------------------------
  // DISTANT: 41-60 miles
  //
  // Only alert for meaningful activity.
  //
  // This is intentionally conservative about message
  // volume because it is still relatively far away.
  // -------------------------------------------------

  if (
    level ===
      "distant"
  ) {
    if (
      !lastAlertAt &&
      newStrikes.length >=
        3
    ) {
      return {
        send:
          true,

        reason:
          "first_distant_cluster",

        level
      };
    }


    if (
      Number.isFinite(
        newNearestMiles
      ) &&
      newNearestMiles <=
        50 &&
      Number.isFinite(
        previousNearest
      ) &&
      newNearestMiles <=
        previousNearest - 10
    ) {
      return {
        send:
          true,

        reason:
          "distant_activity_moved_closer",

        level
      };
    }


    if (
      newStrikes.length >=
        5 &&
      sinceLastAlert >=
        10
    ) {
      return {
        send:
          true,

        reason:
          "new_distant_burst",

        level
      };
    }


    return {
      send:
        false,

      reason:
        "distant_no_meaningful_change",

      level
    };
  }


  return {
    send:
      false,

    reason:
      "outside_alert_range",

    level:
      "none"
  };
}


// =====================================================
// GARMIN LIGHTNING MESSAGE
// =====================================================
//
// Garmin sender limits us to 160 characters.
//
// We prioritize:
// 1. nearest strike
// 2. overall count
// 3. closest storm groups
// 4. STOP instruction
// =====================================================

function buildLightningMessage(
  summary
) {
  const nearest =
    summary
      .nearest_strike;


  if (!nearest) {
    return null;
  }


  const level =
    getAlertLevel(
      nearest.distance_miles
    );


  let prefix;


  if (
    level ===
      "critical"
  ) {
    prefix =
      "LIGHTNING VERY CLOSE";

  } else if (
    level ===
      "close"
  ) {
    prefix =
      "LIGHTNING CLOSE";

  } else {
    prefix =
      "LIGHTNING";
  }


  const nearestPart =
    `${nearest.distance_miles}mi ` +
    `${nearest.direction}, ` +
    `${nearest.age} ago`;


  const groups =
    (
      summary.groups ||
      []
    )
      .slice(
        0,
        5
      )
      .map(
        group => {
          const near =
            Math.round(
              group
                .nearest_distance_miles
            );


          const far =
            Math.round(
              group
                .farthest_distance_miles
            );


          const range =
            near === far
              ? `${near}mi`
              : `${near}-${far}mi`;


          return (
            `${group.strike_count} ` +
            `${group.direction} ` +
            `${range}`
          );
        }
      );


  const base =
    `${prefix} - ` +
    `${summary.strike_count}/5m. ` +
    `Nearest ${nearestPart}.`;


  const suffix =
    " Reply STOP to stop.";


  let message =
    base;


  // Add groups one by one while staying below
  // Garmin's 160-character message limit.

  for (
    const group
    of groups
  ) {
    const separator =
      message === base
        ? " "
        : "; ";


    const candidate =
      message +
      separator +
      group +
      suffix;


    if (
      candidate.length <=
      160
    ) {
      message +=
        separator +
        group;
    } else {
      break;
    }
  }


  message +=
    suffix;


  // Absolute fallback.
  // Nearest strike information always wins.

  if (
    message.length >
    160
  ) {
    message =
      `${prefix} - ` +
      `Nearest ${nearestPart}. ` +
      `${summary.strike_count} strikes/5m. ` +
      `Reply STOP to stop.`;
  }


  if (
    message.length >
    160
  ) {
    message =
      `LIGHTNING - ` +
      `${nearest.distance_miles}mi ` +
      `${nearest.direction}, ` +
      `${nearest.age} ago. ` +
      `Reply STOP to stop.`;
  }


  return message.slice(
    0,
    160
  );
}


// =====================================================
// RUN ONE AUTOMATIC LIGHTNING CHECK
// =====================================================

async function runLightningMonitor(
  env,
  {
    force = false
  } = {}
) {
  let state =
    await getState(
      env
    );


  // -------------------------------------------------
  // TRACKING OFF
  //
  // IMPORTANT:
  // Return BEFORE contacting Xweather.
  // -------------------------------------------------

  if (
    state
      .tracking_enabled !==
    true
  ) {
    return {
      ok:
        true,

      checked:
        false,

      xweather_called:
        false,

      reason:
        "tracking_off"
    };
  }


  const latitude =
    Number(
      state.latitude
    );


  const longitude =
    Number(
      state.longitude
    );


  // -------------------------------------------------
  // Missing Garmin location:
  // no Xweather call.
  // -------------------------------------------------

  if (
    !validLatLon(
      latitude,
      longitude
    )
  ) {
    await mergeState(
      env,
      {
        last_lightning_error:
          "Tracking is ON but no valid Garmin location is stored.",

        last_lightning_error_at:
          nowIso()
      }
    );


    return {
      ok:
        false,

      checked:
        false,

      xweather_called:
        false,

      reason:
        "invalid_location"
    };
  }


  // -------------------------------------------------
  // ADAPTIVE CADENCE
  //
  // Cron can wake every minute, but this prevents
  // unnecessary Xweather calls.
  // -------------------------------------------------

  if (
    !force &&
    state.next_check_at
  ) {
    const nextCheck =
      new Date(
        state.next_check_at
      ).getTime();


    if (
      Number.isFinite(
        nextCheck
      ) &&
      Date.now() <
        nextCheck
    ) {
      return {
        ok:
          true,

        checked:
          false,

        xweather_called:
          false,

        reason:
          "not_due_yet",

        next_check_at:
          state.next_check_at
      };
    }
  }


  // -------------------------------------------------
  // QUERY XWEATHER
  // -------------------------------------------------

  let lightning;


  try {
    lightning =
      await queryLightning(
        env,
        latitude,
        longitude
      );

  } catch (
    error
  ) {
    const errorText =
      String(
        error?.message ||
        error
      );


    await mergeState(
      env,
      {
        last_lightning_check_at:
          nowIso(),

        last_lightning_error:
          errorText,

        last_lightning_error_at:
          nowIso(),

        // Retry on next Cron wake rather than waiting
        // five minutes after a failed API call.

        next_check_at:
          addMinutesIso(
            1
          )
      }
    );


    return {
      ok:
        false,

      checked:
        true,

      xweather_called:
        true,

      error:
        errorText
    };
  }


  const strikes =
    lightning.strikes;


  const summary =
    lightning.summary;


  // -------------------------------------------------
  // DEDUPE
  // -------------------------------------------------

  const newStrikes =
    await updateSeenStrikes(
      env,
      strikes
    );


  // -------------------------------------------------
  // SAVE CLUSTER HISTORY
  // -------------------------------------------------

  await saveClusterHistory(
    env,
    summary
  );


  // -------------------------------------------------
  // QUIET vs ACTIVE CADENCE
  //
  // Any lightning inside 60 miles -> check ~2 min.
  // No lightning -> check ~5 min.
  // -------------------------------------------------

  const active =
    summary.strike_count >
    0;


  const nextMinutes =
    active
      ? ACTIVE_CHECK_MINUTES
      : QUIET_CHECK_MINUTES;


  // -------------------------------------------------
  // DECIDE WHETHER GARMIN SHOULD BE NOTIFIED
  // -------------------------------------------------

  const decision =
    shouldSendLightningAlert(
      state,
      summary,
      newStrikes
    );


  const commonUpdates = {
    last_lightning_check_at:
      nowIso(),

    last_xweather_status:
      lightning.status,

    last_lightning_count:
      summary.strike_count,

    last_new_strike_count:
      newStrikes.length,

    last_lightning_nearest_miles:
      summary
        ?.nearest_strike
        ?.distance_miles ??
      null,

    last_lightning_nearest_direction:
      summary
        ?.nearest_strike
        ?.direction ??
      null,

    last_lightning_alert_decision:
      decision.reason,

    last_lightning_error:
      null,

    next_check_at:
      addMinutesIso(
        nextMinutes
      )
  };


  // -------------------------------------------------
  // NO LIGHTNING
  //
  // ABSOLUTELY NO GARMIN MESSAGE.
  // -------------------------------------------------

  if (
    summary.strike_count ===
    0
  ) {
    await mergeState(
      env,
      commonUpdates
    );


    return {
      ok:
        true,

      checked:
        true,

      xweather_called:
        true,

      lightning:
        false,

      strike_count:
        0,

      garmin_message_sent:
        false,

      next_check_minutes:
        nextMinutes
    };
  }


  // -------------------------------------------------
  // LIGHTNING EXISTS BUT DOES NOT WARRANT AN ALERT
  // -------------------------------------------------

  if (
    !decision.send
  ) {
    await mergeState(
      env,
      commonUpdates
    );


    return {
      ok:
        true,

      checked:
        true,

      xweather_called:
        true,

      lightning:
        true,

      strike_count:
        summary.strike_count,

      new_strike_count:
        newStrikes.length,

      nearest:
        summary.nearest_strike,

      alert_level:
        decision.level,

      alert_reason:
        decision.reason,

      garmin_message_sent:
        false,

      next_check_minutes:
        nextMinutes
    };
  }


  // -------------------------------------------------
  // WE WANT TO ALERT
  // -------------------------------------------------

  const garminLink =
    state
      .garmin_link;


  if (
    !garminLink
  ) {
    await mergeState(
      env,
      {
        ...commonUpdates,

        last_lightning_error:
          "Lightning alert warranted but no Garmin reply link is stored.",

        last_lightning_error_at:
          nowIso()
      }
    );


    return {
      ok:
        false,

      checked:
        true,

      xweather_called:
        true,

      lightning:
        true,

      alert_warranted:
        true,

      garmin_message_sent:
        false,

      reason:
        "no_garmin_link"
    };
  }


  const messageText =
    buildLightningMessage(
      summary
    );


  // -------------------------------------------------
  // SEND TO GARMIN
  //
  // Re-read state immediately before sending so a STOP
  // command received during the Xweather request wins.
  // -------------------------------------------------

  const latestState =
    await getState(env);

  if (latestState.tracking_enabled !== true) {
    await mergeState(
      env,
      {
        ...commonUpdates,
        last_lightning_alert_decision:
          "cancelled_tracking_stopped_before_send"
      }
    );

    return {
      ok: true,
      checked: true,
      xweather_called: true,
      lightning: true,
      alert_warranted: true,
      garmin_message_sent: false,
      reason: "tracking_stopped_before_send"
    };
  }

  const latestGarminLink =
    latestState.garmin_link ||
    garminLink;

  try {
    const sendResult =
      await sendGarminReply(
        latestGarminLink,
        messageText,
        env
      );


    state =
      await mergeState(
        env,
        {
          ...commonUpdates,

          last_lightning_alert_at:
            nowIso(),

          last_lightning_alert_message:
            messageText,

          last_lightning_alert_level:
            decision.level,

          last_lightning_alert_reason:
            decision.reason,

          last_alert_nearest_miles:
            summary
              .nearest_strike
              .distance_miles,

          last_lightning_alert_success:
            true,

          last_lightning_alert_status:
            sendResult.status,

          last_lightning_alert_error:
            null,

          last_reply_action_id:
            sendResult
              .action_id,

          last_reply_action_source:
            sendResult
              .action_source,

          last_reply_action_rediscovered:
            sendResult
              .rediscovered
        }
      );


    return {
      ok:
        true,

      checked:
        true,

      xweather_called:
        true,

      lightning:
        true,

      strike_count:
        summary.strike_count,

      new_strike_count:
        newStrikes.length,

      nearest:
        summary.nearest_strike,

      alert_level:
        decision.level,

      alert_reason:
        decision.reason,

      garmin_message_sent:
        true,

      garmin_message:
        messageText,

      garmin_status:
        sendResult.status,

      next_check_minutes:
        nextMinutes
    };

  } catch (
    error
  ) {
    const errorText =
      String(
        error?.message ||
        error
      );


    await mergeState(
      env,
      {
        ...commonUpdates,

        last_lightning_alert_at:
          nowIso(),

        last_lightning_alert_message:
          messageText,

        last_lightning_alert_level:
          decision.level,

        last_lightning_alert_reason:
          decision.reason,

        last_alert_nearest_miles:
          summary
            .nearest_strike
            .distance_miles,

        last_lightning_alert_success:
          false,

        last_lightning_alert_status:
          null,

        last_lightning_alert_error:
          errorText
      }
    );


    return {
      ok:
        false,

      checked:
        true,

      xweather_called:
        true,

      lightning:
        true,

      alert_warranted:
        true,

      garmin_message_sent:
        false,

      error:
        errorText
    };
  }
}


// =====================================================
// EMAIL PARSING
// =====================================================

async function processGarminEmail(
  message,
  env
) {
  const now =
    nowIso();

  if (!isAllowedGarminSender(message.from)) {
    console.warn("Ignoring email from non-Garmin sender.");
    return await getState(env);
  }


  const rawEmail =
    await new Response(
      message.raw
    ).text();


  // Basic quoted-printable cleanup.

  const text =
    rawEmail
      .replace(
        /=\r?\n/g,
        ""
      )
      .replace(
        /=3D/g,
        "="
      )
      .replace(
        /=20/g,
        " "
      );


  // -------------------------------------------------
  // GARMIN LINK
  // -------------------------------------------------

  const linkMatch =
    text.match(
      /https:\/\/inreachlink\.com\/[A-Za-z0-9_-]+/
    );


  const garminLink =
    linkMatch
      ? linkMatch[0]
      : null;


  // -------------------------------------------------
  // GPS
  // -------------------------------------------------

  const coordMatch =
    text.match(
      /Lat\s+(-?\d+(?:\.\d+)?)\s+Lon\s+(-?\d+(?:\.\d+)?)/i
    );


  const latitude =
    coordMatch
      ? Number(
          coordMatch[1]
        )
      : null;


  const longitude =
    coordMatch
      ? Number(
          coordMatch[2]
        )
      : null;


  // -------------------------------------------------
  // COMMAND
  // -------------------------------------------------

  let command =
    null;


  const commandMatch =
    text.match(
      /\b(START|STOP|STATUS)\b[\s\S]{0,200}?View the location or send a reply/i
    );


  if (
    commandMatch
  ) {
    command =
      commandMatch[1]
        .toUpperCase();
  }


  let state =
    await getState(
      env
    );


  let trackingEnabled =
    state
      .tracking_enabled ===
    true;


  let replyMessage =
    null;


  // -------------------------------------------------
  // COMMAND ACTIONS
  // -------------------------------------------------

  if (
    command ===
      "START"
  ) {
    trackingEnabled =
      true;


    replyMessage =
      "Tracking started. Lightning monitoring active. " +
      "Reply STOP to stop tracking.";
  }


  else if (
    command ===
      "STOP"
  ) {
    trackingEnabled =
      false;


    replyMessage =
      "Tracking has stopped. " +
      "Reply START to restart tracking.";
  }


  else if (
    command ===
      "STATUS"
  ) {
    replyMessage =
      trackingEnabled
        ? "Tracking ON. Reply STOP to stop tracking."
        : "Tracking OFF. Reply START to restart tracking.";
  }


  // -------------------------------------------------
  // PRESERVE OLD LOCATION/LINK IF EMAIL DOESN'T
  // CONTAIN NEW ONES
  // -------------------------------------------------

  const hasCoordinates =
    validLatLon(
      latitude,
      longitude
    );


  const finalLatitude =
    hasCoordinates
      ? latitude
      : state.latitude ??
        null;


  const finalLongitude =
    hasCoordinates
      ? longitude
      : state.longitude ??
        null;


  const finalGarminLink =
    garminLink ??
    state.garmin_link ??
    null;


  // -------------------------------------------------
  // EMAIL DATE / LOCATION TIME
  // -------------------------------------------------

  const incomingDate =
    message.headers.get(
      "date"
    );


  let parsedIncomingDate =
    null;


  if (
    incomingDate
  ) {
    const parsed =
      new Date(
        incomingDate
      );


    if (
      !Number.isNaN(
        parsed.getTime()
      )
    ) {
      parsedIncomingDate =
        parsed.toISOString();
    }
  }


  const locationTimestamp =
    hasCoordinates
      ? (
          parsedIncomingDate ??
          now
        )
      : (
          state
            .location_timestamp ??
          null
        );


  // -------------------------------------------------
  // START should make monitor eligible immediately.
  //
  // STOP clears next_check_at because tracking is off.
  // -------------------------------------------------

  let nextCheckAt =
    state
      .next_check_at ??
    null;


  if (
    command ===
      "START"
  ) {
    nextCheckAt =
      now;
  }


  if (
    command ===
      "STOP"
  ) {
    nextCheckAt =
      null;
  }


  state = {
    ...state,

    tracking_enabled:
      trackingEnabled,

    latitude:
      finalLatitude,

    longitude:
      finalLongitude,

    garmin_link:
      finalGarminLink,

    location_timestamp:
      locationTimestamp,

    last_command:
      command ??
      state.last_command ??
      null,
    last_email_received_at:
      now,

    next_check_at:
      nextCheckAt
  };


  await env
    .LIGHTNING_STATE
    .put(
      STATE_KEY,
      JSON.stringify(
        state
      )
    );


  // -------------------------------------------------
  // COMMAND CONFIRMATION
  // -------------------------------------------------

  if (
    replyMessage &&
    finalGarminLink
  ) {
    try {
      const result =
        await sendGarminReply(
          finalGarminLink,
          replyMessage,
          env
        );


      state =
        await mergeState(
          env,
          {
            last_reply_message:
              replyMessage,

            last_reply_at:
              nowIso(),

            last_reply_success:
              true,

            last_reply_status:
              result.status,

            last_reply_error:
              null,

            last_reply_action_id:
              result.action_id,

            last_reply_action_source:
              result.action_source,

            last_reply_action_rediscovered:
              result.rediscovered
          }
        );

    } catch (
      error
    ) {
      state =
        await mergeState(
          env,
          {
            last_reply_message:
              replyMessage,

            last_reply_at:
              nowIso(),

            last_reply_success:
              false,

            last_reply_status:
              null,

            last_reply_error:
              String(
                error?.message ||
                error
              )
          }
        );
    }
  }
  await env
    .LIGHTNING_STATE
    .put(
      "last_email_debug",
      JSON.stringify({
        received_at:
          nowIso(),

        command,

        tracking_enabled:
          trackingEnabled,

        garmin_link_found:
          Boolean(finalGarminLink),

        coordinates_found:
          hasCoordinates,

        reply_attempted:
          Boolean(
            replyMessage &&
            finalGarminLink
          )
      })
    );


  return state;
}


// =====================================================
// MAIN WORKER
// =====================================================

export default {

  // ===================================================
  // WEB ENDPOINTS
  // ===================================================

  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      const state =
        await getState(env);

      return Response.json({
        ok: true,
        service: "garmin-inreach-lightning-monitor",
        tracking_enabled:
          state.tracking_enabled === true,
        location_available:
          validLatLon(
            Number(state.latitude),
            Number(state.longitude)
          ),
        garmin_reply_link_available:
          Boolean(state.garmin_link),
        last_command:
          state.last_command ?? null,
        last_email_received_at:
          state.last_email_received_at ?? null,
        last_lightning_check_at:
          state.last_lightning_check_at ?? null,
        last_xweather_status:
          state.last_xweather_status ?? null,
        last_lightning_count:
          state.last_lightning_count ?? null,
        last_lightning_alert_decision:
          state.last_lightning_alert_decision ?? null,
        last_lightning_alert_success:
          state.last_lightning_alert_success ?? null,
        next_check_at:
          state.next_check_at ?? null
      });
    }

    return Response.json(
      {
        ok: false,
        error: "Not found"
      },
      {
        status: 404
      }
    );
  },

  // ===================================================
  // GARMIN EMAIL ROUTING
  // ===================================================

  async email(
    message,
    env,
    ctx
  ) {
    try {
      await processGarminEmail(
        message,
        env
      );

    } catch (
      error
    ) {
      console.error(
        "Email processing failed:",
        error
      );


      await env
        .LIGHTNING_STATE
        .put(
          "last_email_error",
          JSON.stringify({
            received_at:
              nowIso(),

            error:
              String(
                error?.message ||
                error
              )
          })
        );
    }
  },


  // ===================================================
  // CLOUDFLARE CRON
  //
  // Configure Cron to wake this Worker every minute:
  //
  // * * * * *
  //
  // IMPORTANT:
  //
  // This does NOT mean Xweather is called every minute.
  //
  // runLightningMonitor() checks next_check_at:
  //
  // quiet       -> about every 5 min
  // lightning   -> about every 2 min
  // tracking OFF -> ZERO Xweather calls
  // ===================================================

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runLightningMonitor(
        env,
        {
          force:
            false
        }
      )
        .then(
          result => {
            console.log(
              "Scheduled lightning check:",
              JSON.stringify(
                result
              )
            );
          }
        )
        .catch(
          async error => {
            console.error(
              "Scheduled lightning monitor failed:",
              error
            );


            try {
              await mergeState(
                env,
                {
                  last_scheduler_error:
                    String(
                      error?.message ||
                      error
                    ),

                  last_scheduler_error_at:
                    nowIso()
                }
              );

            } catch (_) {}
          }
        )
    );
  }
};