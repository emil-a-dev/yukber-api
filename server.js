const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'yukber_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

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
    req.user = jwt.verify(token, JWT_SECRET);
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
app.post('/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });
  const otp = '1234'; // Fixed OTP for demo
  db.otps[phone] = otp;
  console.log(`OTP for ${phone}: ${otp}`);
  res.json({ message: 'OTP отправлен', phone });
});

app.post('/auth/verify-otp', (req, res) => {
  const { phone, otp, code } = req.body;
  const entered = otp || code;
  // Accept any OTP for demo
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

app.post('/auth/login', (req, res) => {
  const { phone, otp, code } = req.body;
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

app.post('/auth/upload-avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (req.file) {
    const b64 = req.file.buffer.toString('base64');
    user.avatar = `data:${req.file.mimetype};base64,${b64}`;
  }
  res.json({ user: userPublic(user) });
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

app.post('/add-car', authMiddleware, upload.array('photos', 10), (req, res) => {
  const { make, model, year, plate, seats, note } = req.body;
  if (!make || !model) return res.status(400).json({ error: 'Укажите марку и модель автомобиля' });
  if (!year) return res.status(400).json({ error: 'Укажите год выпуска' });
  if (!plate) return res.status(400).json({ error: 'Укажите гос. номер' });

  const photoUrls = (req.files || []).map(f => {
    const b64 = f.buffer.toString('base64');
    return `data:${f.mimetype};base64,${b64}`;
  });

  const car = {
    id: uuidv4(),
    userId: req.user.id,
    make, model,
    year: parseInt(year) || year,
    plate: plate.toUpperCase(),
    seats: parseInt(seats) || seats,
    photos: photoUrls,
    isPrimary: (db.cars[req.user.id] || []).length === 0,
    isActive: true,
    note: note || null,
    createdAt: new Date().toISOString(),
  };

  if (!db.cars[req.user.id]) db.cars[req.user.id] = [];
  db.cars[req.user.id].push(car);

  console.log(`Car added for user ${req.user.id}: ${make} ${model} ${year}`);
  res.status(201).json(car);
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
app.post('/deliver-parcel', authMiddleware, upload.array('photos', 5), (req, res) => {
  const parcel = {
    id: uuidv4(), senderId: req.user.id,
    ...req.body,
    photos: (req.files || []).map(f => `data:${f.mimetype};base64,${f.buffer.toString('base64')}`),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.parcels.push(parcel);
  res.status(201).json(parcel);
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

app.listen(PORT, () => {
  console.log(`Yukber API running on port ${PORT}`);
});

module.exports = app;
