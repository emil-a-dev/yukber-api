const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'yukber_secret_2026';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Upstash Redis (persistent storage) ───────────────────────────────────────
async function kvCommand(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data.result;
  } catch (e) { console.error('Redis error:', e.message); return null; }
}

async function loadDB() {
  const data = await kvCommand('GET', 'yukber_db');
  if (!data) return;
  try {
    const saved = JSON.parse(data);
    if (saved.users) Object.assign(db.users, saved.users);
    if (saved.otps)  Object.assign(db.otps,  saved.otps);
    if (saved.cars)  Object.assign(db.cars,  saved.cars);
    if (saved.routes)             db.routes             = saved.routes;
    if (saved.passengerRequests)  db.passengerRequests  = saved.passengerRequests;
    if (saved.parcels)            db.parcels            = saved.parcels;
    if (saved.reviews)            db.reviews            = saved.reviews;
  } catch (e) { console.error('DB parse error:', e.message); }
}

async function saveDB() {
  await kvCommand('SET', 'yukber_db', JSON.stringify(db));
}

// ─── SMS via Eskiz.uz ─────────────────────────────────────────────────────────
async function sendSMS(phone, message) {
  const email    = process.env.ESKIZ_EMAIL;
  const password = process.env.ESKIZ_PASSWORD;
  if (!email || !password) {
    console.log(`[SMS demo] ${phone}: ${message}`);
    return;
  }
  try {
    const authRes = await fetch('https://notify.eskiz.uz/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const authData = await authRes.json();
    const eskizToken = authData.data?.token;
    if (!eskizToken) { console.error('Eskiz auth failed:', JSON.stringify(authData)); return; }
    const phoneClean = phone.replace(/\D/g, '');
    await fetch('https://notify.eskiz.uz/api/message/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${eskizToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile_phone: phoneClean, message, from: '4546', callback_url: '' }),
    });
    console.log(`SMS sent to ${phone}`);
  } catch (e) { console.error('SMS error:', e.message); }
}

// ─── Middleware: load DB + auto-save on mutations ──────────────────────────────
app.use(async (req, res, next) => {
  await loadDB();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origJson = res.json.bind(res);
    res.json = function (body) {
      res.json = origJson;
      saveDB().catch(e => console.error('Redis save error:', e));
      return origJson(body);
    };
  }
  next();
});

// Lazy-load formidable only when needed (avoids top-level crash on Vercel)
function parseForm(req) {
  return new Promise((resolve, reject) => {
    if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart')) {
      return resolve({ fields: req.body || {}, files: {} });
    }
    try {
      const { Formidable } = require('formidable');
      const form = new Formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        const flat = {};
        for (const [k, v] of Object.entries(fields)) flat[k] = Array.isArray(v) ? v[0] : v;
        const flatFiles = {};
        for (const [k, v] of Object.entries(files)) flatFiles[k] = Array.isArray(v) ? v : [v];
        resolve({ fields: flat, files: flatFiles });
      });
    } catch (e) { reject(e); }
  });
}

async function readFileBuffer(f) {
  const fs = require('fs');
  return fs.promises.readFile(f.filepath || f.path);
}

// ─── In-memory DB ──────────────────────────────────────────────────────────────
const db = {
  users: {},        // phone → user
  otps:  {},        // phone → otp
  cars:  {},        // userId → [car]
  routes: [],
  passengerRequests: [],
  parcels: [],
  reviews: [],
};

