require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { connectMongo, isConnected, Payment, Booking: MongoBooking } = require('../services/mongoService');
const email = require('../services/emailDeliveryService');
const emailPolicy = require('../public/assets/js/email-policy');
const starBot = require('../services/starBotService');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'starbook-local-development-only-change-me');
if (!JWT_SECRET) throw new Error('JWT_SECRET must be configured before running StarBook in production.');
const BACKDOOR_COOKIE = 'sb-backdoor-session';
const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
const REGISTRATION_CODE_RESEND_DELAY_MS = 60 * 1000;
const REGISTRATION_CODE_MAX_ATTEMPTS = 5;
const REGISTRATION_CODE_MAX_SENDS = 2;
const REGISTRATION_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_EMAIL_MAX_SENDS_PER_IP = 5;
const EMAIL_VERIFICATION_ENABLED = String(process.env.EMAIL_VERIFICATION_ENABLED || 'false').toLowerCase() === 'true';
const PASSWORD_RESET_ENABLED = String(process.env.PASSWORD_RESET_ENABLED || 'false').toLowerCase() === 'true';
const PASSWORD_RESET_CODE_TTL_MINUTES = Number(process.env.PASSWORD_RESET_CODE_TTL_MINUTES || 10);
if (!Number.isInteger(PASSWORD_RESET_CODE_TTL_MINUTES) ||
    PASSWORD_RESET_CODE_TTL_MINUTES < 1 || PASSWORD_RESET_CODE_TTL_MINUTES > 60)
  throw new Error('PASSWORD_RESET_CODE_TTL_MINUTES must be an integer from 1 to 60.');
const PASSWORD_RESET_CODE_TTL_MS = PASSWORD_RESET_CODE_TTL_MINUTES * 60 * 1000;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MAX_SENDS_PER_IP = 5;
const PASSWORD_RESET_MAX_SENDS_PER_EMAIL = 3;
const ORDER_SERVICE_FEE_PERCENT = 7.5;
const ORDER_TAX_PERCENT = 5;
const STARBOT_WINDOW_MS = 5 * 60 * 1000;
const STARBOT_MAX_REQUESTS_PER_IP = 10;
let currencyRatesCache = null;
let currencyRatesRequest = null;
const registrationEmailSendLimits = new Map();
const passwordResetRequestLimits = new Map();
const starBotRequestLimits = new Map();
let  LiveNotificationIndex = 0;
let starBotAvailabilityCache = { available: false, checkedAt: 0 };

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 400).json({ message: 'Invalid request body' });
  }
  addAccessLog(db, db.users.find(candidate => candidate.id === req.user.userId), `booking_${action}`, req);
  next(err);
});

io.use((socket, next) => {
  const authToken = socket.handshake.auth?.token ||
    socket.handshake.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (typeof authToken !== 'string' || !authToken) return next(new Error('Authentication required'));

  let claims;
  try {
    claims = jwt.verify(authToken, JWT_SECRET);
  } catch {
    return next(new Error('Authentication failed'));
  }

  try {
    const db = readDB();
    const account = db.users.find(user => user.id === claims.userId);
    if (!account || account.banned ||
        Number(account.tokenVersion || 0) !== Number(claims.tokenVersion || 0))
      return next(new Error('Authentication failed'));
    socket.data.userId = account.id;
    socket.data.userType = effectiveUserType(account, db);
    next();
  } catch (error) {
    console.error('Could not authenticate Socket.IO connection:', error);
    next(new Error('Authentication unavailable'));
  }
});

io.on('connection', socket => {
  socket.join(`user:${socket.data.userId}`);
  if (socket.data.userType === 'admin') socket.join('admin');
});

const DB_PATH = process.env.STARBOOK_DB_PATH || path.join(__dirname, '../db/database.json');
const CELEBRITY_IMAGE_DIR = path.join(__dirname, '../celebrities');
const PUBLIC_CELEBRITY_IMAGE_DIR = path.join(__dirname, '../public/images/celebrities');
const FAN_CARD_IMAGE_DIR = path.join(__dirname, '../public/images/fancards');
const CELEBRITY_IMAGE_CACHE_DIR = path.join(__dirname, '../db/celebrity-image-cache');
const CELEBRITY_IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
fs.mkdirSync(CELEBRITY_IMAGE_DIR, { recursive: true });
fs.mkdirSync(FAN_CARD_IMAGE_DIR, { recursive: true });
fs.mkdirSync(CELEBRITY_IMAGE_CACHE_DIR, { recursive: true });

function readDB() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8'); }

function addAccessLog(db, user, action, req, outcome = 'success') {
  if (!db.accessLogs) db.accessLogs = [];
  db.accessLogs.push({
    id: uuidv4(), userId: user?.id || null, email: user?.email || null,
    username: user?.username || null, action, outcome, createdAt: new Date().toISOString(),
    ip: String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 80)
  });
  if (db.accessLogs.length > 5000) db.accessLogs.splice(0, db.accessLogs.length - 5000);
}

function calculateOrderAmounts(baseAmount) {
  const baseCents = Math.round(Number(baseAmount) * 100);
  if (!Number.isSafeInteger(baseCents) || baseCents < 0)
    throw new Error('Order base amount must be a valid non-negative amount.');
  const serviceFeeCents = Math.round(baseCents * ORDER_SERVICE_FEE_PERCENT / 100);
  const taxCents = Math.round(baseCents * ORDER_TAX_PERCENT / 100);
  return {
    baseAmount: baseCents / 100,
    serviceFeePercent: ORDER_SERVICE_FEE_PERCENT,
    serviceFeeAmount: serviceFeeCents / 100,
    taxPercent: ORDER_TAX_PERCENT,
    taxAmount: taxCents / 100,
    taxConfigured: true,
    taxIsEstimate: true,
    totalAmount: (baseCents + serviceFeeCents + taxCents) / 100
  };
}

function getConfiguredWallets() {
  return {
    BTC: process.env.BTC_ADDRESS || process.env.BTC_WALLET_ADDRESS || '',
    ETH: process.env.ETH_ADDRESS || process.env.ETH_WALLET_ADDRESS || '',
    USDT: process.env.USDT_ADDRESS || process.env.USDT_WALLET_ADDRESS || '',
    BNB: process.env.BNB_ADDRESS || process.env.BNB_WALLET_ADDRESS || '',
    XRP: process.env.XRP_ADDRESS || process.env.XRP_WALLET_ADDRESS || '',
    USDC: process.env.USDC_ADDRESS || process.env.USDC_WALLET_ADDRESS || '',
    SOL: process.env.SOL_ADDRESS || process.env.SOL_WALLET_ADDRESS || '',
    DOGE: process.env.DOGE_ADDRESS || process.env.DOGE_WALLET_ADDRESS || '',
    TRX: process.env.TRX_ADDRESS || process.env.TRX_WALLET_ADDRESS || '',
    TWT: process.env.TWT_ADDRESS || process.env.TWT_WALLET_ADDRESS || ''
  };
}

async function calculateCurrencyAmount(amount, currency = 'USD') {
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code))
    throw Object.assign(new Error('Select a valid display currency.'), { status: 400 });
  if (code === 'USD') {
    const factor = 100;
    const convertedAmount = Math.round((Number(amount) + Number.EPSILON) * factor) / factor;
    return {
      currency: code,
      exchangeRate: 1,
      exchangeRateAsOf: new Date().toISOString(),
      convertedTotalAmount: convertedAmount
    };
  }

  let rates;
  try {
    rates = await getCurrencyRates();
  } catch (error) {
    throw Object.assign(new Error('The exchange rate is unavailable. Refresh the page before submitting.'), { status: 503, cause: error });
  }
  const rate = rates.rates[code];
  if (!Number.isFinite(rate) || rate <= 0)
    throw Object.assign(new Error(`The ${code} exchange rate is unavailable. Choose another currency.`), { status: 400 });
  const fractionDigits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    .resolvedOptions().maximumFractionDigits;
  const factor = 10 ** fractionDigits;
  const convertedAmount = Math.round((Number(amount) * rate + Number.EPSILON) * factor) / factor;
  return { currency: code, exchangeRate: rate, exchangeRateAsOf: rates.asOf, convertedTotalAmount: convertedAmount };
}

function issueBookingTicket(booking) {
  if (!booking.ticketCode) {
    booking.ticketCode = crypto.randomBytes(32).toString('hex');
    booking.ticketIssuedAt = new Date().toISOString();
  }
}

function listCelebrityImageFiles(directory) {
  try {
    return new Map(fs.readdirSync(directory).map(filename => [filename.toLowerCase(), filename]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

function withLocalCelebrityImages(celebrities) {
  const uploadedFiles = listCelebrityImageFiles(CELEBRITY_IMAGE_DIR);
  const publicFiles = listCelebrityImageFiles(PUBLIC_CELEBRITY_IMAGE_DIR);
  return celebrities.map(celebrity => {
    const existingPath = typeof celebrity.image === 'string'
      ? celebrity.image.replace(/\\/g, '/').match(/^\/(images\/)?celebrities\/([^/]+)$/i)
      : null;
    if (existingPath) {
      const directory = existingPath[1] ? PUBLIC_CELEBRITY_IMAGE_DIR : CELEBRITY_IMAGE_DIR;
      if (fs.existsSync(path.join(directory, existingPath[2]))) return celebrity;
    }

    const name = String(celebrity.name || '').trim();
    const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const hyphenatedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const basenames = new Set([`${celebrity.id}_${safeName}`, `${celebrity.id}-${safeName}`, safeName, name, hyphenatedName]);
    let localImage = null;
    for (const [files, prefix] of [
      [uploadedFiles, '/celebrities/'],
      [publicFiles, '/images/celebrities/']
    ]) {
      for (const basename of basenames) {
        const extension = [...CELEBRITY_IMAGE_EXTENSIONS].find(value => files.has(`${basename.toLowerCase()}${value}`));
        if (extension) {
          const filename = files.get(`${basename.toLowerCase()}${extension}`);
          localImage = `${prefix}${encodeURIComponent(filename)}`;
          break;
        }
      }
      if (localImage) break;
    }
    if (!localImage) return celebrity;
    return { ...celebrity, image: localImage };
  });
}

async function storeCelebrityImage(image, celebrityId) {
  if (typeof image !== 'string' || !image.startsWith('data:image/')) return image;
  const match = typeof image === 'string'
    ? image.match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/i)
    : null;
  if (!match) throw Object.assign(new Error('Celebrity image must be a valid PNG, JPEG, or WebP image.'), { status: 400 });
  const imageBytes = Buffer.from(match[2], 'base64');
  if (!imageBytes.length || imageBytes.length > 8 * 1024 * 1024)
    throw Object.assign(new Error('Compressed celebrity images must be under 8 MB.'), { status: 400 });
  const filename = `${String(celebrityId).replace(/[^a-zA-Z0-9_-]/g, '')}-${uuidv4()}.webp`;
  const imagePath = path.join(CELEBRITY_IMAGE_DIR, filename);
  try {
    await sharp(imageBytes)
      .rotate()
      .resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toFile(imagePath);
  } catch (error) {
    throw Object.assign(new Error('Could not decode the uploaded celebrity image.'), { status: 400, cause: error });
  }
  return `/celebrities/${filename}`;
}

async function storeFanCardImage(image, cardId) {
  const match = typeof image === 'string'
    ? image.match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/i)
    : null;
  if (!match) throw Object.assign(new Error('Upload a valid PNG, JPEG, or WebP fan card image.'), { status: 400 });
  const imageBytes = Buffer.from(match[2], 'base64');
  if (!imageBytes.length || imageBytes.length > 8 * 1024 * 1024)
    throw Object.assign(new Error('Compressed fan card images must be under 8 MB.'), { status: 400 });
  const filename = `${crypto.createHash('sha256').update(String(cardId)).digest('hex').slice(0, 12)}-${uuidv4()}.webp`;
  try {
    await sharp(imageBytes)
      .rotate()
      .resize({ width: 1800, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84, effort: 4 })
      .toFile(path.join(FAN_CARD_IMAGE_DIR, filename));
  } catch (error) {
    throw Object.assign(new Error('Could not decode the uploaded fan card image.'), { status: 400, cause: error });
  }
  return `/images/fancards/${filename}`;
}

function storedFanCardImagePath(imageUrl) {
  if (typeof imageUrl !== 'string') return null;
  const match = imageUrl.match(/^\/images\/fancards\/([A-Za-z0-9_-]+\.webp)$/);
  return match ? path.join(FAN_CARD_IMAGE_DIR, match[1]) : null;
}

async function removeStoredFanCardImage(imageUrl) {
  const imagePath = storedFanCardImagePath(imageUrl);
  if (!imagePath) return;
  try {
    await fs.promises.unlink(imagePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function licenseIsActive(license, now = Date.now()) {
  if (!license || license.active === false) return false;
  if (!license.expiresAt) return true;
  const expiresAt = Date.parse(license.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  const endOfDate = /^\d{4}-\d{2}-\d{2}$/.test(license.expiresAt) ? expiresAt + 24 * 60 * 60 * 1000 : expiresAt;
  return endOfDate > now;
}

function effectiveUserType(user, db) {
  if (user.userType === 'admin') return 'admin';
  if (!user.licenseKey) return user.userType || 'standard';
  const license = (db.licenseKeys || []).find(item => item.key === user.licenseKey);
  if (!licenseIsActive(license) || (license.usedBy && license.usedBy.toLowerCase() !== String(user.email || '').toLowerCase())) return 'standard';
  return license.type || 'premium';
}

function registrationCodeDigest(challengeId, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`${challengeId}:${code}`).digest();
}

function registrationCodeMatches(challengeId, code, storedDigest) {
  if (typeof storedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(storedDigest)) return false;
  const expected = registrationCodeDigest(challengeId, code);
  const actual = Buffer.from(storedDigest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function passwordResetCodeDigest(challengeId, emailAddress, code) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`password-reset:${challengeId}:${emailAddress}:${code}`)
    .digest();
}

function passwordResetCodeMatches(challengeId, emailAddress, code, storedDigest) {
  if (typeof storedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(storedDigest)) return false;
  const expected = passwordResetCodeDigest(challengeId, emailAddress, code);
  const actual = Buffer.from(storedDigest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function reservePasswordResetRequest(req, emailAddress) {
  const now = Date.now();
  for (const [key, bucket] of passwordResetRequestLimits) {
    if (bucket.resetAt <= now) passwordResetRequestLimits.delete(key);
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const keys = [
    `ip:${ip}`,
    `email:${crypto.createHash('sha256').update(emailAddress).digest('hex')}`
  ];
  const buckets = keys.map(key => {
    let bucket = passwordResetRequestLimits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + PASSWORD_RESET_WINDOW_MS };
      passwordResetRequestLimits.set(key, bucket);
    }
    return bucket;
  });
  if (buckets[0].count >= PASSWORD_RESET_MAX_SENDS_PER_IP ||
      buckets[1].count >= PASSWORD_RESET_MAX_SENDS_PER_EMAIL)
    return Math.max(1, Math.ceil((Math.min(...buckets.map(bucket => bucket.resetAt)) - now) / 1000));
  buckets.forEach(bucket => { bucket.count += 1; });
  return 0;
}

function reserveRegistrationEmailSend(req) {
  const now = Date.now();
  for (const [ip, bucket] of registrationEmailSendLimits) {
    if (bucket.resetAt <= now) registrationEmailSendLimits.delete(ip);
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = registrationEmailSendLimits.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + REGISTRATION_EMAIL_WINDOW_MS };
    registrationEmailSendLimits.set(ip, bucket);
  }
  if (bucket.count >= REGISTRATION_EMAIL_MAX_SENDS_PER_IP)
    return Math.ceil((bucket.resetAt - now) / 1000);
  bucket.count += 1;
  return 0;
}

async function fetchCurrencyRates() {
  const sources = [
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: data => data.result === 'success' ? data.rates : null,
      asOf: data => data.time_last_update_utc || new Date().toISOString()
    },
    {
      url: 'https://api.frankfurter.dev/v1/latest?base=USD',
      parse: data => data.rates ? { USD: 1, ...data.rates } : null,
      asOf: data => data.date || new Date().toISOString()
    },
    {
      url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      parse: data => {
        const raw = data.usd || data.USD;
        return raw ? Object.fromEntries(Object.entries(raw).map(([code, rate]) => [code.toUpperCase(), rate])) : null;
      },
      asOf: data => data.date || new Date().toISOString()
    }
  ];
  let lastError;
  for (const source of sources) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Exchange-rate service returned HTTP ${response.status}`);
      const data = await response.json();
      const rawRates = source.parse(data);
      if (!rawRates || typeof rawRates !== 'object') throw new Error('Exchange-rate service returned invalid data');
      const rates = Object.fromEntries(Object.entries(rawRates).map(([code, rate]) => [code.toUpperCase(), Number(rate)]).filter(([code, rate]) =>
        /^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0
      ));
      rates.USD = 1;
      currencyRatesCache = { base: 'USD', rates, asOf: source.asOf(data), fetchedAt: Date.now() };
      return currencyRatesCache;
    } catch (error) {
      lastError = error;
      console.warn(`[Currency] Rate source unavailable (${new URL(source.url).hostname}): ${error.message}`);
    }
  }
  throw lastError || new Error('All exchange-rate sources are unavailable.');
}

async function getCurrencyRates() {
  if (currencyRatesCache && Date.now() - currencyRatesCache.fetchedAt < 6 * 60 * 60 * 1000)
    return currencyRatesCache;
  if (!currencyRatesRequest) currencyRatesRequest = fetchCurrencyRates();
  try {
    return await currencyRatesRequest;
  } catch (error) {
    if (currencyRatesCache) return { ...currencyRatesCache, stale: true };
    throw error;
  } finally {
    currencyRatesRequest = null;
  }
}

// ── Auth middleware ──────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    try {
      const db = readDB();
      const account = db.users.find(candidate => candidate.id === user.userId);
      if (!account) return res.status(401).json({ message: 'Account no longer exists' });
      if (account.banned) return res.status(403).json({ message: 'This account has been banned. Contact support for assistance.' });
      if (Number(account.tokenVersion || 0) !== Number(user.tokenVersion || 0))
        return res.status(403).json({ message: 'This session is no longer valid. Please sign in again.' });
      req.user = { ...user, userType: effectiveUserType(account, db), email: account.email };
      next();
    } catch (error) {
      console.error('Could not verify authenticated account:', error);
      res.status(500).json({ message: 'Could not verify account access' });
    }
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user?.userType !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  next();
};

function clearBackdoorCookie(res) {
  res.clearCookie(BACKDOOR_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/backdoor' });
}

function requireBackdoorSession(req, res, next) {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${BACKDOOR_COOKIE}=`));
  const token = cookie ? decodeURIComponent(cookie.slice(BACKDOOR_COOKIE.length + 1)) : '';
  if (!token) return res.redirect('/backdoor/login.html');
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err || user?.userType !== 'admin') return res.redirect('/backdoor/login.html');
    try {
      const account = readDB().users.find(candidate =>
        candidate.id === user.userId && candidate.userType === 'admin' && !candidate.banned &&
        Number(candidate.tokenVersion || 0) === Number(user.tokenVersion || 0)
      );
      if (!account) return res.redirect('/backdoor/login.html');
    } catch (error) {
      console.error('Could not verify backdoor account:', error);
      return res.status(500).send('Could not verify administrator access.');
    }
    next();
  });
}

