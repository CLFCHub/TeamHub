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
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request),
      ...extra
    }
  });
}

function isGrade(value) {
  return Object.prototype.hasOwnProperty.call(GRADES, value);
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("X-Admin-Passcode");
  return auth === env.ADMIN_PASSCODE;
}


/* =========================================================
   GET ROSTER
   ========================================================= */

async function getRoster(env, grade) {
  const rows = await env.DB.prepare(
    `SELECT id, grade, name, playhq_uid, pin, sort_order
     FROM roster_players
     WHERE grade = ?
     ORDER BY sort_order, id`
  )
    .bind(grade)
    .all();

  const state = await env.DB.prepare(
    `SELECT grade, source
     FROM roster_state
     WHERE grade = ?`
  )
    .bind(grade)
    .first();

  const players = (rows.results || []).map(row => ({
    name: row.name,
    id: row.playhq_uid,
    playhq_uid: row.playhq_uid,
    pin: row.pin
  }));

  return {
    grade,
    players,
    source: state?.source || null,
    playerCount: players.length
  };
}


/* =========================================================
   MOCK 22 PLAYERS
   RANDOMLY SELECTS 22 PEOPLE FROM MEMBERS
   ========================================================= */

async function mockPlayers(env, grade) {

  const rows = await env.DB.prepare(
    `SELECT name, pin
     FROM members
     ORDER BY RANDOM()
     LIMIT 22`
  ).all();

  const members = rows.results || [];

  return members.map((r, i) => {

    const parts = String(r.name || "").trim().split(/\s+/);

    const firstName = parts[0] || "Mock";

    const lastName =
      parts.slice(1).join(" ") ||
      `Player ${i + 1}`;

    return {
      name: r.name,

      id:
        `MOCK-${grade.toUpperCase()}-${String(i + 1).padStart(3, "0")}`,

      firstName,
      lastName,

      teamId: GRADES[grade].teamId,

      roleType: "Player",

      isRegisteredPlayer: true,

      pin: r.pin
    };
  });
}


/* =========================================================
   LOOK UP MEMBER
   ========================================================= */

async function lookupMember(env, player) {

  const uid =
    player.id ||
    player.uid ||
    player.playerId ||
    player.player?.id ||
    null;

  if (uid) {

    const byUid = await env.DB.prepare(
      `SELECT name, pin
       FROM members
       WHERE playhq_uid = ?`
    )
      .bind(uid)
      .first();

    if (byUid) {
      return byUid;
    }
  }


  const name =
    [
      player.firstName,
      player.lastName
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    player.name ||
    "";


  if (!name) {
    return null;
  }


  const normalized =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");


  const rows = await env.DB.prepare(
    `SELECT name, pin
     FROM members`
  ).all();


  return (
    rows.results || []
  ).find(
    r =>
      String(r.name)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "") === normalized
  ) || null;
}


/* =========================================================
   SAVE ROSTER
   ========================================================= */

