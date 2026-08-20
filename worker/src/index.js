const GRADES = {
  league:   { label: "LEAGUE", teamId: "046b90e4" },
  reserves: { label: "RESERVES", teamId: "5bf15ff7" },
  colts:    { label: "COLTS", teamId: "a95954ed" },
  thirds:   { label: "THIRDS", teamId: "696edf4b" }
};

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = [
    "https://clfchub.pages.dev",
    "https://clfchub.github.io",
    "http://localhost:5173"
  ];
  
  let allowOrigin = "*";
  if (origin) {
    if (allowedOrigins.some(ao => origin.startsWith(ao))) {
      allowOrigin = origin;
    }
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Passcode",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Credentials": "true"
  };
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(request), ...extra }
  });
}

function isGrade(value) {
  return Object.prototype.hasOwnProperty.call(GRADES, value);
}

function cookieName(env) {
  return `clfchub_admin_${env.ADMIN_PASSCODE || "unset"}`;
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("X-Admin-Passcode");
  return auth === env.ADMIN_PASSCODE;
}

async function getRoster(env, grade) {
  const rows = await env.DB.prepare(
    "SELECT name, playhq_uid, pin, playhq_json FROM roster_players WHERE grade = ? ORDER BY sort_order, id"
  ).bind(grade).all();

  const state = await env.DB.prepare(
    "SELECT source, player_count, status, last_checked_at, last_successful_sync_at FROM roster_state WHERE grade = ?"
  ).bind(grade).first();

  const players = (rows.results || []).map(r => {
    if (r.playhq_json) {
      try {
        const obj = JSON.parse(r.playhq_json);
        return { ...obj, pin: r.pin };
      } catch (e) {
        // fallback
      }
    }

    return {
      name: r.name,
      id: r.playhq_uid,
      pin: r.pin
    };
  });

  return {
    grade,
    players,
    source: state?.source || null,
    playerCount: state?.player_count || players.length,
    status: state?.status || (players.length ? "synced" : "empty"),
    lastCheckedAt: state?.last_checked_at || null,
    lastSuccessfulSyncAt: state?.last_successful_sync_at || null
  };
}

