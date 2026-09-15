const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const USERS_FILE = path.join(__dirname, 'users.json');
const DATABASE_FILE = path.join(__dirname, 'driveeasy.db');

const cars = [
  { id: 1, name: 'Hyundai Verna', type: 'Premium Sedan', seats: 5, transmission: 'Automatic', pricePerDay: 2500 },
  { id: 2, name: 'Volkswagen Virtus', type: 'Premium Sedan', seats: 5, transmission: 'Automatic', pricePerDay: 2700 },
  { id: 3, name: 'Honda City', type: 'Sedan', seats: 5, transmission: 'Automatic', pricePerDay: 2400 },
  { id: 4, name: 'Mahindra Thar Roxx', type: 'SUV', seats: 5, transmission: 'Manual', pricePerDay: 3200 },
  { id: 5, name: 'Hyundai Creta', type: 'SUV', seats: 5, transmission: 'Automatic', pricePerDay: 2900 },
  { id: 6, name: 'Maruti Suzuki Brezza', type: 'Compact SUV', seats: 5, transmission: 'Automatic', pricePerDay: 2200 },
  { id: 7, name: 'Tata Harrier', type: 'SUV', seats: 5, transmission: 'Automatic', pricePerDay: 3100 },
  { id: 8, name: 'Toyota Innova', type: 'MUV', seats: 7, transmission: 'Automatic', pricePerDay: 3600 },
  { id: 9, name: 'Toyota Fortuner', type: 'Luxury SUV', seats: 7, transmission: 'Automatic', pricePerDay: 5500 },
  { id: 10, name: 'Maruti Suzuki Baleno', type: 'Hatchback', seats: 5, transmission: 'Manual', pricePerDay: 1800 },
  { id: 11, name: 'Maruti Suzuki Swift', type: 'Hatchback', seats: 5, transmission: 'Manual', pricePerDay: 1700 },
  { id: 12, name: 'Tata Altroz', type: 'Hatchback', seats: 5, transmission: 'Manual', pricePerDay: 1900 }
];