// ── BACKDOOR routes ──────────────────────────────────────────
app.get(['/backdoor', '/backdoor/'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/backdoor/login.html'));
});
app.get('/backdoor/warning.html', (req, res) => res.redirect('/backdoor/login.html'));
app.get('/backdoor/login.html', (req, res) => res.sendFile(path.join(__dirname, '../public/backdoor/login.html')));
app.get('/backdoor/dashboard.html', requireBackdoorSession, (req, res) => res.sendFile(path.join(__dirname, '../public/backdoor/dashboard.html')));

app.post('/api/backdoor/login', async (req, res) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = req.body.password;
    if (!username || typeof password !== 'string')
      return res.status(400).json({ message: 'Username and password are required' });
    const db = readDB();
    const user = db.users.find(candidate =>
      candidate.username?.toLowerCase() === username &&
      candidate.userType === 'admin'
    );
    if (!user || !await bcrypt.compare(password, user.password)) {
      addAccessLog(db, user, 'admin_login', req, 'failure');
      writeDB(db);
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }
    if (user.banned) {
      addAccessLog(db, user, 'admin_login', req, 'failure');
      writeDB(db);
      return res.status(403).json({ message: 'This admin account is disabled' });
    }

    user.lastLogin = new Date().toISOString();
    user.notifications = user.notifications || [];
    addAccessLog(db, user, 'admin_login', req);
    writeDB(db);

    const token = jwt.sign(
      { userId: user.id, email: user.email, userType: 'admin', tokenVersion: Number(user.tokenVersion || 0) },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.cookie(BACKDOOR_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 1000,
      path: '/backdoor'
    });
    res.json({
      message: 'Admin login successful',
      token,
      user: { id: user.id, fullName: user.fullName, email: user.email, userType: user.userType }
    });
  } catch (error) {
    console.error('[Admin auth] Login failed:', error.message);
    res.status(500).json({ message: 'Admin login failed' });
  }
});

app.post('/api/backdoor/logout', (req, res) => {
  try {
    const cookie = String(req.headers.cookie || '').split(';')
      .map(value => value.trim())
      .find(value => value.startsWith(`${BACKDOOR_COOKIE}=`));
    if (cookie) {
      const token = decodeURIComponent(cookie.slice(BACKDOOR_COOKIE.length + 1));
      let claims = null;
      try {
        claims = jwt.verify(token, JWT_SECRET);
      } catch (error) {
        if (!['TokenExpiredError', 'JsonWebTokenError'].includes(error.name)) throw error;
      }
      if (claims) {
        const db = readDB();
        const user = db.users.find(candidate => candidate.id === claims.userId);
        if (user) {
          addAccessLog(db, user, 'admin_logout', req);
          writeDB(db);
        }
      }
    }
    clearBackdoorCookie(res);
    res.json({ message: 'Admin session ended' });
  } catch (error) {
    console.error('[Admin auth] Could not record logout:', error.message);
    clearBackdoorCookie(res);
    res.status(500).json({ message: 'Admin session ended, but its activity could not be recorded.' });
  }
});

async function sendOptimizedCelebrityImage(req, res, imageDirectory, cacheScope) {
  const filename = req.params.filename;
  if (filename.includes('/') || filename.includes('\\') || path.basename(filename) !== filename ||
      !/\.(?:jpe?g|png|webp|gif|tiff?|avif)$/i.test(filename))
    return res.status(400).send('Invalid celebrity image path.');
  const source = path.join(imageDirectory, filename);
  try {
    const sourceStats = await fs.promises.stat(source);
    if (!sourceStats.isFile()) return res.status(404).send('Celebrity image not found.');
    if (sourceStats.size > 100 * 1024 * 1024)
      return res.status(413).send('Celebrity image exceeds the 100 MB optimization limit.');
    const cacheKey = crypto.createHash('sha256')
      .update(`${cacheScope}\0${filename}\0${sourceStats.size}\0${sourceStats.mtimeMs}`)
      .digest('hex');
    const cached = path.join(CELEBRITY_IMAGE_CACHE_DIR, `${cacheKey}.webp`);
    try {
      await fs.promises.access(cached, fs.constants.R_OK);
    } catch {
      try {
        await sharp(source)
          .rotate()
          .resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toFile(cached);
      } catch (error) {
        console.error(`Could not optimize celebrity image "${filename}":`, error);
        const status = ['EACCES', 'ENOSPC', 'EROFS'].includes(error.code) ? 500 : 415;
        return res.status(status).send('Celebrity image could not be optimized.');
      }
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/webp').sendFile(cached);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).send('Celebrity image not found.');
    console.error(`Could not serve celebrity image "${filename}":`, error);
    res.status(500).send('Celebrity image could not be served.');
  }
}

app.get('/celebrities/:filename', (req, res) =>
  sendOptimizedCelebrityImage(req, res, CELEBRITY_IMAGE_DIR, 'uploads'));
app.get('/images/celebrities/:filename', (req, res) =>
  sendOptimizedCelebrityImage(req, res, PUBLIC_CELEBRITY_IMAGE_DIR, 'public'));

app.use(express.static(path.join(__dirname, '../public')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));

app.get('/api/currency-rates', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const rates = await getCurrencyRates();
    res.json({ ...rates, stale: Boolean(rates.stale) });
  } catch (error) {
    console.error('[Currency] Could not load exchange rates:', error.message);
    res.status(503).json({ message: 'Exchange-rate estimates are temporarily unavailable.' });
  }
});

app.get('/api/order-fees', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    serviceFeePercent: ORDER_SERVICE_FEE_PERCENT,
    taxPercent: ORDER_TAX_PERCENT,
    taxConfigured: true,
    taxIsEstimate: true
  });
});

// Public checkout configuration. Never return secrets or card-processing credentials.
app.get('/api/payment-options', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const wallets = getConfiguredWallets();
  const cryptoEnabled = Object.values(wallets).some(address => typeof address === 'string' && address.trim());
  res.json({
    methods: [
      { id: 'bank_transfer', label: 'Bank Transfer', enabled: false, maintenance: true },
      { id: 'cashapp', label: 'Cash App', enabled: false, maintenance: true },
      { id: 'paypal', label: 'Mobile Wallet', enabled: false, maintenance: true },
      { id: 'crypto', label: 'Cryptocurrency', enabled: cryptoEnabled },
      { id: 'giftcard', label: 'Gift Card', enabled: true }
    ],
    wallets
  });
});

app.get('/api/starbot/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (Date.now() - starBotAvailabilityCache.checkedAt > 10000) {
    starBotAvailabilityCache = {
      available: await starBot.isAvailable(),
      checkedAt: Date.now()
    };
  }
  res.json({ available: starBotAvailabilityCache.available });
});

app.post('/api/starbot/chat', async (req, res) => {
  const requestBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const message = typeof requestBody.message === 'string' ? requestBody.message.trim() : '';
  if (!message) return res.status(400).json({ message: 'Enter a message for StarBot.' });
  if (message.length > starBot.MAX_MESSAGE_LENGTH)
    return res.status(400).json({ message: `Messages must be ${starBot.MAX_MESSAGE_LENGTH} characters or fewer.` });

  const now = Date.now();
  for (const [ip, bucket] of starBotRequestLimits) {
    if (bucket.resetAt <= now) starBotRequestLimits.delete(ip);
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = starBotRequestLimits.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + STARBOT_WINDOW_MS };
    starBotRequestLimits.set(ip, bucket);
  }
  if (bucket.count >= STARBOT_MAX_REQUESTS_PER_IP)
    return res.status(429).json({ message: 'StarBot is receiving too many questions from this connection. Please wait a few minutes.' });
  bucket.count += 1;

  try {
    const reply = await starBot.generateReply(message, requestBody.history);
    res.json({ reply, source: 'local-model' });
  } catch (error) {
    console.warn('[StarBot] Local AI answer unavailable:', error.message);
    res.status(503).json({ message: 'StarBot AI is temporarily unavailable.' });
  }
});

// ── Auth API ─────────────────────────────────────────────────
app.get('/api/auth/features', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    emailVerificationEnabled: EMAIL_VERIFICATION_ENABLED,
    passwordResetEnabled: PASSWORD_RESET_ENABLED,
    passwordResetCodeTtlSeconds: PASSWORD_RESET_CODE_TTL_MS / 1000
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, username, email: userEmail, phone, password, licenseKey } = req.body;
    const normalizedName = typeof fullName === 'string' ? fullName.trim() : '';
    const normalizedEmail = typeof userEmail === 'string' ? userEmail.trim().toLowerCase() : '';
    const normalizedUsername = typeof username === 'string' && username.trim()
      ? username.trim().toLowerCase()
      : normalizedEmail.split('@')[0];
    if (!normalizedName || !normalizedEmail || typeof password !== 'string')
      return res.status(400).json({ message: 'Full name, email, and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ message: 'Enter a valid email address' });
    const emailValidation = emailPolicy.validate(normalizedEmail);
    if (!emailValidation.valid)
      return res.status(400).json({ message: emailValidation.message });
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername))
      return res.status(400).json({ message: 'Username must be 3–30 characters using letters, numbers, or underscores' });
    if (password.length < 6 || password.length > 128)
      return res.status(400).json({ message: 'Password must be 6–128 characters' });
    const passwordHash = await bcrypt.hash(password, 10);
    const db = readDB();
    if (db.users.find(u => u.email?.toLowerCase() === normalizedEmail))
      return res.status(400).json({ message: 'Email already registered' });
    if (db.users.find(u => u.username?.toLowerCase() === normalizedUsername))
      return res.status(400).json({ message: 'Username already taken' });

    const normalizedLicenseKey = typeof licenseKey === 'string' ? licenseKey.trim().toUpperCase() : '';
    let license = null;
    if (normalizedLicenseKey) {
      license = (db.licenseKeys || []).find(item => item.key === normalizedLicenseKey);
      if (!license || license.used || !licenseIsActive(license))
        return res.status(400).json({ message: 'License key is invalid, expired, inactive, or already used' });
    }
    const userType = license?.type || 'standard';
    if (!EMAIL_VERIFICATION_ENABLED) {
      if (license) {
        license.used = true;
        license.usedBy = normalizedEmail;
        license.usedAt = new Date().toISOString();
      }
      const newUser = {
        id: uuidv4(),
        fullName: normalizedName,
        username: normalizedUsername,
        email: normalizedEmail,
        phone: typeof phone === 'string' ? phone.trim().slice(0, 40) || null : null,
        password: passwordHash,
        tokenVersion: 0,
        userType,
        licenseKey: normalizedLicenseKey || null,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        lastLogin: null,
        notifications: []
      };
      db.users.push(newUser);
      db.emailVerifications = (db.emailVerifications || []).filter(challenge => challenge.email !== normalizedEmail);
      newUser.notifications.push({
        id: uuidv4(),
        message: `Welcome to StarBook, ${newUser.fullName || newUser.username}! Your account is ready.`,
        read: false,
        createdAt: new Date().toISOString()
      });
      addAccessLog(db, newUser, 'account_created', req);
      writeDB(db);
      const token = jwt.sign({
        userId: newUser.id, email: newUser.email, userType: newUser.userType, tokenVersion: 0
      }, JWT_SECRET, { expiresIn: '7d' });
      email.sendWelcome({ user: newUser })
        .catch(error => console.error('[Email] Welcome message could not be sent:', error.message));
      return res.status(201).json({
        message: 'Account created successfully.',
        token,
        user: { id: newUser.id, fullName: newUser.fullName, username: newUser.username, email: newUser.email, userType: newUser.userType }
      });
    }
    const now = Date.now();
    db.emailVerifications = (db.emailVerifications || []).filter(challenge => Date.parse(challenge.expiresAt) > now);
    const existingChallenge = db.emailVerifications.find(challenge => challenge.email === normalizedEmail);
    if (existingChallenge) {
      const sendCount = Number.isInteger(existingChallenge.sendCount)
        ? existingChallenge.sendCount
        : 1 + (Number.isInteger(existingChallenge.resendCount) ? existingChallenge.resendCount : 0);
      const resendAt = Date.parse(existingChallenge.nextResendAt);
      return res.status(202).json({
        message: 'A verification code is already pending for this email. Enter it below or request another code.',
        verificationId: existingChallenge.id,
        expiresInSeconds: Math.max(0, Math.ceil((Date.parse(existingChallenge.expiresAt) - now) / 1000)),
        resendAfterSeconds: Number.isFinite(resendAt) ? Math.max(0, Math.ceil((resendAt - now) / 1000)) : 0,
        resendsRemaining: Math.max(0, REGISTRATION_CODE_MAX_SENDS - sendCount)
      });
    }
    const sendRetryAfter = reserveRegistrationEmailSend(req);
    if (sendRetryAfter)
      return res.status(429).json({ message: 'Too many verification emails were requested from this connection. Please try again later.', retryAfter: sendRetryAfter });

    const challengeId = uuidv4();
    const code = String(crypto.randomInt(100000, 1000000));
    const challenge = {
      id: challengeId,
      email: normalizedEmail,
      fullName: normalizedName,
      username: normalizedUsername,
      phone: typeof phone === 'string' ? phone.trim().slice(0, 40) || null : null,
      passwordHash,
      userType,
      licenseKey: normalizedLicenseKey || null,
      codeDigest: registrationCodeDigest(challengeId, code).toString('hex'),
      attempts: 0,
      sendCount: 1,
      resendCount: 0,
      nextResendAt: new Date(now + REGISTRATION_CODE_RESEND_DELAY_MS).toISOString(),
      expiresAt: new Date(now + REGISTRATION_CODE_TTL_MS).toISOString()
    };
    db.emailVerifications.push(challenge);
    writeDB(db);

    const sent = await email.sendRegistrationVerification({
      email: normalizedEmail,
      fullName: normalizedName,
      code,
      expiresMinutes: REGISTRATION_CODE_TTL_MS / 60000
    });
    if (!sent) {
      const latest = readDB();
      latest.emailVerifications = (latest.emailVerifications || []).filter(item => item.id !== challengeId);
      writeDB(latest);
      return res.status(503).json({ message: 'We could not send the verification email. Please try again later or contact support.' });
    }
    res.status(202).json({
      message: 'Verification code sent. Enter the code from your email to finish creating your account.',
      verificationId: challengeId,
      expiresInSeconds: REGISTRATION_CODE_TTL_MS / 1000,
      resendAfterSeconds: REGISTRATION_CODE_RESEND_DELAY_MS / 1000,
      resendsRemaining: REGISTRATION_CODE_MAX_SENDS - 1
    });
  } catch (error) {
    console.error('[Auth] Registration verification could not be started:', error.message);
    res.status(500).json({ message: 'Registration could not be started. Please try again.' });
  }
});

