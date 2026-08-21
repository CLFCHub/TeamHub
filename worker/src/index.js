const PLAYHQ_BASE = "https://api.playhq.com";

const GRADE_MAPPING = {
  "Budget Car and Truck Rental B Grade Men": "league",
  "Budget Car and Truck Rental B Reserves Men": "reserves",
  "EGT Drew Banfield Colts": "colts",
  "Budget Car and Truck Rental E2 South Men": "thirds",
};

const GRADE_UID_MAPPING = {
  "5d8b69aa": "league",
  "5d8a608a": "reserves",
  "9c044820": "colts",
  "3bd3820f": "thirds",
};

const ALLOWED_ORIGINS = [
  "https://clfchub.github.io",
  "https://clfchub.pages.dev",
  "http://localhost:5173",
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");

  let allowOrigin = "https://clfchub.github.io";

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    allowOrigin = origin;
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function mapGrade(gradeName, gradeUid) {
  if (gradeUid && GRADE_UID_MAPPING[gradeUid]) {
    return GRADE_UID_MAPPING[gradeUid];
  }

  if (!gradeName) {
    return null;
  }

  if (GRADE_MAPPING[gradeName]) {
    return GRADE_MAPPING[gradeName];
  }

  const lower = gradeName.toLowerCase();

  for (const [playhqName, frontendKey] of Object.entries(GRADE_MAPPING)) {
    if (playhqName.toLowerCase() === lower) {
      return frontendKey;
    }
  }

  return gradeName;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200, request);
    }

    if (url.pathname === "/sync/organisations") {
      return handleSyncOrganisations(env, request);
    }

    if (url.pathname === "/sync/games") {
      return handleSyncGames(
        env,
        url.searchParams.get("date") || todayISO(),
        request
      );
    }

    if (url.pathname === "/sync/players") {
      return handleSyncPlayers(
        env,
        url.searchParams.get("date") || todayISO(),
        request
      );
    }

    if (url.pathname === "/sync/all") {
      return handleSyncAll(
        env,
        url.searchParams.get("date") || todayISO(),
        request
      );
    }

    if (url.pathname === "/mock/roster" && request.method === "POST") {
      return handleMockRoster(request, env);
    }

    if (url.pathname === "/mock/clear" && request.method === "POST") {
      return handleMockClear(request, env);
    }

    if (url.pathname === "/mock/roster" && request.method === "GET") {
      return handleMockList(request, env);
    }

    if (url.pathname === "/roster" && request.method === "GET") {
      return handleGetRoster(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404, request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleSyncAll(env, todayISO(), null));
  },
};

function jsonResponse(data, status = 200, request = null) {
  const cors = request
    ? getCorsHeaders(request)
    : {
        "Access-Control-Allow-Origin": "https://clfchub.github.io",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors,
    },
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function playhqFetch(path, env) {
  if (!env.PLAYHQ_API_KEY) {
    throw new Error("PLAYHQ_API_KEY secret not set");
  }

  const res = await fetch(`${PLAYHQ_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${env.PLAYHQ_API_KEY}`,
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `PlayHQ API error ${res.status}: ${await res.text()}`
    );
  }

  return res.json();
}

function isPlayer(person) {
  const role = (
    person.role ||
    person.position ||
    person.memberType ||
    person.type ||
    person.classification ||
    person.participantType ||
    ""
  )
    .toString()
    .toLowerCase();

  if (
    role.includes("coach") ||
    role.includes("manager") ||
    role.includes("official") ||
    role.includes("umpire") ||
    role.includes("volunteer")
  ) {
    return false;
  }

  if (typeof person.isPlayer === "boolean") {
    return person.isPlayer;
  }

  if (typeof person.is_player === "boolean") {
    return person.is_player;
  }

  return true;
}

