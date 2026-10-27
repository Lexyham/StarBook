const mongoose = require('mongoose');

let connected = false;

async function connectMongo() {
  if (connected) return;
  if (String(process.env.USE_MONGODB || '').trim().toLowerCase() === 'false') {
    console.log('MongoDB disabled by USE_MONGODB=false; using JSON storage');
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    console.log('MongoDB connected');
  } catch (e) {
    console.warn('MongoDB unavailable - using JSON fallback:', e.message);
  }
}

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  fullName: String,
  username: String,
  email: { type: String, unique: true, sparse: true },
  password: String,
  userType: { type: String, default: 'standard' },
  licenseKey: String,
  phone: String,
  location: String,
  bio: String,
  avatar: String,
  banned: { type: Boolean, default: false },
  bannedAt: String,
  lastLogin: String,
  notifications: { type: Array, default: [] },
  createdAt: String,
  updatedAt: String
}, { strict: false });

const celebSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: String,
  category: String,
  rating: Number,
  location: String,
  price: Number,
  image: String,
  featured: Boolean,
  followers: String,
  verified: Boolean,
  available: Boolean,
  responseTime: String,
  languages: [String],
  tags: [String],
  services: [String],
  bio: String,
  bookingsCount: { type: Number, default: 0 },
  reviews: { type: Array, default: [] },
  experience: [String],
  certifications: [String],
  socials: Object,
  video: String,
  createdAt: String,
  updatedAt: String
}, { strict: false });

const bookingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: String,
  celebrityId: Number,
  celebrityName: String,
  celebrityImage: String,
  celebrityCategory: String,
  eventDate: String,
  eventType: String,
  notes: String,
  status: { type: String, default: 'pending' },
  totalAmount: Number,
  paymentMethod: String,
  paymentProof: String,
  cryptoCurrency: String,
  walletAddress: String,
  giftCardBrand: String,
  giftCardCode: String,
  paymentSubmittedAt: String,
  rejectionReason: String,
  reviewedAt: String,
  createdAt: String
}, { strict: false });

const fanCardSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: String,
  celebId: Number,
  celebName: String,
  membershipLevel: String,
  fanId: String,
  status: { type: String, default: 'pending' },
  paymentMethod: String,
  paymentProof: String,
  expiryDate: String,
  adminCardBase64: String,
  adminCardUrl: String,
  adminCardUploadedAt: String,
  rejectionReason: String,
  approvedAt: String,
  createdAt: String
}, { strict: false });

const testimonialSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: String,
  rating: Number,
  comment: String,
  initial: String,
  date: String,
  approved: { type: Boolean, default: false },
  addedByAdmin: Boolean
}, { strict: false });

const licenseKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  type: String,
  description: String,
  used: { type: Boolean, default: false },
  usedBy: String
}, { strict: false });

const paymentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  bookingId: { type: String, default: null, index: true },
  method: { type: String, required: true },
  amount: Number, currency: String, status: { type: String, default: 'pending' },
  reference: String, last4: String, cardBrand: String, details: Object,
  createdAt: String, updatedAt: String
}, { strict: true });

const contactSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: String,
  email: String,
  subject: String,
  message: String,
  read: { type: Boolean, default: false },
  createdAt: String
}, { strict: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Celebrity = mongoose.models.Celebrity || mongoose.model('Celebrity', celebSchema);
const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
const FanCard = mongoose.models.FanCard || mongoose.model('FanCard', fanCardSchema);
const Testimonial = mongoose.models.Testimonial || mongoose.model('Testimonial', testimonialSchema);
const LicenseKey = mongoose.models.LicenseKey || mongoose.model('LicenseKey', licenseKeySchema);
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);
const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

module.exports = { connectMongo, isConnected, User, Celebrity, Booking, FanCard, Testimonial, LicenseKey, Contact, Payment };