app.post('/api/auth/register/resend', async (req, res) => {
  try {
    const { verificationId } = req.body;
    if (typeof verificationId !== 'string')
      return res.status(400).json({ message: 'Verification session is required.' });
    const db = readDB();
    const challenge = (db.emailVerifications || []).find(item => item.id === verificationId);
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now())
      return res.status(410).json({ message: 'This verification session has expired. Start registration again.' });
    const emailValidation = emailPolicy.validate(challenge.email);
    if (!emailValidation.valid)
      return res.status(400).json({ message: emailValidation.message, resendsRemaining: 0 });
    const resendAt = Date.parse(challenge.nextResendAt);
    if (Number.isFinite(resendAt) && resendAt > Date.now())
      return res.status(429).json({ message: 'Please wait before requesting another code.', retryAfter: Math.ceil((resendAt - Date.now()) / 1000) });
    const sendCount = Number.isInteger(challenge.sendCount)
      ? challenge.sendCount
      : 1 + (Number.isInteger(challenge.resendCount) ? challenge.resendCount : 0);
    if (sendCount >= REGISTRATION_CODE_MAX_SENDS)
      return res.status(429).json({
        message: 'The maximum of two verification emails has been reached. Start registration again after this code expires.',
        resendsRemaining: 0
      });
    const sendRetryAfter = reserveRegistrationEmailSend(req);
    if (sendRetryAfter)
      return res.status(429).json({ message: 'Too many verification emails were requested from this connection. Please try again later.', retryAfter: sendRetryAfter });

    const code = String(crypto.randomInt(100000, 1000000));
    challenge.codeDigest = registrationCodeDigest(challenge.id, code).toString('hex');
    challenge.attempts = 0;
    challenge.resendCount += 1;
    challenge.sendCount = sendCount + 1;
    challenge.nextResendAt = new Date(Date.now() + REGISTRATION_CODE_RESEND_DELAY_MS).toISOString();
    writeDB(db);
    const sent = await email.sendRegistrationVerification({
      email: challenge.email,
      fullName: challenge.fullName,
      code,
      expiresMinutes: Math.max(1, Math.ceil((Date.parse(challenge.expiresAt) - Date.now()) / 60000))
    });
    if (!sent) {
      const latest = readDB();
      latest.emailVerifications = (latest.emailVerifications || []).filter(item => item.id !== verificationId);
      writeDB(latest);
      return res.status(503).json({ message: 'We could not send a new verification email. Start registration again later.' });
    }
    res.json({
      message: 'A new verification code has been sent.',
      resendAfterSeconds: REGISTRATION_CODE_RESEND_DELAY_MS / 1000,
      resendsRemaining: Math.max(0, REGISTRATION_CODE_MAX_SENDS - challenge.sendCount)
    });
  } catch (error) {
    console.error('[Auth] Registration verification email could not be resent:', error.message);
    res.status(500).json({ message: 'Could not resend the verification code. Please try again.' });
  }
});

app.post('/api/auth/register/cancel', (req, res) => {
  try {
    const { verificationId } = req.body;
    if (typeof verificationId !== 'string')
      return res.status(400).json({ message: 'Verification session is required.' });
    const db = readDB();
    db.emailVerifications = (db.emailVerifications || []).filter(item => item.id !== verificationId);
    writeDB(db);
    res.json({ message: 'Pending registration verification cleared.' });
  } catch (error) {
    console.error('[Auth] Pending registration verification could not be cleared:', error.message);
    res.status(500).json({ message: 'Could not clear the pending verification. Please try again.' });
  }
});

app.post('/api/auth/register/verify', async (req, res) => {
  try {
    const { verificationId, code } = req.body;
    if (typeof verificationId !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code))
      return res.status(400).json({ message: 'Enter the six-digit verification code from your email.' });
    const db = readDB();
    db.emailVerifications = db.emailVerifications || [];
    const challenge = db.emailVerifications.find(item => item.id === verificationId);
    if (!challenge) return res.status(404).json({ message: 'Verification session not found. Start registration again.' });
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
      writeDB(db);
      return res.status(410).json({ message: 'This verification code has expired. Start registration again.' });
    }
    const emailValidation = emailPolicy.validate(challenge.email);
    if (!emailValidation.valid) {
      db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
      writeDB(db);
      return res.status(400).json({ message: emailValidation.message });
    }
    if (challenge.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS)
      return res.status(429).json({ message: 'Too many incorrect codes. Start registration again after this code expires.' });
    if (!registrationCodeMatches(verificationId, code, challenge.codeDigest)) {
      challenge.attempts += 1;
      if (challenge.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS)
        db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
      writeDB(db);
      return res.status(challenge.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS ? 429 : 400).json({
        message: challenge.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS
          ? 'Too many incorrect codes. Start registration again.'
          : 'That verification code is incorrect.'
      });
    }
    if (db.users.some(user => user.email?.toLowerCase() === challenge.email || user.username?.toLowerCase() === challenge.username)) {
      db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
      writeDB(db);
      return res.status(409).json({ message: 'This email or username was registered while you were verifying. Please sign in or choose another.' });
    }
    if (challenge.licenseKey) {
      const license = (db.licenseKeys || []).find(item => item.key === challenge.licenseKey);
      if (!license || license.used || !licenseIsActive(license)) {
        db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
        writeDB(db);
        return res.status(409).json({ message: 'The license key is no longer available. Start registration again with a valid key.' });
      }
      license.used = true;
      license.usedBy = challenge.email;
      license.usedAt = new Date().toISOString();
    }

    const newUser = {
      id: uuidv4(),
      fullName: challenge.fullName,
      username: challenge.username,
      email: challenge.email,
      phone: challenge.phone,
      password: challenge.passwordHash,
      tokenVersion: 0,
      userType: challenge.userType,
      licenseKey: challenge.licenseKey,
      emailVerified: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      notifications: []
    };
    db.users.push(newUser);
    db.emailVerifications = db.emailVerifications.filter(item => item.id !== verificationId);
    newUser.notifications.push({
      id: uuidv4(),
      message: `Welcome to StarBook, ${newUser.fullName || newUser.username}! Your account is ready.`,
      read: false,
      createdAt: new Date().toISOString()
    });
    addAccessLog(db, newUser, 'account_created', req);
    writeDB(db);

    const token = jwt.sign({
      userId: newUser.id, email: newUser.email, userType: newUser.userType, tokenVersion: 0
    }, JWT_SECRET, { expiresIn: '7d' });
    email.sendWelcome({ user: newUser })
      .catch(error => console.error('[Email] Welcome message could not be sent:', error.message));
    res.status(201).json({
      message: 'Email verified and account created.',
      token,
      user: { id: newUser.id, fullName: newUser.fullName, username: newUser.username, email: newUser.email, userType: newUser.userType }
    });
  } catch (error) {
    console.error('[Auth] Registration verification failed:', error.message);
    res.status(500).json({ message: 'Account verification failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, username, identifier } = req.body;
    const loginIdentifier = String(identifier || username || email || '').trim().toLowerCase();
    if (!loginIdentifier || typeof password !== 'string')
      return res.status(400).json({ message: 'Username/email and password are required' });
    const db = readDB();

    const matches = db.users.filter(u =>
      u.username?.toLowerCase() === loginIdentifier ||
      u.email?.toLowerCase() === loginIdentifier ||
      (loginIdentifier.includes('@') && u.username?.toLowerCase() === loginIdentifier.split('@')[0])
    );
    let user = matches.find(candidate => candidate.userType !== 'admin') || matches.find(candidate => candidate.userType === 'admin') || null;

    if (!user || !await bcrypt.compare(password, user.password)) {
      addAccessLog(db, user, 'login', req, 'failure');
      writeDB(db);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    if (user.banned) {
      addAccessLog(db, user, 'login', req, 'failure');
      writeDB(db);
      return res.status(403).json({ message: 'This account has been banned. Contact support for assistance.' });
    }
    if (user.userType === 'admin') {
      let publicAccount = db.users.find(candidate => candidate.id === user.publicDashboardUserId);
      if (!publicAccount) {
        const usernameBase = `${String(user.username || 'member').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 22)}_member`;
        let usernameCandidate = usernameBase;
        let suffix = 1;
        while (db.users.some(candidate => candidate.username?.toLowerCase() === usernameCandidate))
          usernameCandidate = `${usernameBase.slice(0, 27)}${suffix++}`;
        const accountEmailBase = `${usernameCandidate}@starbook.internal`;
        let emailCandidate = accountEmailBase;
        suffix = 1;
        while (db.users.some(candidate => candidate.email?.toLowerCase() === emailCandidate.toLowerCase()))
          emailCandidate = `${usernameCandidate}${suffix++}@starbook.internal`;
        publicAccount = {
          id: uuidv4(),
          fullName: user.fullName || user.username || 'StarBook Member',
          username: usernameCandidate,
          email: emailCandidate,
          password: user.password,
          userType: 'standard',
          licenseKey: null,
          createdAt: new Date().toISOString(),
          lastLogin: null,
          notifications: []
        };
        user.publicDashboardUserId = publicAccount.id;
        db.users.push(publicAccount);
      }
      user = publicAccount;
    }
    if (user.banned) {
      addAccessLog(db, user, 'login', req, 'failure');
      writeDB(db);
      return res.status(403).json({ message: 'This account has been banned. Contact support for assistance.' });
    }

    user.lastLogin = new Date().toISOString();
    user.notifications = user.notifications || [];
    addAccessLog(db, user, 'login', req);
    writeDB(db);

    const userType = effectiveUserType(user, db);
    const token = jwt.sign({
      userId: user.id, email: user.email, userType, tokenVersion: Number(user.tokenVersion || 0)
    }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, fullName: user.fullName, username: user.username, email: user.email, userType } });
  } catch (error) {
    console.error('[Auth] Login failed:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
});


// Password recovery: one-time email code, hashed at rest, short expiry, bounded attempts.
app.post('/api/auth/forgot-password', async (req, res) => {
  if (!PASSWORD_RESET_ENABLED)
    return res.status(503).json({ message: 'Password reset is temporarily disabled. Please contact support for help signing in.' });
  const emailAddress = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailAddress))
    return res.status(400).json({ message: 'Enter a valid email address.' });
  try {
    const retryAfter = reservePasswordResetRequest(req, emailAddress);
    if (retryAfter)
      return res.status(429).json({ message: 'Too many password reset requests. Please try again later.', retryAfter });
    const db = readDB();
    const user = db.users.find(candidate => String(candidate.email || '').toLowerCase() === emailAddress && candidate.userType !== 'admin');
    if (user) {
      addAccessLog(db, user, 'password_reset_requested', req);
      if (!db.passwordResets) db.passwordResets = [];
      const now = Date.now();
      db.passwordResets = db.passwordResets.filter(item =>
        item.email !== emailAddress && Date.parse(item.expiresAt) > now
      );
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const challengeId = uuidv4();
      const challenge = {
        id: challengeId, email: emailAddress,
        codeDigest: passwordResetCodeDigest(challengeId, emailAddress, code).toString('hex'),
        attempts: 0, createdAt: new Date().toISOString(),
        expiresAt: new Date(now + PASSWORD_RESET_CODE_TTL_MS).toISOString()
      };
      db.passwordResets.push(challenge);
      writeDB(db);
      let sent = false;
      try {
        sent = await email.sendPasswordResetCode({
          email: user.email, fullName: user.fullName || user.username, code, expiresMinutes: PASSWORD_RESET_CODE_TTL_MINUTES
        });
      } catch (deliveryError) {
        console.error('[Auth] Password reset email delivery failed:', deliveryError.message);
      }
      if (!sent) {
        const latest = readDB();
        latest.passwordResets = (latest.passwordResets || []).filter(item => item.id !== challenge.id);
        const latestUser = latest.users.find(candidate => candidate.id === user.id);
        addAccessLog(latest, latestUser, 'password_reset_email_failed', req, 'failure');
        writeDB(latest);
      } else {
        writeDB(db);
      }
    }
    res.json({
      message: 'If an account exists for that email, a reset code has been sent. Check your inbox.',
      expiresInSeconds: PASSWORD_RESET_CODE_TTL_MS / 1000
    });
  } catch (error) {
    console.error('[Auth] Password reset request failed:', error.message);
    res.status(500).json({ message: 'Could not process the password reset request. Please try again later.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!PASSWORD_RESET_ENABLED)
    return res.status(503).json({ message: 'Password reset is temporarily disabled. Please contact support for help signing in.' });
  const emailAddress = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (!emailAddress || !/^\d{6}$/.test(code) || newPassword.length < 8)
    return res.status(400).json({ message: 'Enter your email, the six-digit code, and a password of at least 8 characters.' });
  try {
    const db = readDB();
    const challenge = (db.passwordResets || []).find(item => item.email === emailAddress);
    if (!challenge) return res.status(400).json({ message: 'Reset code is invalid or expired. Request a new code.' });
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      db.passwordResets = db.passwordResets.filter(item => item.id !== challenge.id);
      writeDB(db);
      return res.status(410).json({ message: 'Reset code expired. Request a new code.' });
    }
    if (challenge.attempts >= 5) return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    if (!passwordResetCodeMatches(challenge.id, emailAddress, code, challenge.codeDigest)) {
      challenge.attempts += 1; writeDB(db);
      return res.status(400).json({ message: 'Reset code is incorrect.' });
    }
    const user = db.users.find(candidate => String(candidate.email || '').toLowerCase() === emailAddress && candidate.userType !== 'admin');
    if (!user) return res.status(400).json({ message: 'Reset request is invalid. Request a new code.' });
    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    addAccessLog(db, user, 'password_reset', req);
    db.passwordResets = db.passwordResets.filter(item => item.email !== emailAddress);
    writeDB(db);
    io.sockets.sockets.forEach(socket => {
      if (socket.data.userId === user.id) socket.disconnect(true);
    });
    res.json({ message: 'Password updated successfully. You can now sign in.' });
  } catch (error) {
    console.error('[Auth] Password reset failed:', error.message);
    res.status(500).json({ message: 'Could not reset password. Please try again.' });
  }
});

// Logout - client deletes token; server just confirms
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  try {
    const db = readDB();
    const user = db.users.find(candidate => candidate.id === req.user.userId);
    if (user) addAccessLog(db, user, 'logout', req);
    writeDB(db);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('[Auth] Could not record logout:', error.message);
    res.status(500).json({ message: 'Could not complete logout.' });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const { password, ...safeUser } = user;
  res.json({ ...safeUser, userType: effectiveUserType(user, db) });
});

// ── Celebrity API ─────────────────────────────────────────────
app.get('/api/celebrities', (req, res) => {
  const db = readDB();
  const { category, page = 1, limit = 20, search, sort, minPrice, maxPrice, location } = req.query;
  let celebs = [...db.celebrities];

  if (category && category !== 'all') celebs = celebs.filter(c => c.category.toLowerCase() === category.toLowerCase());
  if (location) celebs = celebs.filter(c => c.location.toLowerCase().includes(location.toLowerCase()));
  if (minPrice) celebs = celebs.filter(c => c.price >= parseInt(minPrice));
  if (maxPrice) celebs = celebs.filter(c => c.price <= parseInt(maxPrice));
  if (search) {
    const q = search.toLowerCase();
    celebs = celebs.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.location.toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (c.services || []).some(s => s.toLowerCase().includes(q))
    );
  }
  if (sort === 'price_asc') celebs.sort((a, b) => a.price - b.price);
  else if (sort === 'price_desc') celebs.sort((a, b) => b.price - a.price);
  else if (sort === 'name') celebs.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'rating') celebs.sort((a, b) => b.rating - a.rating);
  else if (sort === 'trending' || sort === 'bookings') {
    const freshCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    celebs.sort((a, b) => {
      const aNew = Date.parse(a.createdAt || a.updatedAt || 0) >= freshCutoff;
      const bNew = Date.parse(b.createdAt || b.updatedAt || 0) >= freshCutoff;
      return Number(bNew) - Number(aNew) || (b.bookingsCount || 0) - (a.bookingsCount || 0);
    });
  }

  const total = celebs.length;
  const pageNum = parseInt(page), limitNum = parseInt(limit);
  const paginated = withLocalCelebrityImages(celebs.slice((pageNum - 1) * limitNum, pageNum * limitNum));
  res.json({ celebrities: paginated, total, page: pageNum, pages: Math.ceil(total / limitNum) });
});