async function handleSyncOrganisations(env, request) {
  const orgId = env.PLAYHQ_ORG_ID;

  const data = await playhqFetch(
    `/partner/v1/organisations/${orgId}`,
    env
  );

  const org = data.organisation || data;

  await env.DB.prepare(
    `INSERT INTO playhq_organisations
      (playhq_id, name, pin)
     VALUES (?, ?, NULL)
     ON CONFLICT(playhq_id)
     DO UPDATE SET name = excluded.name`
  )
    .bind(
      orgId,
      org.name || org.displayName || "Unknown"
    )
    .run();

  return jsonResponse(
    {
      synced: 1,
      table: "playhq_organisations",
      playhq_id: orgId,
      name: org.name || "Unknown",
    },
    200,
    request
  );
}

async function fetchGames(env, date) {
  const data = await playhqFetch(
    `/partner/v1/organisations/${env.PLAYHQ_ORG_ID}/games/${date}`,
    env
  );

  const games = data.games || data.data || data || [];

  return Array.isArray(games) ? games : [games];
}

async function handleSyncGames(env, date, request) {
  const games = await fetchGames(env, date);

  const orgRow = await env.DB.prepare(
    `SELECT id
     FROM playhq_organisations
     WHERE playhq_id = ?`
  )
    .bind(env.PLAYHQ_ORG_ID)
    .first();

  const gradeIds = new Set();

  for (const game of games) {
    const grade =
      game.grade ||
      game.competition ||
      game.division;

    if (
      grade?.id &&
      !gradeIds.has(grade.id) &&
      orgRow
    ) {
      await env.DB.prepare(
        `INSERT INTO playhq_grades
          (playhq_id, organisation_id, name, url, pin)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(playhq_id)
         DO UPDATE SET
           organisation_id = excluded.organisation_id,
           name = excluded.name,
           url = excluded.url`
      )
        .bind(
          grade.id,
          orgRow.id,
          grade.name || "Unknown",
          grade.url || null
        )
        .run();

      gradeIds.add(grade.id);
    }
  }

  return jsonResponse(
    {
      date,
      gamesFound: games.length,
      gameIds: games.map(
        (g) => g.id || g.gameId
      ),
      gradesExtracted: gradeIds.size,
    },
    200,
    request
  );
}

async function handleSyncPlayers(env, date, request) {
  const games = await fetchGames(env, date);

  if (!games.length) {
    return jsonResponse(
      {
        date,
        message: "No games found",
        synced: 0,
      },
      200,
      request
    );
  }

  const orgRow = await env.DB.prepare(
    `SELECT id
     FROM playhq_organisations
     WHERE playhq_id = ?`
  )
    .bind(env.PLAYHQ_ORG_ID)
    .first();

  if (!orgRow) {
    return jsonResponse(
      {
        error: "Run /sync/organisations first",
      },
      400,
      request
    );
  }

  const gradeRows = await env.DB.prepare(
    `SELECT id, playhq_id, name
     FROM playhq_grades
     WHERE organisation_id = ?`
  )
    .bind(orgRow.id)
    .all();

  const gradeMap = new Map();
  const gradeNameMap = new Map();

  for (const r of gradeRows.results || []) {
    gradeMap.set(r.playhq_id, r.id);
    gradeNameMap.set(r.playhq_id, r.name);
  }

  const allPlayers = [];
  const gameResults = [];

  let totalSkipped = 0;

  for (const game of games) {
    const gameId = game.id || game.gameId;

    if (!gameId) {
      continue;
    }

    const gameGrade =
      game.grade ||
      game.competition ||
      game.division;

    const gradePlayhqId =
      gameGrade?.id || null;

    const gradeInternalId =
      gradePlayhqId
        ? gradeMap.get(gradePlayhqId) || null
        : null;

    const gradeName =
      gradePlayhqId
        ? gradeNameMap.get(gradePlayhqId) ||
          gameGrade?.name ||
          "Unknown"
        : "Unknown";

    try {
      const summary = await playhqFetch(
        `/partner/v1/games/${gameId}/summary`,
        env
      );

      const players =
        summary.players ||
        summary.participants ||
        summary.roster ||
        summary.data ||
        [];

      let gamePeople = [];

      if (!Array.isArray(players) && summary.teams) {
        for (const team of (
          Array.isArray(summary.teams)
            ? summary.teams
            : [summary.teams]
        )) {
          const tr =
            team.players ||
            team.roster ||
            team.participants ||
            [];

          if (Array.isArray(tr)) {
            gamePeople.push(...tr);
          }
        }
      } else if (Array.isArray(players)) {
        gamePeople = players;
      }

      const filtered = gamePeople.filter(
        (p) => isPlayer(p)
      );

      totalSkipped +=
        gamePeople.length - filtered.length;

      if (filtered.length) {
        await upsertPlayers(
          filtered,
          env,
          orgRow.id,
          gradeInternalId,
          gradeName,
          gradePlayhqId,
          allPlayers
        );
      }

      gameResults.push({
        gameId,
        totalPeople: gamePeople.length,
        playersFound: filtered.length,
        coachesFiltered:
          gamePeople.length - filtered.length,
        status: "ok",
      });
    } catch (err) {
      gameResults.push({
        gameId,
        error: err.message,
        status: "error",
      });
    }
  }

  return jsonResponse(
    {
      date,
      gamesProcessed: games.length,
      totalPlayersSynced: allPlayers.length,
      totalCoachesFiltered: totalSkipped,
      games: gameResults,
    },
    200,
    request
  );
}