// Seed demo data
const demoUserId = 'demo-user-001';
db.users['+998901234567'] = {
  id: demoUserId, firstName: 'Алишер', lastName: 'Каримов',
  phone: '+998901234567', email: 'demo@yukber.uz',
  avatar: null, role: 'driver', isVerified: true,
  rating: 4.8, tripsCount: 42, createdAt: new Date().toISOString(),
};
db.cars[demoUserId] = [
  {
    id: 'car-001', userId: demoUserId,
    make: 'Chevrolet', model: 'Malibu', year: 2020,
    plate: '01A123AA', seats: 4,
    photos: [], isPrimary: true, isActive: true,
    note: 'Чистый, кондиционер', createdAt: new Date().toISOString(),
  }
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Auto-recreate user after cold start (serverless stateless)
    if (!db.users[decoded.phone]) {
      const uid = decoded.id || uuidv4();
      db.users[decoded.phone] = {
        id: uid, firstName: 'Пользователь', lastName: null,
        phone: decoded.phone, email: null, avatar: null,
        role: decoded.role || 'passenger', isVerified: true,
        rating: 5.0, tripsCount: 0, createdAt: new Date().toISOString(),
      };
      db.cars[uid] = [];
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Токен недействителен' });
  }
}

function makeToken(user) {
  return jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function userPublic(u) {
  return {
    id: u.id, firstName: u.firstName, lastName: u.lastName,
    phone: u.phone, email: u.email, avatar: u.avatar,
    role: u.role, isVerified: u.isVerified,
    rating: u.rating, tripsCount: u.tripsCount, createdAt: u.createdAt,
  };
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });
  const otp = '1224'; // Fixed test OTP
  db.otps[phone] = otp;
  console.log(`[OTP] ${phone}: ${otp}`);
  res.json({ message: 'OTP отправлен', phone });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp, code } = req.body;
  const entered = otp || code;
  const stored = db.otps[phone];
  if (stored && entered !== stored && entered !== '1224') {
    return res.status(400).json({ error: 'Неверный код подтверждения' });
  }
  delete db.otps[phone];
  let user = Object.values(db.users).find(u => u.phone === phone);
  if (!user) {
    // Auto-register new user
    const id = uuidv4();
    user = {
      id, firstName: 'Пользователь', lastName: '',
      phone, email: null, avatar: null,
      role: 'passenger', isVerified: true,
      rating: 5.0, tripsCount: 0, createdAt: new Date().toISOString(),
    };
    db.users[phone] = user;
    db.cars[id] = [];
  }
  const token = makeToken(user);
  res.json({ token, user: userPublic(user) });
});

app.post('/auth/login', async (req, res) => {
  const { phone, otp, code } = req.body;
  const entered = otp || code;
  const stored = db.otps[phone];
  if (stored && entered !== stored && entered !== '1224') {
    return res.status(400).json({ error: 'Неверный код подтверждения' });
  }
  delete db.otps[phone];
  let user = Object.values(db.users).find(u => u.phone === phone);
  if (!user) {
    const id = uuidv4();
    user = {
      id, firstName: 'Пользователь', lastName: '',
      phone, email: null, avatar: null,
      role: 'passenger', isVerified: true,
      rating: 5.0, tripsCount: 0, createdAt: new Date().toISOString(),
    };
    db.users[phone] = user;
    db.cars[id] = [];
  }
  const token = makeToken(user);
  res.json({ token, user: userPublic(user) });
});

app.post('/auth/register', (req, res) => {
  const { phone, firstName, lastName, email } = req.body;
  let user = Object.values(db.users).find(u => u.phone === phone);
  if (!user) {
    const id = uuidv4();
    user = {
      id, firstName: firstName || 'Пользователь', lastName: lastName || '',
      phone, email: email || null, avatar: null,
      role: 'passenger', isVerified: true,
      rating: 5.0, tripsCount: 0, createdAt: new Date().toISOString(),
    };
    db.users[phone] = user;
    db.cars[id] = [];
  } else {
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (email) user.email = email;
  }
  const token = makeToken(user);
  res.json({ token, user: userPublic(user) });
});