app.get('/api/celebrities/featured', (req, res) => {
  const db = readDB();
  res.json(withLocalCelebrityImages(db.celebrities.filter(c => c.featured).slice(0, 12)));
});

app.get('/api/celebrities/trending', (req, res) => {
  const db = readDB();
  const freshCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const trending = [...db.celebrities].sort((a, b) => {
    const aNew = Date.parse(a.createdAt || a.updatedAt || 0) >= freshCutoff;
    const bNew = Date.parse(b.createdAt || b.updatedAt || 0) >= freshCutoff;
    return Number(bNew) - Number(aNew) || (b.bookingsCount || 0) - (a.bookingsCount || 0);
  }).slice(0, 20);
  res.json(withLocalCelebrityImages(trending));
});

app.get('/api/celebrities/:id', (req, res) => {
  const db = readDB();
  const celeb = db.celebrities.find(c => c.id === parseInt(req.params.id));
  if (!celeb) return res.status(404).json({ message: 'Celebrity not found' });
  res.json(withLocalCelebrityImages([celeb])[0]);
});

// On-demand image fetch for a single celebrity
app.post('/api/celebrities/:id/fetch-image', async (req, res) => {
  try {
    const { fetchSingleImage } = require('./image-fetcher');
    const url = await fetchSingleImage(parseInt(req.params.id));
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: 'Image fetch failed' });
  }
});

// AI Search
app.post('/api/search', (req, res) => {
  const db = readDB();
  const { query } = req.body;
  if (!query) return res.json([]);
  const q = query.toLowerCase();
  const words = q.split(/\s+/);
  const scored = db.celebrities.map(c => {
    let score = 0;
    words.forEach(w => {
      if (c.name.toLowerCase().includes(w)) score += 10;
      if (c.category.toLowerCase().includes(w)) score += 8;
      if (c.location.toLowerCase().includes(w)) score += 6;
      if ((c.tags || []).some(t => t.toLowerCase().includes(w))) score += 5;
      if ((c.services || []).some(s => s.toLowerCase().includes(w))) score += 4;
    });
    if (q.includes('under $500') && c.price < 500) score += 15;
    if (q.includes('cheap') && c.price < 300) score += 10;
    if (q.includes('premium') && c.price > 2000) score += 10;
    if (q.includes('verified') && c.verified) score += 5;
    if (q.includes('top rated') && c.rating >= 4.8) score += 8;
    return { ...c, _score: score };
  });
  res.json(scored.filter(c => c._score > 0).sort((a, b) => b._score - a._score).slice(0, 20));
});