async function saveRoster(env, grade, players, source) {

  /*
   * Clear the existing roster for this grade.
   */

  await env.DB.prepare(
    `DELETE FROM roster_players
     WHERE grade = ?`
  )
    .bind(grade)
    .run();


  /*
   * Insert the new players.
   *
   * IMPORTANT:
   * These are the ONLY roster_players columns that
   * actually exist in your database.
   */

  const statements = players.map((p, i) => {

    const name =
      [
        p.firstName,
        p.lastName
      ]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      p.name ||
      "Unknown Player";


    const uid =
      p.playhq_uid ||
      p.playhq_uid ||
      p.id ||
      p.uid ||
      p.playerId ||
      p.player?.id ||
      null;


    return env.DB.prepare(
      `INSERT INTO roster_players
       (grade, name, playhq_uid, pin, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        grade,
        name,
        uid,
        p.pin || null,
        i
      );
  });


  if (statements.length) {
    await env.DB.batch(statements);
  }


  /*
   * roster_state ONLY contains:
   *
   * grade
   * source
   */

  await env.DB.prepare(
    `INSERT INTO roster_state
     (grade, source)
     VALUES (?, ?)
     ON CONFLICT(grade)
     DO UPDATE SET
       source = excluded.source`
  )
    .bind(
      grade,
      source
    )
    .run();
}


/* =========================================================
   PLAYHQ IMPORT
   ========================================================= */

async function importPlayHQRoster(env, grade) {

  const teamId =
    GRADES[grade].teamId;


  const url =
    `https://api.playhq.com/v1/organizations/${env.PLAYHQ_ORG_ID}/teams/${teamId}/players`;


  let response;


  try {

    response = await fetch(
      url,
      {
        headers: {
          "Authorization":
            `Bearer ${env.PLAYHQ_API_KEY}`,

          "Accept":
            "application/json"
        }
      }
    );

  } catch (error) {

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

    const body =
      await response.text();


    console.error(
      `PlayHQ returned ${response.status} for ${grade}:`,
      body.slice(0, 300)
    );


    return {
      updated: false,
      reason: "http_error",
      status: response.status
    };
  }


  let data;


  try {

    data =
      await response.json();

  } catch (error) {

    return {
      updated: false,
      reason: "json_parse_error"
    };
  }


  const rawPlayers =
    Array.isArray(data)
      ? data
      : (
          Array.isArray(data.players)
            ? data.players
            : []
        );


  /*
   * Never erase an existing roster if PlayHQ
   * returns an empty list.
   */

  if (
    !Array.isArray(rawPlayers) ||
    rawPlayers.length === 0
  ) {

    return {
      updated: false,
      reason: "empty"
    };
  }


  const enriched = [];

  let matchedCount = 0;


  for (const player of rawPlayers) {

    const member =
      await lookupMember(
        env,
        player
      );


    const pin =
      member?.pin || null;


    if (pin) {
      matchedCount++;
    }


    enriched.push({
      ...player,
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


/* =========================================================
   SYNC ALL GRADES
   ========================================================= */

async function syncAllGrades(env) {

  for (
    const grade of Object.keys(GRADES)
  ) {

    try {

      await importPlayHQRoster(
        env,
        grade
      );

    } catch (error) {

      console.error(
        `PlayHQ sync failed for ${grade}`,
        error
      );
    }
  }
}


/* =========================================================
   WORKER
   ========================================================= */

export default {

  async scheduled(
    controller,
    env,
    ctx
  ) {

    ctx.waitUntil(
      syncAllGrades(env)
    );
  },


  async fetch(
    request,
    env
  ) {

    /*
     * CORS
     */

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          headers:
            getCorsHeaders(request)
        }
      );
    }


    const url =
      new URL(request.url);

    const path =
      url.pathname;


    try {


      /* =====================================================
         DEBUG ENV
         ===================================================== */

      if (
        path === "/api/debug/env" &&
        request.method === "GET"
      ) {

        return json(
          request,
          {
            hasPasscode:
              !!env.ADMIN_PASSCODE,

            passcodeLength:
              env.ADMIN_PASSCODE?.length,

            passcodeFirstChar:
              env.ADMIN_PASSCODE?.[0]
          }
        );
      }


      /* =====================================================
         ADMIN STATUS
         ===================================================== */

      if (
        path === "/api/admin/status" &&
        request.method === "GET"
      ) {

        return json(
          request,
          {
            authenticated:
              await requireAdmin(
                request,
                env
              )
          }
        );
      }


      /* =====================================================
         ADMIN LOGIN
         ===================================================== */

      if (
        path === "/api/admin/login" &&
        request.method === "POST"
      ) {

        const {
          passcode
        } = await request.json();


        if (
          !env.ADMIN_PASSCODE ||
          passcode !==
            env.ADMIN_PASSCODE
        ) {

          return json(
            request,
            {
              error:
                "Invalid passcode"
            },
            401
          );
        }


        return json(
          request,
          {
            ok: true
          }
        );
      }


      /* =====================================================
         ADMIN LOGOUT
         ===================================================== */

      if (
        path === "/api/admin/logout" &&
        request.method === "POST"
      ) {

        return json(
          request,
          {
            ok: true
          }
        );
      }


      /* =====================================================
         ADMIN MOCK / CLEAR
         ===================================================== */

      const adminMatch =
        path.match(
          /^\/api\/admin\/(mock|clear|clear-team)$/
        );


      if (
        adminMatch &&
        request.method === "POST"
      ) {

        if (
          !(await requireAdmin(
            request,
            env
          ))
        ) {

          return json(
            request,
            {
              error:
                "Unauthorized"
            },
            401
          );
        }


        const {
          grade
        } = await request.json();


        if (
          !isGrade(grade)
        ) {

          return json(
            request,
            {
              error:
                "Invalid grade"
            },
            400
          );
        }


        const action =
          adminMatch[1];


        /* ---------------------------------------------------
           MOCK 22
           --------------------------------------------------- */

        if (
          action === "mock"
        ) {

          const players =
            await mockPlayers(
              env,
              grade
            );


          /*
           * If there are fewer than 22 members,
           * tell the frontend instead of silently
           * creating a smaller roster.
           */

          if (
            players.length < 22
          ) {

            return json(
              request,
              {
                error:
                  `Only ${players.length} members are available. 22 are required to create a mock roster.`
              },
              400
            );
          }


          await saveRoster(
            env,
            grade,
            players,
            "mock"
          );


          return json(
            request,
            {
              ok: true,
              players
            }
          );
        }


        /* ---------------------------------------------------
           CLEAR
           --------------------------------------------------- */

        if (
          action === "clear"
        ) {

          await env.DB.prepare(
            `DELETE FROM roster_players
             WHERE grade = ?`
          )
            .bind(grade)
            .run();


          await env.DB.prepare(
            `DELETE FROM roster_state
             WHERE grade = ?`
          )
            .bind(grade)
            .run();


          return json(
            request,
            {
              ok: true
            }
          );
        }


        /* ---------------------------------------------------
           CLEAR TEAM
           --------------------------------------------------- */

        if (
          action === "clear-team"
        ) {

          await env.DB.batch([

            env.DB.prepare(
              `DELETE FROM roster_players
               WHERE grade = ?`
            )
              .bind(grade),

            env.DB.prepare(
              `DELETE FROM roster_state
               WHERE grade = ?`
            )
              .bind(grade)

          ]);


          return json(
            request,
            {
              ok: true
            }
          );
        }
      }


      /* =====================================================
         GET ROSTER
         ===================================================== */

      const rosterMatch =
        path.match(
          /^\/api\/roster\/(league|reserves|colts|thirds)$/
        );


      if (
        rosterMatch &&
        request.method === "GET"
      ) {

        const grade =
          rosterMatch[1];


        return json(
          request,
          await getRoster(
            env,
            grade
          )
        );
      }


      /* =====================================================
         PLAYHQ SYNC
         ===================================================== */

      const playhqMatch =
        path.match(
          /^\/api\/roster\/(league|reserves|colts|thirds)\/playhq$/
        );


      if (
        playhqMatch &&
        request.method === "POST"
      ) {

        const grade =
          playhqMatch[1];


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


        return json(
          request,
          {
            ...result,
            ...current
          }
        );
      }


      /* =====================================================
         NOT FOUND
         ===================================================== */

      return json(
        request,
        {
          error:
            "Not found"
        },
        404
      );


    } catch (error) {

      console.error(
        error
      );


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
