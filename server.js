'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const dotenv     = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();

// Standard Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Cloud Database Connected Successfully.'))
  .catch(err => console.error('Database connection error:', err));

// Application Routes
const authRoutes    = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const billingRoutes = require('./routes/billing');

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/billing', billingRoutes);

// Base Route
app.get('/', (req, res) => {
    res.json({ message: 'MediFleet Backend API is running smoothly.' });
});

// Global Error Handler
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