// ── Bookings ──────────────────────────────────────────────────
app.post('/api/bookings', authenticateToken, async (req, res) => {
  try {
    const {
      celebrityId, eventDate, eventType, notes, recipientName, instructions, paymentMethod,
      paymentProofImages, cryptoCoin, cryptoAddress, giftCardBrand, giftCardCode, giftCardCodes,
      giftCardValue, venue, eventAddress, eventCity, eventCountry, nearestAirport,
      eventTime, eventTimezone
    } = req.body;
    if (!celebrityId) return res.status(400).json({ message: 'Celebrity is required' });
    if (typeof eventType !== 'string' || !eventType.trim()) return res.status(400).json({ message: 'Event type is required' });
    if (!eventDate) return res.status(400).json({ message: 'Event date is required' });
    const supportedMethods = ['crypto', 'giftcard', 'bank_transfer', 'cashapp', 'paypal'];
    if (!supportedMethods.includes(paymentMethod || 'crypto'))
      return res.status(400).json({ message: 'Select a supported payment method.' });
    if ((paymentMethod || 'crypto') === 'crypto') {
      const configuredWallets = getConfiguredWallets();
      if (typeof cryptoCoin !== 'string' || typeof cryptoAddress !== 'string' ||
          !configuredWallets[cryptoCoin] || configuredWallets[cryptoCoin] !== cryptoAddress)
        return res.status(400).json({ message: 'Choose a configured cryptocurrency wallet before submitting.' });
    }
    if (paymentMethod === 'bank_transfer')
      return res.status(503).json({ message: 'Bank Transfer is unavailable during network maintenance. Please choose Gift Card or Crypto.' });
    if (paymentMethod === 'cashapp')
      return res.status(503).json({ message: 'CashApp is temporarily suspended. Please choose Gift Card or Crypto.' });
    if (paymentMethod === 'paypal')
      return res.status(503).json({ message: 'Mobile Wallet services are under maintenance. Please choose Gift Card or Crypto.' });
    const db = readDB();
    const submittedProofFiles = Array.isArray(req.body.paymentProofFiles)
      ? req.body.paymentProofFiles
      : Array.isArray(paymentProofImages) ? paymentProofImages : [];
    if (!submittedProofFiles.length)
      return res.status(400).json({ message: 'Upload at least one payment proof file.' });
    if (submittedProofFiles.length > 20)
      return res.status(400).json({ message: 'Maximum 20 payment proof files allowed.' });
    let totalProofBytes = 0;
    for (const file of submittedProofFiles) {
      const match = typeof file === 'string'
        ? file.match(/^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i)
        : null;
      if (!match) return res.status(400).json({ message: 'Payment proof must be a valid image or PDF file.' });
      const fileSize = Buffer.from(match[2], 'base64').length;
      if (!fileSize || fileSize > 5 * 1024 * 1024)
        return res.status(400).json({ message: 'Each payment proof file must be 5 MB or smaller.' });
      totalProofBytes += fileSize;
      if (totalProofBytes > 15 * 1024 * 1024)
        return res.status(400).json({ message: 'Payment proof files must total 15 MB or less.' });
    }
    const celebrity = db.celebrities.find(c => c.id === parseInt(celebrityId) || c.id === celebrityId || c._id === celebrityId);
    if (!celebrity) return res.status(404).json({ message: 'Celebrity not found' });
    if (celebrity.available === false)
      return res.status(409).json({ message: 'This celebrity is currently unavailable for bookings.' });
    const orderAmounts = calculateOrderAmounts(celebrity.price);
    const paymentCurrency = await calculateCurrencyAmount(orderAmounts.totalAmount, req.body.currency || 'USD');
    let normalizedGiftCardCodes = [];
    if ((paymentMethod || 'crypto') === 'giftcard') {
      if (typeof giftCardBrand !== 'string' || !giftCardBrand.trim())
        return res.status(400).json({ message: 'Enter or select the gift card brand.' });
      normalizedGiftCardCodes = Array.isArray(giftCardCodes)
        ? giftCardCodes.filter(code => typeof code === 'string').map(code => code.trim()).filter(Boolean)
        : typeof giftCardCode === 'string' && giftCardCode.trim() ? [giftCardCode.trim()] : [];
      if (!normalizedGiftCardCodes.length)
        return res.status(400).json({ message: 'Enter at least one gift card code.' });
      if (normalizedGiftCardCodes.length > 20)
        return res.status(400).json({ message: 'Enter no more than 20 gift card codes.' });
      if (!Number.isFinite(Number(giftCardValue)) || Math.round(Number(giftCardValue) * 100) < Math.round(paymentCurrency.convertedTotalAmount * 100))
        return res.status(400).json({ message: `Gift card value must cover the ${paymentCurrency.convertedTotalAmount} ${paymentCurrency.currency} order total, including the service fee.` });
    }
    const newBooking = {
      id: uuidv4(), userId: req.user.userId,
      celebrityId: celebrity.id, celebrityName: celebrity.name,
      celebrityImage: celebrity.image, celebrityCategory: celebrity.category,
      recipientName: recipientName || '', eventDate, eventType: eventType.trim(),
      venue: venue || null, instructions: instructions || notes || '',
      eventAddress: typeof eventAddress === 'string' ? eventAddress.trim() : null,
      eventCity: typeof eventCity === 'string' ? eventCity.trim() : null,
      eventCountry: typeof eventCountry === 'string' ? eventCountry.trim() : null,
      nearestAirport: typeof nearestAirport === 'string' ? nearestAirport.trim() : null,
      eventTime: typeof eventTime === 'string' ? eventTime.trim() : null,
      eventTimezone: typeof eventTimezone === 'string' ? eventTimezone.trim() : null,
      paymentMethod: paymentMethod || 'crypto',
      ...paymentCurrency,
      paymentProofImages: submittedProofFiles.filter(file => /^data:image\//i.test(file)),
      paymentProofFiles: submittedProofFiles,
      cryptoCoin: cryptoCoin || null, cryptoAddress: cryptoAddress || null,
      giftCardBrand: giftCardBrand || null,
      giftCardCode: (paymentMethod || 'crypto') === 'giftcard'
        ? normalizedGiftCardCodes[0]
        : giftCardCode || null,
      giftCardCodes: normalizedGiftCardCodes,
      giftCardValue: giftCardValue || null,
      ...orderAmounts,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    const payment = {
      id: uuidv4(),
      userId: req.user.userId,
      bookingId: newBooking.id,
      method: newBooking.paymentMethod,
      amount: paymentCurrency.convertedTotalAmount, currency: paymentCurrency.currency,
      status: 'pending', reference: `SB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      details: { simulation: false },
      walletAddress: newBooking.cryptoAddress,
      cryptoCurrency: newBooking.cryptoCoin,
      giftCardBrand: newBooking.giftCardBrand,
      giftCardCode: newBooking.giftCardCode,
      giftCardCodes: newBooking.giftCardCodes,
      giftCardValue: newBooking.giftCardValue,
      totalAmount: newBooking.totalAmount,
      currency: newBooking.currency,
      exchangeRate: newBooking.exchangeRate,
      exchangeRateAsOf: newBooking.exchangeRateAsOf,
      convertedTotalAmount: newBooking.convertedTotalAmount,
      proofFiles: submittedProofFiles,
      cryptoImages: submittedProofFiles.filter(file => /^data:image\//i.test(file)),
      giftCardImages: newBooking.paymentMethod === 'giftcard'
        ? submittedProofFiles.filter(file => /^data:image\//i.test(file))
        : [],
      status: 'pending',
      createdAt: newBooking.createdAt
    };
    if (!db.payments) db.payments = [];
    db.payments.push(payment);
    newBooking.paymentId = payment.id;
    newBooking.paymentStatus = 'pending';
    db.bookings.push(newBooking);
    celebrity.bookingsCount = (celebrity.bookingsCount || 0) + 1;
    writeDB(db);
    if (isConnected()) {
      try {
        if (MongoBooking) await MongoBooking.updateOne({ id: newBooking.id }, { $set: newBooking }, { upsert: true });
        if (Payment) await Payment.updateOne({ id: payment.id }, { $set: { id: payment.id, userId: payment.userId, bookingId: newBooking.id, method: payment.method, amount: payment.amount || payment.convertedTotalAmount || payment.totalAmount, currency: payment.currency, status: payment.status, reference: payment.reference, last4: payment.last4, cardBrand: payment.cardBrand, details: payment.details, createdAt: payment.createdAt || newBooking.createdAt, updatedAt: new Date().toISOString() } }, { upsert: true });
      } catch (mongoError) { console.error('[MongoDB] Could not mirror checkout records:', mongoError.message); }
    }
    const user = db.users.find(u => u.id === req.user.userId);
    io.to('admin').emit('new-booking', { id: newBooking.id, user: user?.fullName, celebrity: celebrity.name, amount: newBooking.totalAmount });
    res.status(201).json({ message: 'Booking created. Payment is pending verification.', booking: newBooking });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    console.error('Could not create booking:', e);
    res.status(500).json({ message: 'Could not create booking' });
  }
});

app.get('/api/bookings', authenticateToken, (req, res) => {
  const db = readDB();
  const bookings = db.bookings.filter(b => b.userId === req.user.userId);
  let changed = false;
  bookings.forEach(booking => {
    if (booking.status === 'confirmed' && !booking.ticketCode) {
      issueBookingTicket(booking);
      changed = true;
    }
  });
  if (changed) writeDB(db);
  res.json(bookings);
});

app.get('/api/bookings/verify/:ticketCode', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = readDB();
  const booking = db.bookings.find(candidate => candidate.ticketCode === req.params.ticketCode);
  if (!booking || booking.status !== 'confirmed')
    return res.status(404).json({ valid: false, message: 'This event pass is not valid.' });
  res.json({
    valid: true,
    bookingReference: booking.id,
    celebrityName: booking.celebrityName,
    eventType: booking.eventType,
    eventDate: booking.eventDate,
    eventTime: booking.eventTime || null,
    recipientName: booking.recipientName || null,
    status: booking.status,
    ticketIssuedAt: booking.ticketIssuedAt || null
  });
});

app.get('/api/bookings/ticket/:ticketCode/qr.png', async (req, res) => {
  try {
    const db = readDB();
    const booking = db.bookings.find(candidate =>
      candidate.ticketCode === req.params.ticketCode && candidate.status === 'confirmed'
    );
    if (!booking) return res.status(404).json({ message: 'Valid event pass not found' });
    const verifyUrl = `${req.protocol}://${req.get('host')}/booking-verify.html?code=${encodeURIComponent(booking.ticketCode)}`;
    const png = await QRCode.toBuffer(verifyUrl, { type: 'png', width: 240, margin: 1, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (error) {
    console.error('Could not create booking ticket QR:', error);
    res.status(500).json({ message: 'Could not create event pass verification code' });
  }
});

// ── Payments ──────────────────────────────────────────────────
app.post('/api/payments', authenticateToken, (req, res) => {
  try {
    const { bookingId, method, walletAddress, cryptoCurrency, giftCardBrand, giftCardCode, giftCardValue, receiptBase64, cryptoImages, giftCardImages } = req.body;
    const db = readDB();
    const booking = db.bookings.find(candidate =>
      String(candidate.id || candidate._id) === String(bookingId || '') &&
      candidate.userId === req.user.userId
    );
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (!['crypto', 'giftcard', 'gift_card'].includes(String(method || '').toLowerCase()))
      return res.status(400).json({ message: 'Select a supported payment method.' });
    if (booking.status !== 'pending' || booking.paymentId)
      return res.status(409).json({ message: 'Payment has already been submitted for this booking.' });
    const normalizedMethod = String(method).toLowerCase() === 'gift_card' ? 'giftcard' : String(method).toLowerCase();
    if (normalizedMethod === 'crypto' &&
        (typeof cryptoCurrency !== 'string' || typeof walletAddress !== 'string' ||
         !getConfiguredWallets()[cryptoCurrency] || getConfiguredWallets()[cryptoCurrency] !== walletAddress))
      return res.status(400).json({ message: 'Choose a configured cryptocurrency wallet.' });
    const submittedProofs = [
      ...(typeof receiptBase64 === 'string' ? [receiptBase64] : []),
      ...(Array.isArray(cryptoImages) ? cryptoImages : []),
      ...(Array.isArray(giftCardImages) ? giftCardImages : [])
    ];
    if (!submittedProofs.length || submittedProofs.length > 20)
      return res.status(400).json({ message: 'Upload between 1 and 20 payment proof files.' });
    let totalProofBytes = 0;
    for (const proof of submittedProofs) {
      const match = typeof proof === 'string'
        ? proof.match(/^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i)
        : null;
      if (!match) return res.status(400).json({ message: 'Payment proof must be a valid image or PDF file.' });
      const bytes = Buffer.from(match[2], 'base64').length;
      if (!bytes || bytes > 5 * 1024 * 1024)
        return res.status(400).json({ message: 'Each payment proof file must be 5 MB or smaller.' });
      totalProofBytes += bytes;
      if (totalProofBytes > 15 * 1024 * 1024)
        return res.status(400).json({ message: 'Payment proof files must total 15 MB or less.' });
    }
    if (!db.payments) db.payments = [];
    const payment = {
      id: uuidv4(), userId: req.user.userId, bookingId: booking.id, method: normalizedMethod,
      walletAddress: walletAddress || null, cryptoCurrency: cryptoCurrency || null,
      giftCardBrand: giftCardBrand || null, giftCardCode: giftCardCode || null,
      giftCardValue: giftCardValue || null,
      proofFiles: submittedProofs,
      receiptBase64: receiptBase64 || null,
      cryptoImages: cryptoImages || [], giftCardImages: giftCardImages || [],
      status: 'pending', createdAt: new Date().toISOString()
    };
    db.payments.push(payment);
    booking.paymentId = payment.id;
    booking.paymentStatus = 'pending';
    writeDB(db);
    res.status(201).json({ message: 'Payment submitted. Awaiting admin verification.', payment: { ...payment, proofFiles: undefined, receiptBase64: undefined, cryptoImages: undefined, giftCardImages: undefined } });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// ── Fan Cards ─────────────────────────────────────────────────
app.post('/api/fancards', authenticateToken, async (req, res) => {
  try {
    const db = readDB();
    if (!db.pendingFanCards) db.pendingFanCards = [];
    const { id, celebrityId, tier, paymentMethod, cryptoCoin, giftCardBrand, giftCardCodes, giftCardValue, paymentProofImages } = req.body;
    const tierPrices = { Silver: 29, Gold: 59, VIP: 99 };
    const tierBenefits = {
      Silver: [
        'Personalized Silver membership card',
        'Unique fan ID number',
        'Scannable public card-verification page',
        '12-month membership validity after approval'
      ],
      Gold: [
        'Personalized Silver membership card',
        'Unique fan ID number',
        'Scannable public card-verification page',
        '12-month membership validity after approval',
        'Gold metallic card design',
        'Unique serial number',
        'Printable verification certificate',
        'Priority admin review queue'
      ],
      VIP: [
        'Personalized Silver membership card',
        'Unique fan ID number',
        'Scannable public card-verification page',
        '12-month membership validity after approval',
        'Gold metallic card design',
        'Unique serial number',
        'Printable verification certificate',
        'VIP diamond card design and verification mark',
        'Highest-priority admin review queue',
        'Copy-ready verification link for optional NFC tag programming'
      ]
    };
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return res.status(400).json({ message: 'Refresh the page and try placing your order again.' });
    if ([...(db.pendingFanCards || []), ...(db.fanCards || [])].some(card => card.id === id))
      return res.status(409).json({ message: 'This card reference has already been used. Refresh and try again.' });
    if (!Object.hasOwn(tierPrices, tier))
      return res.status(400).json({ message: 'Select a valid fan card tier.' });
    const orderAmounts = calculateOrderAmounts(tierPrices[tier]);
    const paymentCurrency = await calculateCurrencyAmount(orderAmounts.totalAmount, req.body.currency || 'USD');
    const celebrity = db.celebrities.find(candidate => String(candidate.id) === String(celebrityId));
    if (!celebrity) return res.status(404).json({ message: 'The selected celebrity could not be found.' });
    const user = db.users.find(candidate => candidate.id === req.user.userId);
    if (!user) return res.status(404).json({ message: 'Your account could not be found.' });
    const configuredWallets = getConfiguredWallets();
    const cryptoMethods = Object.keys(configuredWallets).filter(coin =>
      typeof configuredWallets[coin] === 'string' && configuredWallets[coin].trim()
    );
    if (!cryptoMethods.includes(paymentMethod) && paymentMethod !== 'gift_card')
      return res.status(400).json({ message: 'Select a supported payment method.' });
    if (cryptoMethods.includes(paymentMethod) && cryptoCoin && cryptoCoin !== paymentMethod)
      return res.status(400).json({ message: 'The selected cryptocurrency does not match its payment method.' });

    if (!Array.isArray(paymentProofImages) || paymentProofImages.length === 0)
      return res.status(400).json({ message: 'Upload at least one payment-proof image before submitting.' });
    if (paymentProofImages.length > 20)
      return res.status(400).json({ message: 'A maximum of 20 payment-proof images is allowed.' });
    let proofBytes = 0;
    for (const image of paymentProofImages) {
      const match = typeof image === 'string'
        ? image.match(/^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/)
        : null;
      if (!match) return res.status(400).json({ message: 'Payment proof must contain valid compressed image files.' });
      const bytes = Buffer.from(match[1], 'base64').length;
      if (!bytes || bytes > 5 * 1024 * 1024)
        return res.status(400).json({ message: 'Each compressed proof image must be 5 MB or smaller.' });
      proofBytes += bytes;
    }
    if (proofBytes > 30 * 1024 * 1024)
      return res.status(400).json({ message: 'Combined payment-proof images must be 30 MB or smaller.' });

    let normalizedCodes = [];
    if (paymentMethod === 'gift_card') {
      if (typeof giftCardBrand !== 'string' || !giftCardBrand.trim())
        return res.status(400).json({ message: 'Enter or select the gift card brand.' });
      normalizedCodes = Array.isArray(giftCardCodes)
        ? giftCardCodes.filter(code => typeof code === 'string').map(code => code.trim()).filter(Boolean)
        : [];
      if (!normalizedCodes.length) return res.status(400).json({ message: 'Enter at least one gift card code.' });
      if (normalizedCodes.length > 20) return res.status(400).json({ message: 'Enter no more than 20 gift card codes.' });
      const totalValue = Number(giftCardValue);
      if (!Number.isFinite(totalValue) || Math.round(totalValue * 100) < Math.round(paymentCurrency.convertedTotalAmount * 100))
        return res.status(400).json({ message: `Gift card value must cover the ${paymentCurrency.convertedTotalAmount} ${paymentCurrency.currency} order total, including the service fee.` });
    }

    const year = new Date().getFullYear();
    const level = tier === 'VIP' ? 'VIP' : tier.toUpperCase();
    const ref = id.replace(/-/g, '');
    const fanCard = {
      id, userId: req.user.userId,
      celebrityId: celebrity.id,
      celebrityName: celebrity.name,
      holderName: user.fullName || user.username || 'StarBook Member',
      membershipLevel: tier,
      tier,
      price: tierPrices[tier],
      ...orderAmounts,
      ...paymentCurrency,
      fanId: `FAN-${year}-${level}-${ref.slice(-5).toUpperCase()}`,
      serialNumber: tier === 'Silver' ? null : `SB-${year}-${level}-${ref.slice(-10).toUpperCase()}`,
      benefits: tierBenefits[tier],
      paymentMethod,
      cryptoCoin: cryptoMethods.includes(paymentMethod) ? paymentMethod : null,
      giftCardBrand: paymentMethod === 'gift_card' ? giftCardBrand.trim() : null,
      giftCardCodes: normalizedCodes,
      giftCardValue: paymentMethod === 'gift_card' ? Number(giftCardValue) : null,
      paymentProofImages,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    db.pendingFanCards.push(fanCard);
    writeDB(db);
    res.status(201).json({ message: 'Fan card application submitted', fanCard: { ...fanCard, paymentProofImages: undefined } });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    console.error('Could not submit fan card order:', e);
    res.status(500).json({ message: 'Could not submit fan card order' });
  }
});

app.get('/api/fancards/verify/:id/qr.png', async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))
    return res.status(400).send('Invalid fan card reference.');
  try {
    const verifyUrl = new URL('/fancard-verify.html', process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
    verifyUrl.searchParams.set('ref', req.params.id);
    const png = await QRCode.toBuffer(verifyUrl.toString(), { type: 'png', width: 192, margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'image/png' }).send(png);
  } catch (error) {
    console.error('Could not generate fan card verification QR:', error);
    res.status(500).send('Verification QR could not be generated.');
  }
});

app.get('/api/fancards/verify/:id', (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))
    return res.status(400).json({ message: 'Invalid fan card reference.' });
  const db = readDB();
  const card = [...(db.fanCards || []), ...(db.pendingFanCards || [])].find(candidate => candidate.id === req.params.id);
  if (!card) return res.status(404).json({ message: 'This card has not been submitted or could not be found.' });
  const level = card.membershipLevel || card.tier || 'Silver';
  const user = db.users.find(candidate => candidate.id === card.userId);
  res.set('Cache-Control', 'no-store').json({
    holderName: card.holderName || user?.fullName || user?.username || 'StarBook Member',
    celebrityName: card.celebrityName || card.celebName || 'StarBook Celebrity',
    membershipLevel: level,
    fanId: card.fanId || null,
    serialNumber: card.serialNumber || null,
    status: card.status || 'pending',
    createdAt: card.createdAt || null,
    approvedAt: card.approvedAt || null,
    expiryDate: card.expiryDate || null
  });
});

app.get('/api/fancards/mine', authenticateToken, (req, res) => {
  const db = readDB();
  const mine = [
    ...(db.fanCards || []).filter(f => f.userId === req.user.userId),
    ...(db.pendingFanCards || []).filter(f => f.userId === req.user.userId)
  ];
  res.json(mine);
});

// ── Testimonials ──────────────────────────────────────────────
app.get('/api/testimonials', (req, res) => {
  const db = readDB();
  res.json((db.testimonials || []).filter(t => t.approved !== false));
});

app.post('/api/testimonials', authenticateToken, (req, res) => {
  try {
    const { comment, rating } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.id === req.user.userId);
    if (!db.pendingTestimonials) db.pendingTestimonials = [];
    db.pendingTestimonials.push({
      id: uuidv4(), name: user.fullName, rating, comment,
      initial: user.fullName.charAt(0).toUpperCase(),
      date: new Date().toISOString().split('T')[0], approved: false
    });
    writeDB(db);
    res.status(201).json({ message: 'Testimonial submitted for review' });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// ── Stats & Live ──────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db = readDB();
  const celebrities = db.celebrities || [];
  const categoryCounts = {};
  const countries = new Set();

  celebrities.forEach(celebrity => {
    const category = String(celebrity.category || '').trim();
    if (category) categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    const location = String(celebrity.location || '').trim();
    const country = location.includes(',') ? location.split(',').pop().trim() : location;
    if (country && !['global', 'worldwide', 'international'].includes(country.toLowerCase()))
      countries.add(country.toLowerCase());
  });

  res.json({
    celebrities: celebrities.length,
    clients: (db.users || []).filter(u => u.userType !== 'admin').length,
    bookings: (db.bookings || []).length,
    experience: null,
    support: '24/7',
    countries: countries.size,
    categoryCounts
  });
});

const ACTIVITY_NAMES = [
  'Everleigh Truong', 'Ayan Miranda', 'Amina Daniels', 'Xander Lam', 'Karina Olsen',
  'Skyler Whitehead', 'Sylvie Bradford', 'Ander Burns', 'Emerson Odom', 'Kylian Hurst',
  'Adalee Morse', 'Bode Dean', 'Julianna Coleman', 'Micah Walker', 'Hazel Tyler',
  'Emmitt Person', 'Dylan Olson', 'Malachi Serrano', 'Allie Levy', 'Harold Shelton',
  'Makenzie Villalobos', 'Reuben Kramer', 'Hanna Horn', 'Wilson Norman', 'Malani Rangel',
  'Saint Avery', 'Meghan Ryan', 'Timothy Powell', 'Vivian Brewer', 'Cruz Kirby',
  'Skyla Herring', 'Henrik Wyatt', 'Liberty Potter', 'Lucca Keller', 'Logan Friedman',
  'Darwin West', 'Remi Schneider', 'Raymond Hernandez', 'Camila Johnston', 'Felix Ortiz',
  'Anna Banks', 'Martin Palmer', 'Juniper Compton', 'Abner Thornton', 'Haisley Farmer',
  'Jamison Medrano', 'Halle Shaw', 'Elliot Massey', 'Clementine Pena', 'Marcus Ibarra',
  'Madilynn Hahn', 'Kabir Le', 'Myla Romero', 'Bryson Waters', 'Bristol Yates',
  'Braylon Andersen', 'Zoie Farrell', 'Ty Evans', 'Eliana May', 'Finley Cortez',
  'Haven Rivas', 'Damon Montgomery', 'Evangeline Petersen', 'Samson Francis',
  'Daniella Richards', 'Holden Lowery', 'Estelle Gallegos', 'Jonas Barr', 'Noemi Villa',
  'Clay Nichols', 'Aliyah Guzman', 'Jude Tate', 'Skye Kane', 'Brock Hodges', 'Eve Lane',
  'Matias Haynes', 'Lexi Pratt', 'Rowen Foster', 'Brielle Patel', 'Parker Burch',
  'Freyja Harrell', 'Nelson Moody', 'Elaine Cabrera', 'Cade Ramsey', 'Lyric Horne',
  'Zev Johnston', 'Laila Preston', 'Vincenzo Snow', 'Alexia James', 'Jaxson Levy',
  'Flora McLean', 'Crosby Wright', 'Lily Mitchell', 'Jaxon Rich', 'Sunny Olsen',
  'Skyler Vu', 'Kimora Cox', 'Connor Marshall', 'Adalyn Sharp', 'Royce Norton',
  'Kylee Pope', 'Gunnar Cox', 'Sadie McCarty', 'Blaise Gonzalez', 'Abigail Larsen',
  'Brycen Conway', 'Ryann Townsend', 'Alexis Stanton', 'Jaycee Levy', 'Harold Li',
  'Paige Patton', 'Moises Frazier', 'Octavia Cross', 'Fabian Good', 'Nathalia Dunn',
  'Dawson Henry', 'Summer Armstrong', 'Grant Hensley', 'Malaya Acevedo', 'Dakari Arroyo',
  'Kyra Hood', 'Brixton Nicholson', 'Justice Collins', 'Miles Graves', 'Elle Best',
  'Harlem Boyd', 'Georgia Valenzuela', 'Jamari O’Connor', 'Charli Brock', 'Julio Blevins',
  'Aila Ruiz', 'Austin Randall', 'Christina Solis', 'Ronin Booker', 'Nataly Ingram',
  'Tripp Lawrence', 'Lauren Weaver', 'Tucker Gallagher', 'Elliott Garrison',
  'Noe Randall', 'Christina Ashley', 'Kylen Nicholson', 'Justice Lynn',
  'Zechariah Rush', 'Maleah Peters'
];

const ACTIVITY_CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Toronto', 'Vancouver', 'London', 'Manchester',
  'Paris', 'Berlin', 'Amsterdam', 'Madrid', 'Rome', 'Lisbon', 'Dublin', 'Stockholm',
  'Copenhagen', 'Oslo', 'Zurich', 'Vienna', 'Prague', 'Warsaw', 'Athens', 'Istanbul',
  'Dubai', 'Abu Dhabi', 'Riyadh', 'Doha', 'Cairo', 'Lagos', 'Accra', 'Nairobi',
  'Cape Town', 'Johannesburg', 'Mumbai', 'Delhi', 'Bengaluru', 'Singapore', 'Bangkok',
  'Manila', 'Jakarta', 'Seoul', 'Tokyo', 'Osaka', 'Hong Kong', 'Sydney', 'Melbourne',
  'Auckland', 'Mexico City', 'São Paulo', 'Rio de Janeiro', 'Buenos Aires', 'Lima',
  'Bogotá', 'Santiago'
];

const ACTIVITY_ACTIONS = [
  'booked a music performance with',
  'requested a birthday wish from',
  'requested a video message from',
  'booked a fan meetup with',
  'requested a shoutout from',
  'previewed a fan card for',
  'explored a VIP fan card for',
  'viewed a digital fan card for'
];

app.get('/api/live-notifications', (req, res) => {
  const db = readDB();
  const celebrities = (db.celebrities || []).filter(item => item && item.available !== false && (item.name || item.stageName));
  if (!celebrities.length) return res.status(204).end();
  const celebrity = celebrities[Math.floor(Math.random() * celebrities.length)];
  const pick = items => items[Math.floor(Math.random() * items.length)];
  const timeValue = Math.floor(Math.random() * 98) + 2;
  const timeUnit = pick(['seconds', 'minutes', 'hours']);
  res.set('Cache-Control', 'no-store');
  res.json({
    id: 'demo-activity',
    isDemo: true,
    name: pick(ACTIVITY_NAMES),
    city: pick(ACTIVITY_CITIES),
    action: pick(ACTIVITY_ACTIONS),
    celebrity: celebrity.name || celebrity.stageName,
    time: `${timeValue} ${timeUnit} ago`
  });

});

// ── Admin APIs ────────────────────────────────────────────────
app.get('/api/backdoor/stats', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json({
    totalUsers: db.users.filter(u => u.userType !== 'admin').length,
    totalCelebrities: db.celebrities.length,
    totalBookings: db.bookings.length,
    pendingPayments: (db.payments || []).filter(p => p.status === 'pending').length,
    pendingTestimonials: (db.pendingTestimonials || []).length,
    pendingFanCards: (db.pendingFanCards || []).length,
    totalRevenue: db.bookings.reduce((s, b) => s + (b.totalAmount || 0), 0)
  });
});

app.get('/api/backdoor/bookings', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.bookings.map(b => {
    const u = db.users.find(u => u.id === b.userId);
    return { ...b, userEmail: u?.email, userName: u?.fullName };
  }));
});

app.get('/api/backdoor/payments', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const payments = db.payments || [];
  const bookingIdsWithPayments = new Set(payments.map(payment => String(payment.bookingId || '')).filter(Boolean));
  const results = payments.map(payment => {
    const booking = db.bookings.find(candidate =>
      String(candidate.id || candidate._id) === String(payment.bookingId || '')
    );
    const user = db.users.find(candidate => candidate.id === payment.userId);
    return {
      ...payment,
      totalAmount: payment.totalAmount ?? booking?.totalAmount ?? null,
      currency: payment.currency || booking?.currency || 'USD',
      convertedTotalAmount: payment.convertedTotalAmount ?? booking?.convertedTotalAmount ?? null,
      proofFiles: payment.status === 'pending' && Array.isArray(payment.proofFiles) && payment.proofFiles.length
        ? payment.proofFiles
        : payment.status === 'pending' ? booking?.paymentProofFiles || booking?.paymentProofImages || [] : [],
      cryptoCurrency: payment.cryptoCurrency || booking?.cryptoCoin || null,
      walletAddress: payment.walletAddress || booking?.cryptoAddress || null,
      giftCardBrand: payment.giftCardBrand || booking?.giftCardBrand || null,
      giftCardCode: payment.giftCardCode || booking?.giftCardCode || null,
      giftCardCodes: payment.giftCardCodes || booking?.giftCardCodes || [],
      giftCardValue: payment.giftCardValue ?? booking?.giftCardValue ?? null,
      userName: user?.fullName,
      userEmail: user?.email,
      celebName: booking?.celebrityName,
      bookingReference: booking?.id || payment.bookingId
    };
  });

  (db.bookings || []).forEach(booking => {
    const bookingId = String(booking.id || booking._id || '');
    const proofFiles = booking.paymentProofFiles || booking.paymentProofImages || [];
    const hasLegacyProof = booking.paymentStatus !== 'approved' &&
      (Array.isArray(proofFiles) && proofFiles.length > 0 ||
      typeof booking.paymentProof === 'string' && booking.paymentProof.length > 0);
    if (!bookingId || !hasLegacyProof || bookingIdsWithPayments.has(bookingId)) return;
    const user = db.users.find(candidate => candidate.id === booking.userId);
    results.push({
      id: `legacy-booking:${bookingId}`,
      bookingId,
      bookingReference: bookingId,
      userId: booking.userId,
      method: booking.paymentMethod,
      totalAmount: booking.totalAmount ?? null,
      currency: booking.currency || 'USD',
      convertedTotalAmount: booking.convertedTotalAmount ?? null,
      giftCardBrand: booking.giftCardBrand || null,
      giftCardCode: booking.giftCardCode || null,
      giftCardCodes: booking.giftCardCodes || [],
      giftCardValue: booking.giftCardValue ?? null,
      cryptoCurrency: booking.cryptoCoin || null,
      walletAddress: booking.cryptoAddress || null,
      proofFiles: Array.isArray(proofFiles) && proofFiles.length ? proofFiles : [booking.paymentProof],
      status: booking.paymentStatus || booking.status || 'pending',
      userName: user?.fullName,
      userEmail: user?.email,
      celebName: booking.celebrityName
    });
  });
  res.json(results);
});

app.patch('/api/backdoor/payments/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const { status, rejectionReason } = req.body;
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ message: 'Payment status must be approved or rejected' });
  const payment = (db.payments || []).find(p => String(p.id || p._id) === req.params.id);
  const legacyBookingId = req.params.id.startsWith('legacy-booking:')
    ? req.params.id.slice('legacy-booking:'.length)
    : null;
  const booking = db.bookings.find(candidate =>
    String(candidate.id || candidate._id) === String(payment?.bookingId || legacyBookingId || '')
  );
  if (!payment && !booking) return res.status(404).json({ message: 'Payment not found' });
  const method = String(payment?.method || booking?.paymentMethod || '').toLowerCase();
  if (status === 'approved' && !['crypto', 'giftcard', 'gift_card'].includes(method))
    return res.status(409).json({ message: 'Only submitted Cryptocurrency or Gift Card proof can be approved.' });
  if (status === 'approved' &&
      (String(payment?.method || '').toLowerCase() === 'card' || String(booking?.paymentMethod || '').toLowerCase() === 'card'))
    return res.status(409).json({ message: 'Card payments cannot be approved because card checkout is not supported.' });
  const proofFiles = payment?.proofFiles || payment?.cryptoImages || payment?.giftCardImages ||
    booking?.paymentProofFiles || booking?.paymentProofImages || [];
  const hasProof = (Array.isArray(proofFiles) && proofFiles.length > 0) ||
    typeof payment?.receiptBase64 === 'string' || typeof booking?.paymentProof === 'string';
  if (status === 'approved' && !hasProof)
    return res.status(409).json({ message: 'Payment proof is missing; this payment cannot be approved.' });
  if ((payment && payment.status !== 'pending') ||
      (booking && ['approved', 'rejected'].includes(String(booking.paymentStatus || '').toLowerCase())))
    return res.status(409).json({ message: 'This payment has already been reviewed.' });
  const bookingWasConfirmed = booking?.status === 'confirmed';
  if (payment) {
    payment.status = status;
    payment.reviewedAt = new Date().toISOString();
    if (rejectionReason) payment.rejectionReason = rejectionReason;
  }
  if (booking) {
    booking.status = status === 'approved' ? 'confirmed' : 'rejected';
    booking.paymentStatus = status;
    booking.rejectionReason = rejectionReason || null;
    if (status === 'approved') issueBookingTicket(booking);
    else delete booking.ticketCode;
  }
  const user = db.users.find(candidate => candidate.id === (payment?.userId || booking?.userId));
  if (user) {
    if (!user.notifications) user.notifications = [];
    const notification = {
      id: uuidv4(),
      message: status === 'approved'
        ? `✅ Your payment for ${booking?.celebrityName || 'your booking'} was approved! Booking confirmed.`
        : `❌ Payment rejected. Reason: ${rejectionReason || 'Please contact support for details.'}`,
      read: false,
      createdAt: new Date().toISOString()
    };
    user.notifications.push(notification);
    io.to(`user:${user.id}`).emit('notification', notification);
    if (booking) {
      io.to(`user:${user.id}`).emit('booking-update', { bookingId: booking.id, status: booking.status });
    }
  }
  addAccessLog(db, db.users.find(candidate => candidate.id === req.user.userId), `payment_${status}`, req);
  writeDB(db);
  if (status === 'approved' && booking && user && !bookingWasConfirmed)
    email.sendBookingApproved({ user, booking })
      .catch(error => console.error('Booking approval email failed:', error.message));
  res.json({ message: `Payment ${status}` });
});

