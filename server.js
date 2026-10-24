require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg'); // Le driver pour Neon
const crypto = require('crypto');
const path = require('path');

const app = express();

// ─── Connexion à Neon ───
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true }
});

// ─── Création des tables au démarrage ───
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        used INTEGER DEFAULT 0,
        used_by TEXT,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        device_id TEXT PRIMARY KEY,
        subscribed_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trajets (
        id SERIAL PRIMARY KEY,
        driver TEXT NOT NULL,
        vehicle TEXT NOT NULL,
        from_city TEXT NOT NULL,
        to_city TEXT NOT NULL,
        time TEXT NOT NULL,
        price INTEGER NOT NULL,
        phone TEXT NOT NULL,
        device_id TEXT,
        period_type TEXT NOT NULL DEFAULT 'once',
        start_date TEXT NOT NULL,
        end_date TEXT,
        pattern TEXT NOT NULL DEFAULT 'once',
        weekdays TEXT,
        month_days TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Connecté à Neon et tables vérifiées.");
  } catch (err) {
    console.error("❌ Erreur de connexion à Neon :", err.message);
  }
}
initDB();

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    httpOnly: true, 
    maxAge: 24 * 3600 * 1000,
    secure: true,
    sameSite: 'lax'
  }
}));

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// ─── ROUTES ADMIN ───
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.post('/api/admin/generate-code', requireAdmin, async (req, res) => {
  try {
    let code, tries = 0;
    let exists = true;
    while (exists && tries < 100) {
      code = `MOBI-${crypto.randomInt(1000, 9999)}`;
      const check = await pool.query('SELECT 1 FROM codes WHERE code=$1', [code]);
      exists = check.rowCount > 0;
      tries++;
    }
    if (tries >= 100) return res.status(500).json({ error: 'Réessayez' });

    await pool.query('INSERT INTO codes (code) VALUES ($1)', [code]);
    res.json({
      code,
      whatsappLink: `https://wa.me/?text=${encodeURIComponent(
        `Votre code Mobi-Campus : ${code}\n\nEnvoyez 100 FCFA au ${process.env.MERCHANT_PHONE} puis activez ce code sur le site pour 30 jours d'accès.`
      )}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/codes', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM codes ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const total = (await pool.query('SELECT COUNT(*) FROM codes')).rows[0].count;
  const used = (await pool.query('SELECT COUNT(*) FROM codes WHERE used=1')).rows[0].count;
  const trajets = (await pool.query('SELECT COUNT(*) FROM trajets')).rows[0].count;
  res.json({ total: parseInt(total), used: parseInt(used), available: parseInt(total) - parseInt(used), trajets: parseInt(trajets) });
});

app.delete('/api/admin/codes/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM codes WHERE id=$1 AND used=0', [req.params.id]);
  res.json({ ok: true });
});

// ─── ROUTES ÉTUDIANT ───
app.get('/api/status/:deviceId', async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE device_id=$1', [req.params.deviceId]);
  const user = result.rows[0];
  const active = user && new Date(user.subscribed_until) > new Date();
  res.json({ subscribed: !!active, until: user?.subscribed_until });
});