async function mockPlayers(env, grade) {
  // Select 22 RANDOM members every time MOCK 22 PLAYERS is used.
  const rows = await env.DB.prepare(
    "SELECT name, pin FROM members ORDER BY RANDOM() LIMIT 22"
  ).all();

  return (rows.results || []).map((r, i) => {
    const parts = r.name.split(" ");
    const firstName = parts[0] || "Mock";
    const lastName = parts.slice(1).join(" ") || `Player ${i + 1}`;

    return {
      name: r.name,
      id: `MOCK-${grade.toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
      firstName,
      lastName,
      teamId: GRADES[grade].teamId,
      roleType: "Player",
      isRegisteredPlayer: true,
      pin: r.pin
    };
  });
}

async function lookupMember(env, player) {
  const uid = player.id || player.uid || player.playerId || player.player?.id || null;

  if (uid) {
    const byUid = await env.DB.prepare(
      "SELECT name, pin FROM members WHERE playhq_uid = ?"
    ).bind(uid).first();

    if (byUid) return byUid;
  }

  const name =
    [player.firstName, player.lastName].filter(Boolean).join(" ").trim() ||
    player.name ||
    "";

  if (!name) return null;

  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  const rows = await env.DB.prepare(
    "SELECT name, pin FROM members"
  ).all();

  return (rows.results || []).find(
    r => r.name.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized
  ) || null;
}

async function saveRoster(env, grade, players, source) {
  const now = new Date().toISOString();

  await env.DB.prepare(
    "DELETE FROM roster_players WHERE grade = ?"
  ).bind(grade).run();

  const statements = players.map((p, i) => {
    const name =
      [p.firstName, p.lastName].filter(Boolean).join(" ") ||
      p.name ||
      "Unknown Player";

    const uid =
      p.id ||
      p.uid ||
      p.playerId ||
      p.player?.id ||
      null;

    return env.DB.prepare(
      "INSERT INTO roster_players (grade, name, playhq_uid, pin, playhq_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      grade,
      name,
      uid,
      p.pin || null,
      JSON.stringify(p),
      i
    );
  });

  if (statements.length) {
    await env.DB.batch(statements);
  }

  await env.DB.prepare(
    `INSERT INTO roster_state
      (grade, source, player_count, status, last_checked_at, last_successful_sync_at)
     VALUES (?, ?, ?, 'synced', ?, ?)
     ON CONFLICT(grade) DO UPDATE SET
       source = excluded.source,
       player_count = excluded.player_count,
       status = 'synced',
       last_checked_at = excluded.last_checked_at,
       last_successful_sync_at = excluded.last_successful_sync_at`
  ).bind(
    grade,
    source,
    players.length,
    now,
    now
  ).run();
}

async function recordCheck(env, grade, status) {
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO roster_state
      (grade, source, player_count, status, last_checked_at)
     VALUES (?, NULL, 0, ?, ?)
     ON CONFLICT(grade) DO UPDATE SET
       status = excluded.status,
       last_checked_at = excluded.last_checked_at`
  ).bind(
    grade,
    status,
    now
  ).run();
}

async function importPlayHQRoster(env, grade) {
  const teamId = GRADES[grade].teamId;

  const url =
    `https://api.playhq.com/v1/organizations/${env.PLAYHQ_ORG_ID}/teams/${teamId}/players`;

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${env.PLAYHQ_API_KEY}`,
        "Accept": "application/json"
      }
    });
  } catch (error) {
    await recordCheck(env, grade, "error");

    console.error(
      `PlayHQ network error for ${grade}:`,
      error
    );

    return {
      updated: false,
      reason: "network_error",
      error: error.message
    };
  }

  if (!response.ok) {
    const body = await response.text();

    await recordCheck(env, grade, "error");

    console.error(
      `PlayHQ returned ${response.status} for ${grade}: ${body.slice(0, 300)}`
    );

    return {
      updated: false,
      reason: "http_error",
      status: response.status
    };
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    await recordCheck(env, grade, "error");

    return {
      updated: false,
      reason: "json_parse_error"
    };
  }

  const rawPlayers =
    Array.isArray(data)
      ? data
      : (data.players || []);

  // CRITICAL SAFETY RULE:
  // Empty PlayHQ results never erase a valid saved roster.
  if (!Array.isArray(rawPlayers) || rawPlayers.length === 0) {
    await recordCheck(env, grade, "not_uploaded");

    return {
      updated: false,
      reason: "empty"
    };
  }

  const enriched = [];
  let matchedCount = 0;

  for (const p of rawPlayers) {
    const member = await lookupMember(env, p);
    const pin = member?.pin || null;

    if (pin) matchedCount++;

    enriched.push({
      ...p,
      pin
    });
  }

  await saveRoster(
    env,
    grade,
    enriched,
    "playhq"
  );

  console.log(
    `Successfully synced ${grade}: ${enriched.length} players, ${matchedCount} PINs matched.`
  );

  return {
    updated: true,
    players: enriched,
    playerCount: enriched.length,
    matchedCount
  };
}

async function syncAllGrades(env) {
  for (const grade of Object.keys(GRADES)) {
    try {
      await importPlayHQRoster(env, grade);
    } catch (error) {
      await recordCheck(env, grade, "error");

      console.error(
        `PlayHQ sync failed for ${grade}`,
        error
      );
    }
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      syncAllGrades(env)
    );
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: getCorsHeaders(request)
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        path === "/api/debug/env" &&
        request.method === "GET"
      ) {
        return json(request, {
          hasPasscode: !!env.ADMIN_PASSCODE,
          passcodeLength: env.ADMIN_PASSCODE?.length,
          passcodeFirstChar: env.ADMIN_PASSCODE?.[0]
        });
      }

      if (
        path === "/api/admin/status" &&
        request.method === "GET"
      ) {
        return json(request, {
          authenticated: await requireAdmin(request, env)
        });
      }

      if (
        path === "/api/admin/login" &&
        request.method === "POST"
      ) {
        const { passcode } = await request.json();

        if (
          !env.ADMIN_PASSCODE ||
          passcode !== env.ADMIN_PASSCODE
        ) {
          return json(
            request,
            { error: "Invalid passcode" },
            401
          );
        }

        return json(request, {
          ok: true
        });
      }

      if (
        path === "/api/admin/logout" &&
        request.method === "POST"
      ) {
        return json(request, {
          ok: true
        });
      }

      const adminMatch =
        path.match(/^\/api\/admin\/(mock|clear|clear-team)$/);

      if (
        adminMatch &&
        request.method === "POST"
      ) {
        if (!(await requireAdmin(request, env))) {
          return json(
            request,
            { error: "Unauthorized" },
            401
          );
        }

        const { grade } = await request.json();

        if (!isGrade(grade)) {
          return json(
            request,
            { error: "Invalid grade" },
            400
          );
        }

        const action = adminMatch[1];

        if (action === "mock") {
          const players = await mockPlayers(
            env,
            grade
          );

          await saveRoster(
            env,
            grade,
            players,
            "mock"
          );

          return json(request, {
            ok: true,
            players
          });
        }

        if (action === "clear") {
          await env.DB.prepare(
            "DELETE FROM roster_players WHERE grade = ?"
          ).bind(grade).run();

          await env.DB.prepare(
            "DELETE FROM roster_state WHERE grade = ?"
          ).bind(grade).run();

          return json(request, {
            ok: true
          });
        }

        if (action === "clear-team") {
          await env.DB.batch([
            env.DB.prepare(
              "DELETE FROM roster_players WHERE grade = ?"
            ).bind(grade),

            env.DB.prepare(
              "DELETE FROM roster_state WHERE grade = ?"
            ).bind(grade)
          ]);

          return json(request, {
            ok: true
          });
        }
      }

      const rosterMatch =
        path.match(
          /^\/api\/roster\/(league|reserves|colts|thirds)$/
        );

      if (
        rosterMatch &&
        request.method === "GET"
      ) {
        const grade = rosterMatch[1];

        return json(
          request,
          await getRoster(env, grade)
        );
      }

      const playhqMatch =
        path.match(
          /^\/api\/roster\/(league|reserves|colts|thirds)\/playhq$/
        );

      if (
        playhqMatch &&
        request.method === "POST"
      ) {
        const grade = playhqMatch[1];

        const result =
          await importPlayHQRoster(
            env,
            grade
          );

        const current =
          await getRoster(
            env,
            grade
          );

        return json(request, {
          ...result,
          ...current
        });
      }

      return json(
        request,
        { error: "Not found" },
        404
      );

    } catch (error) {
      console.error(error);

      return json(
        request,
        {
          error:
            error.message ||
            "Internal server error"
        },
        500
      );
    }
  }
};