app.delete('/api/backdoor/payments/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const payments = db.payments || [];
    const paymentIndex = payments.findIndex(payment => String(payment.id || payment._id) === req.params.id);
    if (paymentIndex === -1 && req.params.id.startsWith('legacy-booking:')) {
      const bookingId = req.params.id.slice('legacy-booking:'.length);
      const booking = (db.bookings || []).find(candidate =>
        String(candidate.id || candidate._id) === bookingId
      );
      if (!booking) return res.status(404).json({ message: 'Payment proof not found' });
      delete booking.paymentId;
      delete booking.paymentStatus;
      delete booking.paymentProofFiles;
      delete booking.paymentProofImages;
      delete booking.paymentProof;
      writeDB(db);
      return res.json({ message: 'Payment proof deleted. The booking was kept and detached.' });
    }
    if (paymentIndex === -1) return res.status(404).json({ message: 'Payment proof not found' });

    const [payment] = payments.splice(paymentIndex, 1);
    const linkedBooking = (db.bookings || []).find(booking =>
      String(booking.paymentId || '') === String(payment.id || payment._id) ||
      String(booking.id || booking._id) === String(payment.bookingId || '')
    );
    if (linkedBooking) {
      delete linkedBooking.paymentId;
      delete linkedBooking.paymentStatus;
      delete linkedBooking.paymentProofFiles;
      delete linkedBooking.paymentProofImages;
      delete linkedBooking.paymentProof;
    }
    writeDB(db);
    res.json({ message: 'Payment proof deleted. The booking, if any, was kept.' });
  } catch (error) {
    console.error('Could not delete payment proof:', error);
    res.status(500).json({ message: 'Could not delete payment proof' });
  }
});

app.get('/api/backdoor/testimonials', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json([
    ...(db.testimonials || []).map(item => ({ ...item, approved: true })),
    ...(db.pendingTestimonials || []).map(item => ({ ...item, approved: false }))
  ]);
});

app.get('/api/backdoor/testimonials/pending', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.pendingTestimonials || []);
});

app.patch('/api/backdoor/testimonials/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const action = req.body.action || (req.body.approved === true ? 'approve' : '');
  if (!['approve', 'reject'].includes(action))
    return res.status(400).json({ message: 'Choose approve or reject' });
  const pendingIndex = (db.pendingTestimonials || []).findIndex(item => item.id === req.params.id);
  if (pendingIndex >= 0) {
    const [testimonial] = db.pendingTestimonials.splice(pendingIndex, 1);
    if (action === 'approve') {
      testimonial.approved = true;
      if (!db.testimonials) db.testimonials = [];
      db.testimonials.push(testimonial);
    }
    writeDB(db);
    return res.json({ message: `Testimonial ${action}d` });
  }
  const published = (db.testimonials || []).find(item => item.id === req.params.id);
  if (!published) return res.status(404).json({ message: 'Testimonial not found' });
  if (action === 'reject') db.testimonials = db.testimonials.filter(item => item.id !== req.params.id);
  writeDB(db);
  res.json({ message: action === 'approve' ? 'Testimonial is already published' : 'Testimonial removed' });
});


// Audit history and support inbox for Backdoor.
app.get('/api/backdoor/access-logs', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.set('Cache-Control', 'no-store');
  res.json((db.accessLogs || []).slice().sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, 1000));
});

app.get('/api/backdoor/messages', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.set('Cache-Control', 'no-store');
  res.json((db.contactMessages || []).slice().sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
});

app.post('/api/backdoor/messages/:id/reply', authenticateToken, requireAdmin, (req, res) => {
  const reply = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!reply) return res.status(400).json({ message: 'Reply message is required.' });
  if (reply.length > 2000) return res.status(400).json({ message: 'Reply must be 2,000 characters or fewer.' });
  const db = readDB();
  const item = (db.contactMessages || []).find(message => message.id === req.params.id);
  if (!item) return res.status(404).json({ message: 'Support message not found.' });
  const user = db.users.find(candidate => candidate.id === item.userId) ||
    db.users.find(candidate => String(candidate.email || '').toLowerCase() === String(item.email || '').toLowerCase());
  item.read = true;
  item.repliedAt = new Date().toISOString();
  item.reply = reply;
  item.status = 'replied';
  if (user) {
    if (!user.notifications) user.notifications = [];
    const notification = { id: uuidv4(), message: `Support replied to your message "${String(item.subject || 'General').slice(0, 100)}": ${reply}`, read: false, createdAt: new Date().toISOString() };
    user.notifications.push(notification);
    io.to(`user:${user.id}`).emit('notification', notification);
  }
  writeDB(db);
  res.json({ message: user ? 'Reply saved and notification sent.' : 'Reply saved. No matching account was found for notification.' });
});

app.patch('/api/backdoor/messages/:id/read', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const item = (db.contactMessages || []).find(message => message.id === req.params.id);
  if (!item) return res.status(404).json({ message: 'Support message not found.' });
  const read = typeof req.body?.read === 'boolean' ? req.body.read : true;
  item.read = read;
  if (read) item.readAt = item.readAt || new Date().toISOString();
  else delete item.readAt;
  if (item.status !== 'replied') item.status = read ? 'read' : 'unread';
  addAccessLog(db, db.users.find(user => user.id === req.user.userId), `support_message_${read ? 'read' : 'unread'}`, req);
  writeDB(db);
  res.json({ message: read ? 'Support message marked as read.' : 'Support message marked as unread.' });
});

app.get('/api/backdoor/users', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.users.map(({ password, ...u }) => u));
});

app.delete('/api/backdoor/users/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const userIndex = db.users.findIndex(user => user.id === req.params.id);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

    const user = db.users[userIndex];
    if (user.userType === 'admin' || user.id === req.user.userId)
      return res.status(403).json({ message: 'Administrator accounts cannot be deleted here' });
    addAccessLog(db, db.users.find(candidate => candidate.id === req.user.userId), 'user_deleted', req);

    const email = String(user.email || '').toLowerCase();
    const hasBookings = (db.bookings || []).some(booking => booking.userId === user.id);
    const hasPayments = (db.payments || []).some(payment => payment.userId === user.id);
    const hasFanCards = [...(db.fanCards || []), ...(db.pendingFanCards || [])]
      .some(card => card.userId === user.id);
    const hasLicense = (db.licenseKeys || []).some(license =>
      license.key === user.licenseKey ||
      (email && String(license.usedBy || '').toLowerCase() === email)
    );
    const hasSupportMessages = email && (db.contactMessages || [])
      .some(message => String(message.email || '').toLowerCase() === email);

    if (hasBookings || hasPayments || hasFanCards || hasLicense || hasSupportMessages)
      return res.status(409).json({
        message: 'This user has linked booking, payment, fan-card, license, or support records and cannot be deleted. Ban the account to block access while preserving its history.'
      });

    db.users.splice(userIndex, 1);
    writeDB(db);
    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('Could not delete user:', error);
    res.status(500).json({ message: 'Could not delete user' });
  }
});

app.post('/api/backdoor/notify', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const { userId, message } = req.body;
  const targets = (userId === 'all' ? db.users : [db.users.find(u => u.id === userId)]).filter(Boolean);
  targets.forEach(u => {
    if (!u.notifications) u.notifications = [];
    u.notifications.push({ id: uuidv4(), message, read: false, createdAt: new Date().toISOString() });
    io.to(`user:${u.id}`).emit('notification', { message });
  });
  writeDB(db); res.json({ message: 'Notification sent' });
});

app.get('/api/backdoor/fancards', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const priority = { VIP: 0, Gold: 1, Silver: 2 };
  const cards = [...(db.pendingFanCards || []), ...(db.fanCards || [])].map(card => {
    const user = db.users.find(candidate => candidate.id === card.userId);
    return { ...card, userName: user?.fullName || user?.username, userEmail: user?.email };
  }).sort((a, b) =>
    (priority[a.membershipLevel || a.tier] ?? 3) - (priority[b.membershipLevel || b.tier] ?? 3) ||
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  res.json(cards);
});

app.patch('/api/backdoor/fancards/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const { action, rejectionReason } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ message: 'Choose approve or reject' });
  if (!db.pendingFanCards) return res.status(404).json({ message: 'Not found' });
  const idx = db.pendingFanCards.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: 'Not found' });
  if (action === 'approve') {
    const pendingCard = db.pendingFanCards[idx];
    if (!Array.isArray(pendingCard.paymentProofImages) || !pendingCard.paymentProofImages.length)
      return res.status(409).json({ message: 'This Fan Card has no payment proof to review.' });
  }
  const [fc] = db.pendingFanCards.splice(idx, 1);
  const fanUser = db.users.find(u => u.id === fc.userId);
  const tier = fc.membershipLevel || fc.tier || 'Silver';
  const celebrityName = fc.celebrityName || fc.celebName || 'your selected celebrity';
  fc.membershipLevel = tier;
  fc.celebrityName = celebrityName;
  fc.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve') {
    fc.approvedAt = new Date().toISOString();
    fc.expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    if (!db.fanCards) db.fanCards = [];
    db.fanCards.push(fc);
    if (fanUser) {
      if (!fanUser.notifications) fanUser.notifications = [];
      const notification = { id: uuidv4(), message: `🪪 Your ${tier} Fan Card for ${celebrityName} is approved! View it in your dashboard.`, read: false, createdAt: new Date().toISOString() };
      fanUser.notifications.push(notification);
      io.to(`user:${fanUser.id}`).emit('notification', notification);
      io.to(`user:${fanUser.id}`).emit('fancard-update', { id: fc.id, status: 'approved' });
    }
  } else {
    fc.rejectionReason = typeof rejectionReason === 'string' && rejectionReason.trim()
      ? rejectionReason.trim().slice(0, 500)
      : 'Payment verification failed';
    if (!db.fanCards) db.fanCards = [];
    db.fanCards.push(fc);
    if (fanUser) {
      if (!fanUser.notifications) fanUser.notifications = [];
      const notification = { id: uuidv4(), message: `❌ Your ${tier} Fan Card application for ${celebrityName} was rejected. Reason: ${fc.rejectionReason}`, read: false, createdAt: new Date().toISOString() };
      fanUser.notifications.push(notification);
      io.to(`user:${fanUser.id}`).emit('notification', notification);
      io.to(`user:${fanUser.id}`).emit('fancard-update', { id: fc.id, status: 'rejected' });
    }
  }
  addAccessLog(db, db.users.find(user => user.id === req.user.userId), `fancard_${action}`, req);
  writeDB(db); res.json({ message: `Fan card ${action}d` });
});