app.post('/api/activate', async (req, res) => {
  const { code, deviceId } = req.body;
  if (!code || !deviceId) return res.status(400).json({ error: 'Code et deviceId requis' });

  try {
    const row = (await pool.query('SELECT * FROM codes WHERE code=$1', [code.toUpperCase().trim()])).rows[0];
    if (!row) return res.status(404).json({ error: 'Code invalide' });
    if (row.used) return res.status(409).json({ error: 'Ce code a déjà été utilisé' });

    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE codes SET used=1, used_by=$1, used_at=CURRENT_TIMESTAMP WHERE id=$2', [deviceId, row.id]);
      await client.query(`
        INSERT INTO users (device_id, subscribed_until) VALUES ($1, $2)
        ON CONFLICT(device_id) DO UPDATE SET subscribed_until=$2
      `, [deviceId, until]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    
    res.json({ ok: true, until });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isTrajetActiveAt(t, when = new Date()) {
  if (!t.is_active) return false;
  const dayKey = when.toISOString().slice(0, 10);
  const endKey = t.end_date || '9999-12-31';
  if (dayKey < t.start_date || dayKey > endKey) return false;
  if (t.period_type === 'once') return dayKey === t.start_date;

  const jsDay = when.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const date = when.getDate();

  switch (t.pattern) {
    case 'everyday': return true;
    case 'weekdays': return isoDay >= 1 && isoDay <= 5;
    case 'weekend': return isoDay === 6 || isoDay === 7;
    case 'custom_days': return (t.weekdays || '').split(',').map(Number).includes(isoDay);
    case 'month_days': return (t.month_days || '').split(',').map(Number).includes(date);
    default: return false;
  }
}

app.get('/api/trajets', async (req, res) => {
  const target = req.query.date ? new Date(req.query.date) : new Date();
  const from = (req.query.from || '').toLowerCase().trim();
  const to = (req.query.to || '').toLowerCase().trim();

  const rows = (await pool.query('SELECT * FROM trajets WHERE is_active=1')).rows;
  const filtered = rows
    .filter(t => isTrajetActiveAt(t, target))
    .filter(t => !from || t.from_city.toLowerCase().includes(from))
    .filter(t => !to || t.to_city.toLowerCase().includes(to))
    .sort((a, b) => a.time.localeCompare(b.time));

  res.json(filtered);
});

app.post('/api/trajets', async (req, res) => {
  const {
    driver, vehicle, from, to, time, price, phone, deviceId,
    period_type, start_date, end_date, pattern, weekdays, month_days
  } = req.body;

  try {
    const user = (await pool.query('SELECT * FROM users WHERE device_id=$1', [deviceId])).rows[0];
    if (!user || new Date(user.subscribed_until) <= new Date()) {
      return res.status(403).json({ error: 'Abonnement requis' });
    }
    if (!driver || !from || !to || !phone) return res.status(400).json({ error: 'Champs manquants' });
    if (!/^\+223[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Téléphone invalide (+223XXXXXXXX)' });

    const priceNum = parseInt(String(price).replace(/[^0-9]/g, ''), 10);
    if (!priceNum || priceNum < 50 || priceNum > 10000) {
      return res.status(400).json({ error: 'Prix invalide (50-10000 FCFA)' });
    }

    const pType = period_type === 'period' ? 'period' : 'once';
    const patern = ['once','everyday','weekdays','weekend','custom_days','month_days'].includes(pattern) ? pattern : 'once';
    if (!start_date) return res.status(400).json({ error: 'Date de début requise' });

    if (pType === 'period') {
      if (patern === 'once') return res.status(400).json({ error: 'Motif requis' });
      if (end_date && end_date < start_date) return res.status(400).json({ error: 'Date de fin invalide' });
      if (patern === 'custom_days' && !weekdays) return res.status(400).json({ error: 'Choisissez des jours' });
      if (patern === 'month_days' && !month_days) return res.status(400).json({ error: 'Choisissez des dates' });
    }

    const result = await pool.query(`
      INSERT INTO trajets
        (driver, vehicle, from_city, to_city, time, price, phone, device_id,
         period_type, start_date, end_date, pattern, weekdays, month_days)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      driver, vehicle, from, to, time, priceNum, phone, deviceId,
      pType, start_date, pType === 'period' ? (end_date || null) : null,
      patern,
      patern === 'custom_days' ? weekdays : null,
      patern === 'month_days' ? month_days : null
    ]);

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Mobi-Campus : http://localhost:${process.env.PORT || 3000}`);
  console.log(`🔐 Admin : http://localhost:${process.env.PORT || 3000}/admin.html`);
});