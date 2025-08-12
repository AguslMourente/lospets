// server/server.js
require("dotenv").config();

const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const pool = require("./db");
const { uploadDataURI } = require("./cloudinary");
const algolia = require("./services/algolia");
const { sendReportEmail } = require("./services/mail");

const app = express();

/* ============ Middlewares ============ */
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* ============ Healthcheck ============ */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ============ AUTH HELPERS ============ */
const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });

const authRequired = (req, res, next) => {
  const header = req.get("Authorization") || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token)
    return res.status(401).json({ error: "missing_token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
};

/* ============ AUTH ROUTES ============ */
// POST /auth/signup
// body: { email, password, fullName, phone?, location? }
app.post("/auth/signup", async (req, res) => {
  const { email, password, fullName, phone, location } = req.body || {};
  if (!email || !password || !fullName)
    return res.status(400).json({ error: "missing_fields" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const emailL = String(email).trim().toLowerCase();
    const exists = await client.query(
      "SELECT 1 FROM auth WHERE lower(email)=lower($1)",
      [emailL]
    );
    if (exists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "email_in_use" });
    }

    const u = await client.query(
      `INSERT INTO users (full_name, phone, location)
       VALUES ($1,$2,$3)
       RETURNING id, full_name AS "fullName", phone, location, created_at AS "createdAt"`,
      [fullName, phone ?? null, location ?? null]
    );

    const hash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO auth (user_id, email, password_hash)
       VALUES ($1,$2,$3)`,
      [u.rows[0].id, emailL, hash]
    );

    await client.query("COMMIT");
    return res.status(201).json(u.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("signup_error:", e);
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

// POST /auth/login
// body: { email, password } -> { token }
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "missing_fields" });

  try {
    const emailL = String(email).trim().toLowerCase();
    const r = await pool.query(
      `SELECT user_id, password_hash
       FROM auth
       WHERE lower(email)=lower($1)`,
      [emailL]
    );
    if (!r.rowCount) return res.status(401).json({ error: "invalid_credentials" });

    const row = r.rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = signToken(row.user_id);
    return res.json({ token });
  } catch (e) {
    console.error("login_error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// GET /me  (requiere Authorization: Bearer <token>)
app.get("/me", authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, full_name AS "fullName", phone, location, created_at AS "createdAt"
       FROM users
       WHERE id=$1`,
      [req.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: "user_not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("me_error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

/* ============ PETS ============ */
/** POST /pets  (Auth)
 * body: { name, location?, lat?, lng?, imageDataURI? }
 */
app.post("/pets", authRequired, async (req, res) => {
  try {
    const { name, location, lat, lng, imageDataURI } = req.body || {};
    if (!name) return res.status(400).json({ error: "missing_name" });

    const imageUrl = imageDataURI ? await uploadDataURI(imageDataURI) : null;

    const r = await pool.query(
      `INSERT INTO pets (user_id, name, location, lat, lng, image_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,'lost')
       RETURNING id, user_id AS "userId", name, location, lat, lng, image_url AS "imageUrl", status, created_at AS "createdAt"`,
      [
        req.userId,
        name,
        location ?? null,
        lat !== undefined ? Number(lat) : null,
        lng !== undefined ? Number(lng) : null,
        imageUrl,
      ]
    );

    const pet = r.rows[0];
    await algolia.indexPet({
      id: pet.id,
      name: pet.name,
      status: pet.status,
      location: pet.location,
      image_url: pet.imageUrl,
      lat: pet.lat,
      lng: pet.lng,
    });

    res.status(201).json(pet);
  } catch (e) {
    console.error("pets_create_error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/** PUT /pets/:id  (Auth) actualizar datos o status (lost|found) */
app.put("/pets/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);

    // validar ownership
    const owner = await pool.query(`SELECT user_id FROM pets WHERE id=$1`, [id]);
    if (!owner.rowCount) return res.status(404).json({ error: "not_found" });
    if (owner.rows[0].user_id !== req.userId)
      return res.status(403).json({ error: "forbidden" });

    const { name, location, status, lat, lng, imageDataURI } = req.body || {};
    let imageUrl = null;
    if (imageDataURI && imageDataURI.startsWith("data:image/")) {
      imageUrl = await uploadDataURI(imageDataURI);
    }

    const r = await pool.query(
      `UPDATE pets SET
         name = COALESCE($1, name),
         location = COALESCE($2, location),
         status = COALESCE($3, status),
         lat = COALESCE($4, lat),
         lng = COALESCE($5, lng),
         image_url = COALESCE($6, image_url)
       WHERE id=$7
       RETURNING id, user_id AS "userId", name, location, lat, lng, image_url AS "imageUrl", status, created_at AS "createdAt"`,
      [
        name ?? null,
        location ?? null,
        status ?? null,
        lat !== undefined ? Number(lat) : null,
        lng !== undefined ? Number(lng) : null,
        imageUrl,
        id,
      ]
    );

    const pet = r.rows[0];
    await algolia.indexPet({
      id: pet.id,
      name: pet.name,
      status: pet.status,
      location: pet.location,
      image_url: pet.imageUrl,
      lat: pet.lat,
      lng: pet.lng,
    });

    res.json(pet);
  } catch (e) {
    console.error("pets_update_error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/** GET /my/pets  (Auth) */
app.get("/my/pets", authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, user_id AS "userId", name, location, lat, lng, image_url AS "imageUrl", status, created_at AS "createdAt"
       FROM pets WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("my_pets_error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/** GET /pets-near?lat=&lng=&radiusKm=2  (público: usa Algolia) */
app.get("/pets-near", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Number(req.query.radiusKm ?? 2);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "invalid_lat_lng" });
    }
    const { hits } = await algolia.searchNearby(lat, lng, radiusKm * 1000);
    res.json(hits || []);
  } catch (e) {
    console.error("pets_near_error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============ REPORTS ============ */
/** POST /reports  (público)
 * body: { petId, reporterName, reporterPhone, location?, details? }
 * Guarda el reporte y manda email al dueño.
 */
app.post("/reports", async (req, res) => {
  try {
    const { petId, reporterName, reporterPhone, location, details } = req.body || {};
    if (!petId || !reporterName || !reporterPhone) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const petq = await pool.query(
      `SELECT p.id, p.name, p.user_id, a.email
         FROM pets p
         JOIN auth a ON a.user_id = p.user_id
        WHERE p.id=$1`,
      [petId]
    );
    if (!petq.rowCount) return res.status(404).json({ error: "pet_not_found" });

    const pet = petq.rows[0];

    const r = await pool.query(
      `INSERT INTO reports (pet_id, reporter_name, reporter_phone, location, details)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, pet_id AS "petId", reporter_name AS "reporterName",
                 reporter_phone AS "reporterPhone", location, details, created_at AS "createdAt"`,
      [petId, reporterName, reporterPhone, location ?? null, details ?? null]
    );

    const html = `
      <h2>Avistaje de ${pet.name}</h2>
      <p><b>Quien reporta:</b> ${reporterName} (${reporterPhone})</p>
      ${location ? `<p><b>Ubicación:</b> ${location}</p>` : ""}
      ${details ? `<p><b>Detalles:</b> ${details}</p>` : ""}
    `;
    await sendReportEmail({
      to: pet.email,
      subject: `Posible avistaje de ${pet.name}`,
      html,
    });

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("report_create_error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============ START ============ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`lostpets API running on http://localhost:${PORT}`);
});