app.delete('/api/backdoor/fancards/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = readDB();
    const pending = db.pendingFanCards || [];
    const approvedOrRejected = db.fanCards || [];
    const cardId = req.params.id;
    const matchingCards = [...pending, ...approvedOrRejected]
      .filter(card => String(card.id || card._id) === cardId);
    if (!matchingCards.length) return res.status(404).json({ message: 'Fan card not found' });

    db.pendingFanCards = pending.filter(card => String(card.id || card._id) !== cardId);
    db.fanCards = approvedOrRejected.filter(card => String(card.id || card._id) !== cardId);
    writeDB(db);
    for (const card of matchingCards) {
      const userId = card.userId;
      if (userId) io.to(`user:${userId}`).emit('fancard-delete', { id: cardId });
    }

    let cleanupWarning = false;
    const imageUrls = [...new Set(matchingCards.map(card => card.adminCardUrl).filter(Boolean))];
    for (const imageUrl of imageUrls) {
      try {
        await removeStoredFanCardImage(imageUrl);
      } catch (error) {
        cleanupWarning = true;
        console.error('Could not remove deleted fan card image:', error);
      }
    }
    res.json({
      message: cleanupWarning
        ? 'Fan card deleted, but its uploaded image could not be removed from storage.'
        : 'Fan card deleted',
      warning: cleanupWarning
    });
  } catch (error) {
    console.error('Could not delete fan card:', error);
    res.status(500).json({ message: 'Could not delete fan card' });
  }
});

// ── Notifications ────────────────────────────────────────────
app.get('/api/notifications', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  res.json(user?.notifications || []);
});


app.post('/api/validate-license', (req, res) => {
  const db = readDB();
  const normalizedKey = typeof req.body.licenseKey === 'string' ? req.body.licenseKey.trim().toUpperCase() : '';
  const key = (db.licenseKeys || []).find(k => k.key === normalizedKey);
  if (!key) return res.json({ valid: false, message: 'Invalid license key' });
  if (key.used) return res.json({ valid: false, message: 'Already used' });
  if (!licenseIsActive(key)) return res.json({ valid: false, message: key.active === false ? 'License is inactive' : 'License has expired' });
  res.json({ valid: true, type: key.type, description: key.description, expiresAt: key.expiresAt || null });
});

app.get('/api/backdoor/licenses', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.licenseKeys || []);
});

app.post('/api/backdoor/licenses', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const type = typeof req.body.type === 'string' ? req.body.type.trim().toLowerCase() : 'premium';
    const allowedTypes = new Set(['standard', 'premium', 'vip']);
    if (!allowedTypes.has(type)) return res.status(400).json({ message: 'Choose a valid license access type' });
    const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 160) : '';
    const expiresAt = typeof req.body.expiresAt === 'string' && req.body.expiresAt.trim() ? req.body.expiresAt.trim() : null;
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt))
      return res.status(400).json({ message: 'Expiration must be a valid date' });
    if (expiresAt && !licenseIsActive({ active: true, expiresAt }))
      return res.status(400).json({ message: 'Expiration date must be in the future' });
    if (!db.licenseKeys) db.licenseKeys = [];

    const requestedKey = typeof req.body.key === 'string' ? req.body.key.trim().toUpperCase() : '';
    let key = requestedKey;
    if (key && !/^[A-Z0-9][A-Z0-9_-]{5,63}$/.test(key))
      return res.status(400).json({ message: 'Custom license keys must be 6–64 characters using letters, numbers, hyphens, or underscores.' });
    if (key && db.licenseKeys.some(item => item.key.toUpperCase() === key))
      return res.status(409).json({ message: 'That license key already exists. Choose a different key.' });
    if (!key) {
      do {
        key = `SB-${type.toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      } while (db.licenseKeys.some(item => item.key === key));
    }
    const license = { key, type, description, used: false, active: true, expiresAt, createdAt: new Date().toISOString() };
    db.licenseKeys.push(license);
    writeDB(db);
    res.status(201).json({ message: 'License created', license });
  } catch (error) {
    console.error('Could not create license:', error);
    res.status(500).json({ message: 'Could not create license' });
  }
});

app.patch('/api/backdoor/licenses/:key', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const license = (db.licenseKeys || []).find(item => item.key === req.params.key);
    if (!license) return res.status(404).json({ message: 'License not found' });
    if (typeof req.body.active === 'boolean') license.active = req.body.active;
    if (typeof req.body.description === 'string') license.description = req.body.description.trim().slice(0, 160);
    if (req.body.expiresAt !== undefined) {
      const expiresAt = typeof req.body.expiresAt === 'string' ? req.body.expiresAt.trim() : '';
      if (expiresAt && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || !licenseIsActive({ active: true, expiresAt })))
        return res.status(400).json({ message: 'Expiration must be a valid future date or blank' });
      license.expiresAt = expiresAt || null;
    }
    license.updatedAt = new Date().toISOString();
    writeDB(db);
    res.json({ message: 'License updated', license });
  } catch (error) {
    console.error('Could not update license:', error);
    res.status(500).json({ message: 'Could not update license' });
  }
});

app.delete('/api/backdoor/licenses/:key', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const licenseIndex = (db.licenseKeys || []).findIndex(license => license.key === req.params.key);
    if (licenseIndex === -1) return res.status(404).json({ message: 'License not found' });

    const license = db.licenseKeys[licenseIndex];
    const isAssigned = (db.users || []).some(user =>
      user.licenseKey === license.key ||
      (license.usedBy && String(user.email || '').toLowerCase() === String(license.usedBy).toLowerCase())
    );
    if (license.used || isAssigned)
      return res.status(409).json({ message: 'This license has been used or assigned and cannot be deleted. Deactivate it instead.' });

    db.licenseKeys.splice(licenseIndex, 1);
    writeDB(db);
    res.json({ message: 'License deleted' });
  } catch (error) {
    console.error('Could not delete license:', error);
    res.status(500).json({ message: 'Could not delete license' });
  }
});

app.get('/api/users/me/license', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(item => item.id === req.user.userId);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const license = (db.licenseKeys || []).find(item => item.key === user.licenseKey);
  res.json({
    hasLicense: Boolean(license),
    keyMasked: license ? `${license.key.slice(0, 8)}…${license.key.slice(-4)}` : null,
    type: effectiveUserType(user, db),
    active: license ? licenseIsActive(license) && (!license.usedBy || license.usedBy.toLowerCase() === String(user.email || '').toLowerCase()) : false,
    expiresAt: license?.expiresAt || null,
    description: license?.description || null
  });
});

app.post('/api/users/me/license', authenticateToken, (req, res) => {
  try {
    const normalizedKey = typeof req.body.licenseKey === 'string' ? req.body.licenseKey.trim().toUpperCase() : '';
    if (!normalizedKey) return res.status(400).json({ message: 'Enter a license key' });
    const db = readDB();
    const user = db.users.find(item => item.id === req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const license = (db.licenseKeys || []).find(item => item.key === normalizedKey);
    if (!license || !licenseIsActive(license))
      return res.status(400).json({ message: 'License key is invalid, expired, or inactive' });
    if (license.used && String(license.usedBy || '').toLowerCase() !== String(user.email || '').toLowerCase())
      return res.status(409).json({ message: 'This license key has already been used' });

    license.used = true;
    license.usedBy = user.email;
    license.usedAt = license.usedAt || new Date().toISOString();
    user.licenseKey = license.key;
    user.userType = license.type || 'premium';
    user.updatedAt = new Date().toISOString();
    writeDB(db);
    const licenseSummary = {
      hasLicense: true,
      keyMasked: `${license.key.slice(0, 8)}…${license.key.slice(-4)}`,
      type: effectiveUserType(user, db),
      active: licenseIsActive(license),
      expiresAt: license.expiresAt || null,
      description: license.description || null
    };
    res.json({ message: 'License activated on your account', license: licenseSummary, user: { id: user.id, userType: licenseSummary.type, licenseKey: user.licenseKey } });
  } catch (error) {
    console.error('Could not apply account license:', error);
    res.status(500).json({ message: 'Could not apply license' });
  }
});

// ── Image fetch status API ───────────────────────────────────
app.get('/api/images/status', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const localFiles = listCelebrityImageFiles(PUBLIC_CELEBRITY_IMAGE_DIR).size + listCelebrityImageFiles(CELEBRITY_IMAGE_DIR).size;
  const celebrities = withLocalCelebrityImages(db.celebrities);
  const withLocal = celebrities.filter(c => /^\/(?:images\/)?celebrities\//.test(c.image)).length;
  const withAvatar = celebrities.filter(c => typeof c.image === 'string' && c.image.includes('ui-avatars')).length;
  const withReal = celebrities.filter(c =>
    typeof c.image === 'string' && !c.image.includes('ui-avatars') && !/^\/(?:images\/)?celebrities\//.test(c.image)
  ).length;
  res.json({ total: db.celebrities.length, localFiles, withLocal, withAvatar, withReal });
});

app.post('/api/images/fetch-all', authenticateToken, requireAdmin, async (req, res) => {
  res.json({ message: 'Image fetch started in background. Check /api/images/status for progress.' });
  const { fetchAllImages } = require('./image-fetcher');
  fetchAllImages(3, 1000).catch(e => console.error('Image fetch error:', e));
});

app.put('/api/users/me', authenticateToken, (req, res) => {
  try {
    const db = readDB();
    const idx = db.users.findIndex(u => u.id === req.user.userId);
    if (idx === -1) return res.status(404).json({ message: 'User not found' });
    const allow = ['fullName', 'phone', 'location', 'bio', 'avatar', 'country'];
    allow.forEach(f => { if (req.body[f] !== undefined) db.users[idx][f] = req.body[f]; });
    db.users[idx].updatedAt = new Date().toISOString();
    writeDB(db);
    const { password, ...safe } = db.users[idx];
    res.json({ message: 'Profile updated', user: safe });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.put('/api/users/me/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });
    const db = readDB();
    const idx = db.users.findIndex(u => u.id === req.user.userId);
    if (idx === -1) return res.status(404).json({ message: 'User not found' });
    if (!await bcrypt.compare(currentPassword, db.users[idx].password))
      return res.status(401).json({ message: 'Current password incorrect' });
    db.users[idx].password = await bcrypt.hash(newPassword, 10);
    db.users[idx].tokenVersion = Number(db.users[idx].tokenVersion || 0) + 1;
    addAccessLog(db, db.users[idx], 'password_changed', req);
    writeDB(db);
    io.sockets.sockets.forEach(socket => {
      if (socket.data.userId === db.users[idx].id) socket.disconnect(true);
    });
    res.json({ message: 'Password updated successfully' });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email: senderEmail, subject, message } = req.body;
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof senderEmail === 'string' ? senderEmail.trim().toLowerCase() : '';
    const normalizedSubject = typeof subject === 'string' ? subject.replace(/[\r\n\t]+/g, ' ').trim() : '';
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';
    if (!normalizedName || !normalizedEmail || !normalizedMessage)
      return res.status(400).json({ message: 'Name, email, and message required' });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalizedEmail))
      return res.status(400).json({ message: 'Enter a valid email address' });
    if (typeof subject === 'string' && subject.length > 100)
      return res.status(400).json({ message: 'Subject is too long' });
    if (normalizedSubject.length > 100) return res.status(400).json({ message: 'Subject is too long' });
    if (normalizedMessage.length > 5000) return res.status(400).json({ message: 'Message too long' });
    const db = readDB();
    if (!db.contactMessages) db.contactMessages = [];
    const linkedUser = db.users.find(user => String(user.email || '').toLowerCase() === normalizedEmail);
    db.contactMessages.push({
      id: uuidv4(),
      userId: linkedUser?.id || null,
      name: normalizedName,
      email: normalizedEmail,
      subject: normalizedSubject || 'General',
      message: normalizedMessage,
      createdAt: new Date().toISOString(),
      read: false,
      status: 'unread'
    });
    writeDB(db);
    res.status(201).json({ message: 'Message sent successfully' });
  } catch (e) { res.status(500).json({ message: 'Failed to send message' }); }
});

app.patch('/api/bookings/:id/payment', authenticateToken, (req, res) => {
  try {
    const db = readDB();
    const booking = db.bookings.find(b => b.id === req.params.id && b.userId === req.user.userId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const { paymentMethod, paymentProof, cryptoCurrency, walletAddress, giftCardBrand, giftCardCode } = req.body;
    if (typeof paymentMethod === 'string' && paymentMethod.toLowerCase() === 'card')
      return res.status(402).json({ message: "Network error connecting to your card's bank. No charge was made; choose Gift Card or Crypto." });
    if (!['crypto', 'giftcard', 'gift_card'].includes(String(paymentMethod || '').toLowerCase()))
      return res.status(400).json({ message: 'Select a supported payment method.' });
    if (booking.status !== 'pending' || booking.paymentId || booking.paymentStatus === 'approved')
      return res.status(409).json({ message: 'Payment has already been submitted or reviewed.' });
    const proofMatch = typeof paymentProof === 'string'
      ? paymentProof.match(/^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i)
      : null;
    const proofBytes = proofMatch ? Buffer.from(proofMatch[2], 'base64').length : 0;
    if (!proofMatch || !proofBytes || proofBytes > 5 * 1024 * 1024)
      return res.status(400).json({ message: 'Upload a valid payment-proof image or PDF up to 5 MB.' });
    if (String(paymentMethod).toLowerCase() === 'crypto' &&
        (typeof cryptoCurrency !== 'string' || typeof walletAddress !== 'string' ||
         !getConfiguredWallets()[cryptoCurrency] || getConfiguredWallets()[cryptoCurrency] !== walletAddress))
      return res.status(400).json({ message: 'Choose a configured cryptocurrency wallet.' });
    booking.paymentMethod = paymentMethod;
    booking.paymentProof = paymentProof || null;
    booking.cryptoCurrency = cryptoCurrency || null;
    booking.walletAddress = walletAddress || null;
    booking.giftCardBrand = giftCardBrand || null;
    booking.giftCardCode = giftCardCode || null;
    booking.paymentSubmittedAt = new Date().toISOString();
    booking.status = 'payment_submitted';
    writeDB(db);
    res.json({ message: 'Payment proof submitted', booking });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.patch('/api/backdoor/bookings/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const { action, rejectionReason } = req.body;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ message: 'Booking action must be approve or reject' });
    const booking = db.bookings.find(b => b.id === req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (action === 'approve' && String(booking.paymentMethod || '').toLowerCase() === 'card')
      return res.status(409).json({ message: 'Card payments cannot be approved because card checkout is not supported.' });
    if (action === 'approve' && String(booking.paymentStatus || '').toLowerCase() === 'approved')
      return res.status(409).json({ message: 'This booking has already been approved.' });
    if (action === 'approve') {
      const payment = (db.payments || []).find(candidate =>
        String(candidate.id) === String(booking.paymentId || '') ||
        String(candidate.bookingId) === String(booking.id)
      );
      const proofFiles = payment?.proofFiles || booking.paymentProofFiles || booking.paymentProofImages || [];
      const hasProof = (Array.isArray(proofFiles) && proofFiles.length > 0) ||
        typeof booking.paymentProof === 'string';
      if (!hasProof || !['crypto', 'giftcard', 'gift_card'].includes(String(booking.paymentMethod || '').toLowerCase()))
        return res.status(409).json({ message: 'A submitted Crypto or Gift Card proof is required before confirming this booking.' });
      if (payment && payment.status !== 'pending')
        return res.status(409).json({ message: 'This booking payment has already been reviewed.' });
      if (payment) {
        payment.status = 'approved';
        payment.reviewedAt = new Date().toISOString();
      }
      booking.paymentStatus = 'approved';
    } else {
      const payment = (db.payments || []).find(candidate =>
        String(candidate.id) === String(booking.paymentId || '') ||
        String(candidate.bookingId) === String(booking.id)
      );
      if (payment && payment.status === 'pending') {
        payment.status = 'rejected';
        payment.reviewedAt = new Date().toISOString();
        payment.rejectionReason = typeof rejectionReason === 'string' ? rejectionReason.trim().slice(0, 500) : '';
      }
      booking.paymentStatus = 'rejected';
    }
    const bookingWasConfirmed = booking.status === 'confirmed';
    booking.status = action === 'approve' ? 'confirmed' : 'rejected';
    booking.reviewedAt = new Date().toISOString();
    if (action === 'approve') issueBookingTicket(booking);
    else delete booking.ticketCode;
    if (rejectionReason) booking.rejectionReason = rejectionReason;
    const user = db.users.find(u => u.id === booking.userId);
    if (user) {
      if (!user.notifications) user.notifications = [];
      const msg = action === 'approve'
        ? `✅ Your booking for ${booking.celebrityName} on ${booking.eventDate} is confirmed!`
        : `❌ Your booking for ${booking.celebrityName} was rejected. ${rejectionReason ? 'Reason: ' + rejectionReason : ''}`;
      user.notifications.push({ id: uuidv4(), message: msg, read: false, createdAt: new Date().toISOString() });
      io.to(`user:${user.id}`).emit('booking-update', { bookingId: booking.id, status: booking.status });
    }
    writeDB(db);
    if (action === 'approve' && user && !bookingWasConfirmed)
      email.sendBookingApproved({ user, booking })
        .catch(error => console.error('Booking approval email failed:', error.message));
    res.json({ message: `Booking ${action}d`, booking });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.delete('/api/backdoor/bookings/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const bookings = db.bookings || [];
    const bookingIndex = bookings.findIndex(booking =>
      String(booking.id || booking._id) === req.params.id
    );
    if (bookingIndex === -1) return res.status(404).json({ message: 'Booking not found' });

    const [booking] = bookings.splice(bookingIndex, 1);
    const bookingId = String(booking.id || booking._id);
    const paymentIds = new Set(booking.paymentId ? [String(booking.paymentId)] : []);
    const payments = db.payments || [];
    const linkedPayments = payments.filter(payment =>
      String(payment.bookingId || '') === bookingId ||
      paymentIds.has(String(payment.id || payment._id))
    );
    db.payments = payments.filter(payment =>
      String(payment.bookingId || '') !== bookingId &&
      !paymentIds.has(String(payment.id || payment._id))
    );
    writeDB(db);
    if (booking.userId) io.to(`user:${booking.userId}`).emit('booking-delete', { bookingId });
    res.json({
      message: linkedPayments.length
        ? 'Booking and linked payment proof(s) deleted'
        : 'Booking deleted',
      deletedPayments: linkedPayments.length
    });
  } catch (error) {
    console.error('Could not delete booking:', error);
    res.status(500).json({ message: 'Could not delete booking' });
  }
});

app.patch('/api/backdoor/users/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.userType === 'admin') return res.status(403).json({ message: 'Admin accounts cannot be banned here' });
    const { action, banned } = req.body;
    if (typeof banned !== 'boolean' && !['ban', 'unban'].includes(action))
      return res.status(400).json({ message: 'Choose ban or unban' });
    const wasBanned = Boolean(user.banned);
    user.banned = typeof banned === 'boolean' ? banned : action === 'ban';
    user.bannedAt = user.banned ? (wasBanned && user.bannedAt ? user.bannedAt : new Date().toISOString()) : null;
    if (wasBanned !== user.banned)
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    if (user.banned && !wasBanned) {
      if (!user.notifications) user.notifications = [];
      user.notifications.push({
        id: uuidv4(),
        message: 'Your account has been suspended. Contact StarBook support if you believe this was a mistake.',
        read: false,
        createdAt: new Date().toISOString()
      });
    }
    addAccessLog(db, db.users.find(candidate => candidate.id === req.user.userId), `user_${user.banned ? 'disabled' : 'enabled'}`, req);
    writeDB(db);
    res.json({ message: `User ${user.banned ? 'banned' : 'unbanned'}`, banned: user.banned });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/backdoor/notifications', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const target = typeof req.body.target === 'string' ? req.body.target.trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ message: 'Message required' });
    if (message.length > 2000) return res.status(400).json({ message: 'Message must be 2,000 characters or fewer' });
    let targets;
    if (target === 'all') {
      targets = db.users.filter(u => u.userType !== 'admin');
    } else if (target === 'email' || target === '') {
      const emailAddress = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!emailAddress) return res.status(400).json({ message: 'Enter a recipient email address' });
      const recipient = db.users.find(u => u.email?.toLowerCase() === emailAddress && u.userType !== 'admin');
      if (!recipient) return res.status(404).json({ message: 'No public user found with that email address' });
      targets = [recipient];
    } else {
      const recipient = db.users.find(u => u.email?.toLowerCase() === target.toLowerCase() && u.userType !== 'admin');
      if (!recipient) return res.status(404).json({ message: 'No public user found with that email address' });
      targets = [recipient];
    }
    if (!targets.length) return res.status(404).json({ message: 'No user accounts are available for this notification' });
    targets.forEach(u => {
      if (!u.notifications) u.notifications = [];
      const notification = { id: uuidv4(), message, read: false, createdAt: new Date().toISOString() };
      u.notifications.push(notification);
      io.to(`user:${u.id}`).emit('notification', notification);
    });
    writeDB(db);
    res.json({ message: `Notification sent to ${targets.length} user(s)`, delivered: targets.length });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/backdoor/notifications', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const notifications = (db.users || [])
    .filter(user => user.userType !== 'admin')
    .flatMap(user => (user.notifications || []).map(notification => ({
      ...notification,
      id: String(notification.id || notification._id || ''),
      userId: user.id,
      userName: user.fullName || user.username || user.email,
      userEmail: user.email
    })))
    .filter(notification => notification.id)
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  res.json(notifications);
});

app.patch('/api/backdoor/notifications/:userId/:notificationId', authenticateToken, requireAdmin, (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ message: 'Notification message is required' });
  if (message.length > 2000) return res.status(400).json({ message: 'Message must be 2,000 characters or fewer' });

  const db = readDB();
  const user = (db.users || []).find(candidate =>
    String(candidate.id || candidate._id) === req.params.userId && candidate.userType !== 'admin'
  );
  if (!user) return res.status(404).json({ message: 'Notification recipient not found' });
  const notification = (user.notifications || []).find(item =>
    String(item.id || item._id) === req.params.notificationId
  );
  if (!notification) return res.status(404).json({ message: 'Notification not found' });

  notification.message = message;
  notification.editedAt = new Date().toISOString();
  writeDB(db);
  io.to(`user:${user.id}`).emit('notification-update', notification);
  res.json({ message: 'Notification updated', notification });
});

app.delete('/api/backdoor/notifications/:userId/:notificationId', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const user = (db.users || []).find(candidate =>
    String(candidate.id || candidate._id) === req.params.userId && candidate.userType !== 'admin'
  );
  if (!user) return res.status(404).json({ message: 'Notification recipient not found' });
  const notifications = user.notifications || [];
  const index = notifications.findIndex(item =>
    String(item.id || item._id) === req.params.notificationId
  );
  if (index === -1) return res.status(404).json({ message: 'Notification not found' });

  notifications.splice(index, 1);
  user.notifications = notifications;
  writeDB(db);
  io.to(`user:${user.id}`).emit('notification-delete', { id: req.params.notificationId });
  res.json({ message: 'Notification deleted' });
});

app.patch('/api/notifications/read-all', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (user?.notifications) user.notifications.forEach(n => { n.read = true; });
  writeDB(db); res.json({ message: 'All marked read' });
});

app.get('/api/notifications/mine', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  res.json(user?.notifications || []);
});

app.patch('/api/notifications/:id/read', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (user?.notifications) {
    const n = user.notifications.find(n => n.id === req.params.id);
    if (n) n.read = true;
  }
  writeDB(db); res.json({ message: 'Marked read' });
});

// ── Admin: Add Celebrity ─────────────────────────────────────────
app.post('/api/backdoor/celebrities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = readDB();
    const body = req.body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'Actor';
    const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim() : 'USA';
    const price = Number(body.price);
    if (!name) return res.status(400).json({ message: 'Celebrity name is required' });
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ message: 'Enter a valid booking price greater than zero' });
    const newId = Math.max(0, ...db.celebrities.map(c => Number(c.id) || 0)) + 1;
    const catColors = {Musician:'ec4899',Actor:'8b5cf6',Footballer:'10b981',Athlete:'f59e0b',Influencer:'ec4899',DJ:'6366f1',Comedian:'f97316',YouTuber:'ef4444',Model:'a855f7',Streamer:'3b82f6',Podcaster:'14b8a6','TV Host':'0ea5e9'};
    const bg = catColors[category] || 'F5C842';
    const newCeleb = {
      id: newId, name, category,
      rating: parseFloat(body.rating)||4.5, location,
      price: Math.round(price),
      image: await storeCelebrityImage(body.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=300&background=${bg}&color=ffffff&bold=true&length=2`, newId),
      featured: body.featured===true||body.featured==='true',
      followers: body.followers||'1M+', verified: true,
      responseTime: body.responseTime||'24 hours', languages: body.languages||['English'],
      tags: body.tags||[category],
      services: body.services||['Birthday shoutout','Video message','Brand promotion'],
      socials: {instagram:'',twitter:''},
      video: '', experience: body.experience||['Industry professional'],
      certifications: ['StarBook Platform Certified','Industry Verified Celebrity'],
      reviews: [], bookingsCount: 0, available: true, bio: body.bio||'',
      createdAt: new Date().toISOString()
    };
    db.celebrities.push(newCeleb);
    writeDB(db);
    res.status(201).json({ message: 'Celebrity added', celebrity: newCeleb });
  } catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Server error: ' + e.message }); }
});