app.post('/auth/register.Driver', (req, res) => {
  const { phone, firstName, lastName } = req.body;
  let user = Object.values(db.users).find(u => u.phone === phone);
  if (!user) {
    const id = uuidv4();
    user = {
      id, firstName: firstName || 'Водитель', lastName: lastName || '',
      phone, email: null, avatar: null,
      role: 'driver', isVerified: true,
      rating: 5.0, tripsCount: 0, createdAt: new Date().toISOString(),
    };
    db.users[phone] = user;
    db.cars[id] = [];
  } else {
    user.role = 'driver';
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
  }
  const token = makeToken(user);
  res.json({ token, user: userPublic(user) });
});

app.post('/auth/switch-role', authMiddleware, (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  user.role = user.role === 'driver' ? 'passenger' : 'driver';
  const token = makeToken(user);
  res.json({ token, user: userPublic(user) });
});

app.put('/auth/update-profile', authMiddleware, (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const { firstName, lastName, email } = req.body;
  if (firstName) user.firstName = firstName;
  if (lastName !== undefined) user.lastName = lastName;
  if (email !== undefined) user.email = email;
  res.json({ user: userPublic(user) });
});

app.post('/auth/upload-avatar', authMiddleware, async (req, res) => {
  try {
    const user = Object.values(db.users).find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const { files } = await parseForm(req);
    const avatarFiles = files.avatar || [];
    if (avatarFiles.length > 0) {
      const buf = await readFileBuffer(avatarFiles[0]);
      user.avatar = `data:${avatarFiles[0].mimetype || 'image/jpeg'};base64,${buf.toString('base64')}`;
    }
    res.json({ user: userPublic(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── USER ──────────────────────────────────────────────────────────────────────
app.get('/user/me', authMiddleware, (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(userPublic(user));
});

app.get('/users', authMiddleware, (req, res) => {
  res.json(Object.values(db.users).map(userPublic));
});

// ─── CARS ──────────────────────────────────────────────────────────────────────
app.get('/my-cars', authMiddleware, (req, res) => {
  const cars = db.cars[req.user.id] || [];
  res.json(cars);
});

app.post('/add-car', authMiddleware, async (req, res) => {
  try {
    const { fields, files } = await parseForm(req);
    const { make, model, year, plate, seats, note } = fields;
    if (!make || !model) return res.status(400).json({ error: 'Укажите марку и модель автомобиля' });
    if (!year) return res.status(400).json({ error: 'Укажите год выпуска' });
    if (!plate) return res.status(400).json({ error: 'Укажите гос. номер' });

    const photoFiles = files.photos || files.photo || [];
    const photoUrls = [];
    for (const f of photoFiles) {
      const buf = await readFileBuffer(f);
      photoUrls.push(`data:${f.mimetype || 'image/jpeg'};base64,${buf.toString('base64')}`);
    }

    const car = {
      id: uuidv4(), userId: req.user.id,
      make, model,
      year: parseInt(year) || year,
      plate: plate.toUpperCase(),
      seats: parseInt(seats) || seats,
      photos: photoUrls,
      isPrimary: (db.cars[req.user.id] || []).length === 0,
      isActive: true, note: note || null,
      createdAt: new Date().toISOString(),
    };

    if (!db.cars[req.user.id]) db.cars[req.user.id] = [];
    db.cars[req.user.id].push(car);
    console.log(`Car added for user ${req.user.id}: ${make} ${model} ${year}`);
    res.status(201).json(car);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/car/:id', authMiddleware, (req, res) => {
  const cars = db.cars[req.user.id] || [];
  const idx = cars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Автомобиль не найден' });
  cars.splice(idx, 1);
  res.json({ message: 'Удалено' });
});

// ─── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/all-routes', authMiddleware, (req, res) => {
  const enriched = db.routes.map(r => ({
    ...r,
    driver: userPublic(Object.values(db.users).find(u => u.id === r.driverId) || {}),
    car: (db.cars[r.driverId] || [])[0] || null,
  }));
  res.json(enriched);
});

app.post('/add-route', authMiddleware, (req, res) => {
  const { pickupLocation, dropoffLocation, travelDate, departureTime, availableSeats, pricePerSeat, additionalNotes } = req.body;
  const route = {
    id: uuidv4(), driverId: req.user.id,
    pickupLocation, dropoffLocation, travelDate, departureTime,
    availableSeats: parseInt(availableSeats) || 1,
    pricePerSeat: parseFloat(pricePerSeat) || 0,
    additionalNotes: additionalNotes || null,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  db.routes.push(route);
  res.status(201).json(route);
});

// ─── PASSENGERS ────────────────────────────────────────────────────────────────
app.get('/passenger-requests', authMiddleware, (req, res) => {
  const enriched = db.passengerRequests.map(r => ({
    ...r,
    passenger: userPublic(Object.values(db.users).find(u => u.id === r.passengerId) || {}),
  }));
  res.json(enriched);
});

app.get('/my-passenger-requests', authMiddleware, (req, res) => {
  const mine = db.passengerRequests
    .filter(r => r.passengerId === req.user.id)
    .map(r => ({
      ...r,
      passenger: userPublic(Object.values(db.users).find(u => u.id === r.passengerId) || {}),
    }));
  res.json(mine);
});

app.post('/passenger-requests', authMiddleware, (req, res) => {
  const { from, to, date, timeFrom, timeTo } = req.body;
  const request = {
    id: uuidv4(), passengerId: req.user.id,
    from, to, date, timeFrom, timeTo: timeTo || null,
    status: 'pending', savedSearch: false,
    createdAt: new Date().toISOString(),
  };
  db.passengerRequests.push(request);
  res.status(201).json(request);
});

// ─── DRIVERS ───────────────────────────────────────────────────────────────────
app.get('/drivers/available', authMiddleware, (req, res) => {
  const drivers = Object.values(db.users)
    .filter(u => u.role === 'driver')
    .map(u => ({
      ...userPublic(u),
      cars: db.cars[u.id] || [],
      routes: db.routes.filter(r => r.driverId === u.id),
    }));
  res.json(drivers);
});

app.get('/drivers/parcel-available', authMiddleware, (req, res) => {
  const drivers = Object.values(db.users)
    .filter(u => u.role === 'driver')
    .map(userPublic);
  res.json(drivers);
});

app.get('/drivers/nearby', authMiddleware, (req, res) => {
  res.json([]);
});

app.get('/driver-accepted-requests', authMiddleware, (req, res) => {
  res.json([]);
});

app.get('/driver-saved-requests', authMiddleware, (req, res) => {
  res.json([]);
});

// ─── PARCELS ───────────────────────────────────────────────────────────────────
app.post('/deliver-parcel', authMiddleware, async (req, res) => {
  try {
    const { fields, files } = await parseForm(req);
    const photoFiles = files.photos || files.photo || [];
    const photoUrls = [];
    for (const f of photoFiles) {
      const buf = await readFileBuffer(f);
      photoUrls.push(`data:${f.mimetype || 'image/jpeg'};base64,${buf.toString('base64')}`);
    }
    const parcel = {
      id: uuidv4(), senderId: req.user.id,
      ...fields, photos: photoUrls,
      status: 'pending', createdAt: new Date().toISOString(),
    };
    db.parcels.push(parcel);
    res.status(201).json(parcel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRIPS ─────────────────────────────────────────────────────────────────────
app.post('/plan-trip', authMiddleware, (req, res) => {
  const trip = {
    id: uuidv4(), userId: req.user.id,
    ...req.body,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  res.status(201).json(trip);
});

// ─── REVIEWS ───────────────────────────────────────────────────────────────────
app.post('/reviews', authMiddleware, (req, res) => {
  const review = {
    id: uuidv4(), passengerId: req.user.id,
    ...req.body,
    rating: parseInt(req.body.rating) || 5,
    createdAt: new Date().toISOString(),
  };
  db.reviews.push(review);
  res.status(201).json(review);
});

// ─── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', name: 'Yukber API', version: '1.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Only listen when running directly (not on Vercel serverless)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Yukber API running on port ${PORT}`);
  });
}

module.exports = app;