async function upsertPlayers(
  players,
  env,
  orgInternalId,
  gradeInternalId,
  gradeName,
  gradePlayhqId,
  allPlayers
) {
  for (const player of players) {
    const playhqId =
      player.id ||
      player.participantId ||
      player.playerId;

    if (!playhqId) {
      continue;
    }

    const firstName =
      player.firstName ||
      player.givenName ||
      "";

    const lastName =
      player.lastName ||
      player.familyName ||
      player.surname ||
      "";

    const fullName =
      player.name ||
      player.fullName ||
      `${firstName} ${lastName}`.trim();

    const teamId =
      player.teamId ||
      player.team?.id ||
      null;

    const playerGradeId =
      player.gradeId ||
      player.grade?.id ||
      gradeInternalId;

    const playerGradeName =
      player.gradeName ||
      player.grade?.name ||
      gradeName ||
      "Unknown";

    const playerGradeUid =
      player.gradeId ||
      player.grade?.id ||
      gradePlayhqId ||
      null;

    const frontendGrade =
      mapGrade(
        playerGradeName,
        playerGradeUid
      );

    const playerJson =
      JSON.stringify(player);

    await env.DB.prepare(
      `INSERT INTO playhq_rostered_players
        (
          grade_id,
          organisation_id,
          playhq_id,
          first_name,
          last_name,
          name,
          team_id,
          pin
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(playhq_id)
       DO UPDATE SET
         grade_id = excluded.grade_id,
         organisation_id = excluded.organisation_id,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         name = excluded.name,
         team_id = excluded.team_id`
    )
      .bind(
        playerGradeId,
        orgInternalId,
        playhqId,
        firstName,
        lastName,
        fullName,
        teamId
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO roster_players
        (
          id,
          grade,
          name,
          playhq_uid,
          pin,
          playhq_json,
          sort_order
        )
       VALUES (NULL, ?, ?, ?, NULL, ?, 0)
       ON CONFLICT(playhq_uid)
       DO UPDATE SET
         grade = excluded.grade,
         name = excluded.name,
         playhq_json = excluded.playhq_json`
    )
      .bind(
        frontendGrade,
        fullName,
        playhqId,
        playerJson
      )
      .run();

    allPlayers.push(playhqId);
  }
}

async function handleSyncAll(env, date, request) {
  const results = {};

  try {
    results.organisations =
      await handleSyncOrganisations(
        env,
        request
      ).then((r) => r.json());
  } catch (e) {
    results.organisations = {
      error: e.message,
    };
  }

  try {
    results.games =
      await handleSyncGames(
        env,
        date,
        request
      ).then((r) => r.json());
  } catch (e) {
    results.games = {
      error: e.message,
    };
  }

  try {
    results.players =
      await handleSyncPlayers(
        env,
        date,
        request
      ).then((r) => r.json());
  } catch (e) {
    results.players = {
      error: e.message,
    };
  }

  return jsonResponse(
    results,
    200,
    request
  );
}

async function handleMockRoster(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "Invalid JSON" },
      400,
      request
    );
  }

  const grade = body.grade;

  if (!grade) {
    return jsonResponse(
      { error: "Missing 'grade'" },
      400,
      request
    );
  }

  const members = await env.DB.prepare(
    `SELECT id, name, playhq_uid, pin
     FROM members
     ORDER BY RANDOM()
     LIMIT 22`
  ).all();

  if (!members.results?.length) {
    return jsonResponse(
      { error: "No members found" },
      400,
      request
    );
  }

  const inserted = [];

  for (
    let i = 0;
    i < members.results.length;
    i++
  ) {
    const m = members.results[i];

    const playhqId =
      m.playhq_uid ||
      `mock-${m.id}`;

    const mockJson = JSON.stringify({
      mock: true,
      member_id: m.id,
      name: m.name,
      pin: m.pin,
    });

    await env.DB.prepare(
      `INSERT INTO roster_players
        (
          id,
          grade,
          name,
          playhq_uid,
          pin,
          playhq_json,
          sort_order
        )
       VALUES (NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(playhq_uid)
       DO UPDATE SET
         grade = excluded.grade,
         name = excluded.name,
         pin = excluded.pin,
         playhq_json = excluded.playhq_json,
         sort_order = excluded.sort_order`
    )
      .bind(
        grade,
        m.name,
        playhqId,
        m.pin,
        mockJson,
        i + 1
      )
      .run();

    inserted.push({
      id: m.id,
      name: m.name,
      pin: m.pin,
      playhq_uid: playhqId,
      sort_order: i + 1,
    });
  }

  return jsonResponse(
    {
      message: `Generated ${inserted.length} mock players for "${grade}"`,
      grade,
      players: inserted,
    },
    200,
    request
  );
}

async function handleMockClear(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "Invalid JSON" },
      400,
      request
    );
  }

  const grade = body.grade;

  if (!grade) {
    return jsonResponse(
      { error: "Missing 'grade'" },
      400,
      request
    );
  }

  const result = await env.DB.prepare(
    `DELETE FROM roster_players
     WHERE grade = ?`
  )
    .bind(grade)
    .run();

  return jsonResponse(
    {
      message: `Cleared roster for "${grade}"`,
      grade,
      deleted: result.meta?.changes || 0,
    },
    200,
    request
  );
}

async function handleMockList(request, env) {
  const url = new URL(request.url);

  const grade =
    url.searchParams.get("grade");

  if (!grade) {
    return jsonResponse(
      {
        error: "Missing 'grade' parameter",
      },
      400,
      request
    );
  }

  const result = await env.DB.prepare(
    `SELECT *
     FROM roster_players
     WHERE grade = ?
     ORDER BY sort_order`
  )
    .bind(grade)
    .all();

  return jsonResponse(
    {
      grade,
      count: result.results?.length || 0,
      players: result.results || [],
    },
    200,
    request
  );
}

async function handleGetRoster(request, env) {
  const url = new URL(request.url);

  const grade =
    url.searchParams.get("grade");

  if (!grade) {
    return jsonResponse(
      {
        error: "Missing 'grade' parameter",
      },
      400,
      request
    );
  }

  const rows = await env.DB.prepare(
    `SELECT
       name,
       playhq_uid,
       pin,
       playhq_json
     FROM roster_players
     WHERE grade = ?
     ORDER BY sort_order, id`
  )
    .bind(grade)
    .all();

  const players = (
    rows.results || []
  ).map((r) => {
    if (r.playhq_json) {
      try {
        const obj =
          JSON.parse(r.playhq_json);

        return {
          ...obj,
          pin: r.pin,
          playhq_uid: r.playhq_uid,
        };
      } catch (e) {}
    }

    return {
      name: r.name,
      id: r.playhq_uid,
      pin: r.pin,
      playhq_uid: r.playhq_uid,
    };
  });

  return jsonResponse(
    {
      grade,
      players,
      source: players.length
        ? "synced"
        : null,
      playerCount: players.length,
      status: players.length
        ? "synced"
        : "empty",
    },
    200,
    request
  );
}