const database = new DatabaseSync(DATABASE_FILE);
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    car_id INTEGER NOT NULL,
    car_name TEXT NOT NULL,
    location TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    return_date TEXT NOT NULL,
    image TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const savedUserCount = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (savedUserCount === 0) {
  try {
    const savedUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const insertUser = database.prepare(
      'INSERT OR IGNORE INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    );
    for (const user of savedUsers) {
      if (user.name && user.email && user.passwordHash) {
        insertUser.run(user.name, user.email, user.passwordHash);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Unable to migrate saved users:', error.message);
    }
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function isValidDateRange(pickupDate, returnDate) {
  const today = new Date().toISOString().slice(0, 10);
  return pickupDate && returnDate && /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(returnDate) && pickupDate >= today && pickupDate <= returnDate;
}

function isAvailable(carId, pickupDate, returnDate) {
  const booking = database.prepare(`
    SELECT id FROM bookings
    WHERE car_id = ? AND pickup_date <= ? AND return_date >= ?
  `).get(carId, returnDate, pickupDate);
  return !booking;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    response.end();
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', service: 'DriveEasy API' });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/cars') {
    const pickupDate = requestUrl.searchParams.get('pickupDate');
    const returnDate = requestUrl.searchParams.get('returnDate');
    const location = requestUrl.searchParams.get('location');

    if (!location || !isValidDateRange(pickupDate, returnDate)) {
      sendJson(response, 400, { error: 'Location, pickup date, and a valid return date are required.' });
      return;
    }

    const availableCars = cars.filter(car => isAvailable(car.id, pickupDate, returnDate));
    sendJson(response, 200, { location, pickupDate, returnDate, cars: availableCars });
    return;
  }

  if (request.method === 'POST' && (requestUrl.pathname === '/api/auth/signup' || requestUrl.pathname === '/api/auth/login')) {
    try {
      const credentials = await readBody(request);
      const email = String(credentials.email || '').trim().toLowerCase();
      const password = String(credentials.password || '');

      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 6) {
        sendJson(response, 400, { error: 'Enter a valid email and a password with at least 6 characters.' });
        return;
      }

      if (requestUrl.pathname.endsWith('/signup')) {
        const name = String(credentials.name || '').trim();
        if (!name) {
          sendJson(response, 400, { error: 'Your full name is required.' });
          return;
        }
        const existingUser = database.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existingUser) {
          sendJson(response, 409, { error: 'An account with this email already exists.' });
          return;
        }
        database.prepare(
          'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
        ).run(name, email, hashPassword(password));
        sendJson(response, 201, { message: 'Account created successfully.', user: { name, email } });
        return;
      }

      const user = database.prepare(
        'SELECT name, email FROM users WHERE email = ? AND password_hash = ?'
      ).get(email, hashPassword(password));
      if (!user) {
        sendJson(response, 401, { error: 'Email or password is incorrect.' });
        return;
      }
      sendJson(response, 200, { message: 'Login successful.', user: { name: user.name, email: user.email } });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/bookings') {
    try {
      const booking = await readBody(request);
      const car = cars.find(item => item.name.toLowerCase() === String(booking.carName || '').toLowerCase());
      const userEmail = String(booking.userEmail || '').trim().toLowerCase();

      if (!car || !isValidDateRange(booking.pickupDate, booking.returnDate) || !userEmail) {
        sendJson(response, 400, { error: 'A signed-in user, valid car name, pickup date, and return date are required.' });
        return;
      }

      if (!database.prepare('SELECT id FROM users WHERE email = ?').get(userEmail)) {
        sendJson(response, 401, { error: 'Please log in before creating a booking.' });
        return;
      }

      if (!isAvailable(car.id, booking.pickupDate, booking.returnDate)) {
        sendJson(response, 409, { error: 'That car is already booked for the selected dates.' });
        return;
      }

      const savedBooking = database.prepare(`
        INSERT INTO bookings
          (user_email, car_id, car_name, location, pickup_date, return_date, image)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userEmail,
        car.id,
        car.name,
        booking.location || 'Not specified',
        booking.pickupDate,
        booking.returnDate,
        booking.image || ''
      );
      const bookingRecord = database.prepare(`
        SELECT id, car_id AS carId, car_name AS carName, location,
          pickup_date AS pickupDate, return_date AS returnDate, image, created_at AS createdAt
        FROM bookings WHERE id = ?
      `).get(Number(savedBooking.lastInsertRowid));
      sendJson(response, 201, { message: 'Booking created successfully.', booking: bookingRecord });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/bookings') {
    const userEmail = String(requestUrl.searchParams.get('email') || '').trim().toLowerCase();
    if (!userEmail) {
      sendJson(response, 400, { error: 'A user email is required.' });
      return;
    }
    const userBookings = database.prepare(`
      SELECT id, car_id AS carId, car_name AS carName, location,
        pickup_date AS pickupDate, return_date AS returnDate, image, created_at AS createdAt
      FROM bookings WHERE user_email = ? ORDER BY id DESC
    `).all(userEmail);
    sendJson(response, 200, { bookings: userBookings });
    return;
  }

  if (request.method === 'DELETE' && requestUrl.pathname.startsWith('/api/bookings/')) {
    try {
      const bookingId = Number(requestUrl.pathname.split('/').pop());
      const cancellation = await readBody(request);
      const userEmail = String(cancellation.userEmail || '').trim().toLowerCase();
      const cancelledBooking = database.prepare(`
        SELECT id, car_id AS carId, car_name AS carName, location,
          pickup_date AS pickupDate, return_date AS returnDate, image, created_at AS createdAt
        FROM bookings WHERE id = ? AND user_email = ?
      `).get(bookingId, userEmail);

      if (!cancelledBooking) {
        sendJson(response, 404, { error: 'Booking not found.' });
        return;
      }

      database.prepare('DELETE FROM bookings WHERE id = ? AND user_email = ?').run(bookingId, userEmail);
      sendJson(response, 200, {
        message: 'Booking cancelled successfully.',
        reason: String(cancellation.reason || 'Not specified'),
        booking: cancelledBooking
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET') {
    const filePath = requestUrl.pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, requestUrl.pathname);
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const contentType = path.extname(filePath) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`DriveEasy is running at http://localhost:${PORT}`);
});