app.patch('/api/backdoor/celebrities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = readDB();
    const idx = db.celebrities.findIndex(c => c.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ message: 'Celebrity not found' });
    if (req.body.name !== undefined && (typeof req.body.name !== 'string' || !req.body.name.trim()))
      return res.status(400).json({ message: 'Celebrity name cannot be empty' });
    if (req.body.price !== undefined && (!Number.isFinite(Number(req.body.price)) || Number(req.body.price) <= 0))
      return res.status(400).json({ message: 'Enter a valid booking price greater than zero' });
    if (['category', 'location'].some(field => req.body[field] !== undefined && typeof req.body[field] !== 'string'))
      return res.status(400).json({ message: 'Category and location must be text values' });
    const upd = ['name','category','rating','location','price','image','featured','followers','verified','responseTime','bio','available'];
    for (const field of upd) {
      if (req.body[field] !== undefined) {
        db.celebrities[idx][field] = field === 'image'
          ? await storeCelebrityImage(req.body[field], db.celebrities[idx].id)
          : field === 'name' || field === 'category' || field === 'location'
            ? req.body[field].trim()
            : field === 'price' ? Math.round(Number(req.body[field])) : req.body[field];
      }
    }
    if (req.body.services) db.celebrities[idx].services = req.body.services;
    if (req.body.experience) db.celebrities[idx].experience = req.body.experience;
    db.celebrities[idx].updatedAt = new Date().toISOString();
    writeDB(db);
    res.json({ message: 'Celebrity updated', celebrity: db.celebrities[idx] });
  } catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Server error' }); }
});

app.delete('/api/backdoor/celebrities/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const idx = db.celebrities.findIndex(c => c.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ message: 'Not found' });
    db.celebrities.splice(idx, 1);
    writeDB(db);
    res.json({ message: 'Celebrity removed' });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.patch('/api/backdoor/fancards/:id/upload-card', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = readDB();
    const card = (db.fanCards || []).find(f => String(f.id || f._id) === req.params.id);
    if (!card) return res.status(404).json({ message: 'Approved fan card not found' });
    if (card.status !== 'approved') return res.status(409).json({ message: 'Approve this fan card before uploading its physical card image' });
    const previousImageUrl = card.adminCardUrl;
    const adminCardUrl = await storeFanCardImage(req.body.adminCardBase64, card.id);
    card.adminCardBase64 = null;
    card.adminCardUrl = adminCardUrl;
    card.adminCardUploadedAt = new Date().toISOString();
    const user = db.users.find(u => u.id === card.userId);
    if (user) {
      if (!user.notifications) user.notifications = [];
      const notification = {
        id: uuidv4(),
        message: `🎨 Your physical ${card.membershipLevel || card.tier || 'Fan'} Card for ${card.celebrityName || card.celebName || 'your selected celebrity'} is ready! View it in My Fan Cards.`,
        read: false,
        createdAt: new Date().toISOString()
      };
      user.notifications.push(notification);
      io.to(`user:${user.id}`).emit('notification', notification);
      io.to(`user:${user.id}`).emit('fancard-update', { id: card.id, status: card.status, adminCardUrl });
    }
    writeDB(db);
    if (user)
      email.sendFanCardDelivered({ user, fanCard: card })
        .catch(error => console.error('Physical fan card delivery email failed:', error.message));
    let cleanupWarning = false;
    if (previousImageUrl && previousImageUrl !== adminCardUrl) {
      try {
        await removeStoredFanCardImage(previousImageUrl);
      } catch (error) {
        cleanupWarning = true;
        console.error('Could not remove the replaced fan card image:', error);
      }
    }
    res.json({
      message: cleanupWarning
        ? 'Card uploaded and user notified; the previous image could not be removed from storage.'
        : 'Card uploaded and user notified',
      warning: cleanupWarning,
      card
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('Could not upload fan card image:', error);
    res.status(500).json({ message: 'Could not upload fan card image' });
  }
});

app.delete('/api/backdoor/fancards/:id/card-image', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = readDB();
    const card = (db.fanCards || []).find(f => String(f.id || f._id) === req.params.id);
    if (!card) return res.status(404).json({ message: 'Approved fan card not found' });
    if (!card.adminCardUrl && !card.adminCardBase64)
      return res.status(404).json({ message: 'This fan card has no uploaded image' });

    const previousImageUrl = card.adminCardUrl;
    card.adminCardUrl = null;
    card.adminCardBase64 = null;
    delete card.adminCardUploadedAt;
    writeDB(db);
    if (card.userId) {
      io.to(`user:${card.userId}`).emit('fancard-update', {
        id: card.id || card._id,
        status: card.status,
        adminCardUrl: null,
        imageRemoved: true
      });
    }

    if (previousImageUrl) {
      try {
        await removeStoredFanCardImage(previousImageUrl);
      } catch (error) {
        console.error('Could not remove fan card image from storage:', error);
        return res.json({
          message: 'Card image removed from the fan card, but its stored file could not be deleted.',
          warning: true
        });
      }
    }
    res.json({ message: 'Card image removed' });
  } catch (error) {
    console.error('Could not remove fan card image:', error);
    res.status(500).json({ message: 'Could not remove fan card image' });
  }
});

app.get('/api/backdoor/fancards/approved', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.fanCards || []);
});

// ── Testimonial: Admin direct add (published immediately) ────────
app.post('/api/backdoor/testimonials/add', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const location = typeof req.body.location === 'string' ? req.body.location.trim() : '';
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    const rating = Number(req.body.rating);
    if (!name || !comment) return res.status(400).json({ message: 'Name and comment required' });
    if (name.length > 100 || location.length > 100 || comment.length > 2000)
      return res.status(400).json({ message: 'Name, location, or review is too long' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      return res.status(400).json({ message: 'Rating must be between 1 and 5 stars' });
    const createdAt = new Date().toISOString();
    const newTest = {
      id: uuidv4(), name, location, rating, comment,
      initial: name.charAt(0).toUpperCase(),
      date: createdAt,
      createdAt,
      approved: true, addedByAdmin: true
    };
    if (!db.testimonials) db.testimonials = [];
    db.testimonials.push(newTest);
    writeDB(db);
    res.status(201).json({ message: 'Testimonial added and published', testimonial: newTest });
  } catch(e) { res.status(500).json({ message: 'Server error' }); }
});

// ── Testimonial: Remove published ────────────────────────────────
app.delete('/api/backdoor/testimonials/:id/remove', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = readDB();
    const idx = (db.testimonials||[]).findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ message: 'Testimonial not found' });
    db.testimonials.splice(idx, 1);
    writeDB(db);
    res.json({ message: 'Testimonial removed from site' });
  } catch(e) { res.status(500).json({ message: 'Server error' }); }
});

app.delete('/api/backdoor/testimonials/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const publishedCount = (db.testimonials || []).length;
  const pendingCount = (db.pendingTestimonials || []).length;
  db.testimonials = (db.testimonials || []).filter(item => item.id !== req.params.id);
  db.pendingTestimonials = (db.pendingTestimonials || []).filter(item => item.id !== req.params.id);
  if (publishedCount === db.testimonials.length && pendingCount === db.pendingTestimonials.length)
    return res.status(404).json({ message: 'Testimonial not found' });
  writeDB(db);
  res.json({ message: 'Testimonial removed' });
});

// ── Catch-all ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Route not found' });
  res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
});

// ── Start ─────────────────────────────────────────────────────
if (require.main === module) {
  connectMongo().then(() => {
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 StarBook listening on 0.0.0.0:${PORT}`);
      console.log(`🔐 Admin panel: /backdoor`);
      console.log(`🗄  DB: ${isConnected() ? 'MongoDB ✅' : 'JSON fallback ⚠️'}`);
      console.log(`🔌 Socket.IO: enabled`);
      console.log(`📧 Email: ${process.env.BREVO_API_KEY && process.env.BREVO_API_KEY !== 'your-brevo-api-key-here' ? 'Brevo ✅' : 'not configured ⚠️'}\n`);
    });
  });
}

module.exports = app;
module.exports.httpServer = httpServer;
module.exports.io = io;
