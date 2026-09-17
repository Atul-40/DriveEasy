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
    pickup_time TEXT NOT NULL DEFAULT '00:00',
    return_time TEXT NOT NULL DEFAULT '23:59',
    image TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
const bookingColumns = database.prepare('PRAGMA table_info(bookings)').all();
if (!bookingColumns.some(column => column.name === 'pickup_time')) {
  database.exec("ALTER TABLE bookings ADD COLUMN pickup_time TEXT NOT NULL DEFAULT '00:00'");
}
if (!bookingColumns.some(column => column.name === 'return_time')) {
  database.exec("ALTER TABLE bookings ADD COLUMN return_time TEXT NOT NULL DEFAULT '23:59'");
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

function isValidDateRange(pickupDate, returnDate, pickupTime = '00:00', returnTime = '23:59') {
  const today = new Date().toISOString().slice(0, 10);
  return pickupDate && returnDate && /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(returnDate) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(pickupTime) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(returnTime) && pickupDate >= today &&
    `${pickupDate}T${pickupTime}` < `${returnDate}T${returnTime}`;
}

function isAvailable(carId, pickupDate, returnDate, pickupTime = '00:00', returnTime = '23:59') {
  const booking = database.prepare(`
    SELECT id FROM bookings
    WHERE car_id = ? AND pickup_date || 'T' || pickup_time < ? AND return_date || 'T' || return_time > ?
  `).get(carId, `${returnDate}T${returnTime}`, `${pickupDate}T${pickupTime}`);
  return !booking;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

  if (request.method === 'GET' && requestUrl.pathname === '/api/users') {
    const savedUsers = database.prepare(`
      SELECT users.id, users.name, users.email, users.created_at AS createdAt,
        COUNT(bookings.id) AS bookingCount,
        COALESCE(GROUP_CONCAT(DISTINCT bookings.car_name), 'None') AS bookingCars
      FROM users
      LEFT JOIN bookings ON bookings.user_email = users.email
      GROUP BY users.id
      ORDER BY users.id DESC
    `).all();
    sendJson(response, 200, { users: savedUsers });
    return;
  }

  if (request.method === 'PUT' && requestUrl.pathname.startsWith('/api/users/')) {
    try {
      const userId = Number(requestUrl.pathname.split('/').pop());
      const userData = await readBody(request);
      const name = String(userData.name || '').trim();
      const email = String(userData.email || '').trim().toLowerCase();

      if (!Number.isInteger(userId) || userId < 1 || !name || !/^\S+@\S+\.\S+$/.test(email)) {
        sendJson(response, 400, { error: 'A valid name and email address are required.' });
        return;
      }

      const currentUser = database.prepare('SELECT email FROM users WHERE id = ?').get(userId);
      if (!currentUser) {
        sendJson(response, 404, { error: 'User not found.' });
        return;
      }

      const duplicateUser = database.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
      if (duplicateUser) {
        sendJson(response, 409, { error: 'That email address is already in use.' });
        return;
      }

      database.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, userId);
      database.prepare('UPDATE bookings SET user_email = ? WHERE user_email = ?').run(email, currentUser.email);
      const updatedUser = database.prepare(`
        SELECT users.id, users.name, users.email, users.created_at AS createdAt,
          COUNT(bookings.id) AS bookingCount,
          COALESCE(GROUP_CONCAT(DISTINCT bookings.car_name), 'None') AS bookingCars
        FROM users LEFT JOIN bookings ON bookings.user_email = users.email
        WHERE users.id = ? GROUP BY users.id
      `).get(userId);
      sendJson(response, 200, { message: 'User updated successfully.', user: updatedUser });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'DELETE' && requestUrl.pathname.startsWith('/api/users/')) {
    try {
      const userId = Number(requestUrl.pathname.split('/').pop());
      const user = database.prepare('SELECT email FROM users WHERE id = ?').get(userId);
      if (!Number.isInteger(userId) || !user) {
        sendJson(response, 404, { error: 'User not found.' });
        return;
      }

      database.prepare('DELETE FROM bookings WHERE user_email = ?').run(user.email);
      database.prepare('DELETE FROM users WHERE id = ?').run(userId);
      sendJson(response, 200, { message: 'User deleted successfully.' });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/users') {
    const savedUsers = database.prepare(`
      SELECT users.id, users.name, users.email, users.created_at AS createdAt,
        COUNT(bookings.id) AS bookingCount,
        COALESCE(GROUP_CONCAT(DISTINCT bookings.car_name), 'None') AS bookingCars
      FROM users
      LEFT JOIN bookings ON bookings.user_email = users.email
      GROUP BY users.id
      ORDER BY users.id DESC
    `).all();
    const rows = savedUsers.map(user => `
      <tr data-user-id="${escapeHtml(user.id)}">
        <td>${escapeHtml(user.id)}</td>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.createdAt)}</td>
        <td>${escapeHtml(user.bookingCount)}</td>
        <td>${escapeHtml(user.bookingCars)}</td>
        <td><button type="button" class="edit-button" onclick="editUser(${escapeHtml(user.id)})">Edit</button> <button type="button" class="delete-button" onclick="deleteUser(${escapeHtml(user.id)})">Delete</button></td>
      </tr>`).join('');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DriveEasy Users</title><style>
body{margin:0;padding:40px;background:#f4f6f8;color:#17202a;font-family:Arial,sans-serif}
main{max-width:1100px;margin:auto;background:#fff;padding:32px;border:1px solid #d9dee3;border-radius:8px;box-shadow:0 4px 14px #00000012}
h1{margin:0 0 8px;font-size:28px}p{margin:0 0 24px;color:#5c6670}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:14px 16px;border-bottom:1px solid #e1e5e8}th{background:#263746;color:#fff;font-size:13px;text-transform:uppercase;letter-spacing:.04em}tbody tr:nth-child(even){background:#f7f9fa}tbody tr:hover{background:#eef3f6}.edit-button,.delete-button{padding:7px 12px;border-radius:4px;cursor:pointer}.edit-button{border:1px solid #263746;background:#fff;color:#263746}.edit-button:hover{background:#eef3f6}.delete-button{border:1px solid #b42318;background:#fff;color:#b42318}.delete-button:hover{background:#fff1f0}.edit-form{display:none;margin:24px 0;padding:20px;background:#f7f9fa;border:1px solid #d9dee3;border-radius:6px}.edit-form.open{display:grid;gap:10px;grid-template-columns:1fr 1fr auto auto;align-items:end}.edit-form label{display:grid;gap:6px;font-size:13px;font-weight:bold}.edit-form input{padding:9px;border:1px solid #c8d0d6;border-radius:4px;font:inherit}.save-button{padding:10px 16px;border:0;border-radius:4px;background:#263746;color:#fff;cursor:pointer}.cancel-button{padding:9px 16px;border:1px solid #c8d0d6;border-radius:4px;background:#fff;cursor:pointer}.status{min-height:20px;margin:8px 0;color:#b42318}
</style></head><body><main><h1>DriveEasy User Register</h1><p>Registered users and their current booking totals.</p><form class="edit-form" id="editForm" onsubmit="saveUser(event)"><label>Full Name<input id="editName" required></label><label>Email Address<input id="editEmail" type="email" required></label><button class="save-button" type="submit">Save changes</button><button class="cancel-button" type="button" onclick="closeEditor()">Cancel</button><input id="editId" type="hidden"></form><div id="status" class="status" role="alert"></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Full Name</th><th>Email Address</th><th>Created</th><th>Bookings</th><th>Booking Cars</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No users found.</td></tr>'}</tbody></table></div><script>
function editUser(id){const row=document.querySelector('tr[data-user-id="'+id+'"]');document.getElementById('editId').value=id;document.getElementById('editName').value=row.cells[1].textContent;document.getElementById('editEmail').value=row.cells[2].textContent;document.getElementById('editForm').classList.add('open');document.getElementById('status').textContent='';window.scrollTo({top:0,behavior:'smooth'});}
function closeEditor(){document.getElementById('editForm').classList.remove('open');}
async function saveUser(event){event.preventDefault();const id=document.getElementById('editId').value;const status=document.getElementById('status');try{const response=await fetch('/api/users/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('editName').value,email:document.getElementById('editEmail').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update user.');status.style.color='#16794c';status.textContent='User updated successfully. Refreshing...';window.setTimeout(()=>window.location.reload(),500);}catch(error){status.style.color='#b42318';status.textContent=error.message;}}
async function deleteUser(id){const row=document.querySelector('tr[data-user-id="'+id+'"]');const name=row.cells[1].textContent;if(!window.confirm('Delete '+name+' and all of this user\\'s bookings?'))return;const status=document.getElementById('status');try{const response=await fetch('/api/users/'+id,{method:'DELETE'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to delete user.');status.style.color='#16794c';status.textContent='User deleted successfully. Refreshing...';window.setTimeout(()=>window.location.reload(),500);}catch(error){status.style.color='#b42318';status.textContent=error.message;}}
</script></main></body></html>`);
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
      const pickupTime = String(booking.pickupTime || '');
      const returnTime = String(booking.returnTime || '');

      if (!car || !isValidDateRange(booking.pickupDate, booking.returnDate, pickupTime, returnTime) || !userEmail) {
        sendJson(response, 400, { error: 'A signed-in user, valid car name, dates, and start/end times are required.' });
        return;
      }

      if (!database.prepare('SELECT id FROM users WHERE email = ?').get(userEmail)) {
        sendJson(response, 401, { error: 'Please log in before creating a booking.' });
        return;
      }

      if (!isAvailable(car.id, booking.pickupDate, booking.returnDate, pickupTime, returnTime)) {
        sendJson(response, 409, { error: 'That car is already booked for the selected time range.' });
        return;
      }

      const savedBooking = database.prepare(`
        INSERT INTO bookings
          (user_email, car_id, car_name, location, pickup_date, return_date, pickup_time, return_time, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userEmail,
        car.id,
        car.name,
        booking.location || 'Not specified',
        booking.pickupDate,
        booking.returnDate,
        pickupTime,
        returnTime,
        booking.image || ''
      );
      const bookingRecord = database.prepare(`
        SELECT id, car_id AS carId, car_name AS carName, location,
          pickup_date AS pickupDate, return_date AS returnDate,
          pickup_time AS pickupTime, return_time AS returnTime, image, created_at AS createdAt
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
        pickup_date AS pickupDate, return_date AS returnDate,
        pickup_time AS pickupTime, return_time AS returnTime, image, created_at AS createdAt
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
          pickup_date AS pickupDate, return_date AS returnDate,
          pickup_time AS pickupTime, return_time AS returnTime, image, created_at AS createdAt
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
