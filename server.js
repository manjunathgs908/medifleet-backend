'use strict';
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const dotenv     = require('dotenv');

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: [
    'https://crm.savelife.health',
    'https://api.savelife.health',
    'https://medifleet-frontend-1.onrender.com',
    'http://localhost:3000',
    'http://localhost:8081',
    'http://localhost:19006'
  ],
  credentials: true
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Cloud Database Connected Successfully.'))
  .catch(err => console.error('Database connection error:', err));

const authRoutes     = require('./routes/auth');
const vehicleRoutes  = require('./routes/vehicles');
const billingRoutes  = require('./routes/billing');
const tripRoutes     = require('./routes/trips');
const hospitalRoutes = require('./routes/hospitals');
const leadsRoutes    = require('./routes/leads');
const salaryRoutes   = require('./routes/salary');
const financeRoutes  = require('./routes/finance');
const tripActivityRoutes = require('./routes/tripActivity');
const attendanceRoutes = require('./routes/attendance');
const advanceRoutes = require('./routes/advance');
const bookingTripRoutes = require('./routes/bookingTrip');
const pricingRoutes = require('./routes/pricing');
const freezerRoutes = require('./routes/freezer');
app.use('/api/auth',      authRoutes);
app.use('/api/vehicles',  vehicleRoutes);
app.use('/api/billing',   billingRoutes);
app.use('/api/trips',     tripRoutes);
app.use('/api/hospitals', hospitalRoutes);
app.use('/api/leads',     leadsRoutes);
app.use('/api/salary',    salaryRoutes);
app.use('/api/finance',   financeRoutes);
app.use('/api/trip-activity', tripActivityRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/advances', advanceRoutes);
app.use('/api/booking-trips', bookingTripRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/freezer', freezerRoutes);
app.get('/setup', async (req, res) => {
  try {
    const { User, Hospital } = require('./models');
    await User.deleteMany({ phone: { $in: ['8884092777', '9986844442'] } });
    await User.create({ name: 'Driver', phone: '8884092777', password: 'Driver@123', role: 'driver', isActive: true });
    await User.create({ name: 'Telecaller', phone: '9986844442', password: 'Tele@123', role: 'telecaller', isActive: true });
    await Hospital.deleteMany({ name: { $in: ['Manipal Hospital', 'Apollo Hospital'] } });
    await Hospital.create({ name: 'Manipal Hospital', address: 'Mysore', phone: '0821-2222222', isActive: true });
    await Hospital.create({ name: 'Apollo Hospital', address: 'Mysore', phone: '0821-3333333', isActive: true });
    res.json({ message: 'Setup completed successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
    res.json({ message: 'MediFleet Backend API is running smoothly.' });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 MEDIFLEET BACKEND RUNNING SUCCESSFULLY ON PORT: ${PORT}`);
    console.log(`==================================================`);
});