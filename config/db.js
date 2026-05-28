/**
 * config/db.js
 * ──────────────────────────────────────────────────────────
 * Mongoose connection factory. Called once on server boot.
 * Emits lifecycle events for monitoring and graceful shutdown.
 */

'use strict';

const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Mongoose 7+ no longer needs these options, but kept for 6.x compat:
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
      serverSelectionTimeoutMS : 10000, // 10s connection timeout
      socketTimeoutMS          : 45000, // 45s socket timeout
    });

    console.log(`✅  MongoDB connected: ${conn.connection.host}`);

    // Log on disconnection
    mongoose.connection.on('disconnected', () =>
      console.warn('⚠️   MongoDB disconnected. Retrying...')
    );

    // Graceful shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('🔌  MongoDB connection closed via app termination');
      process.exit(0);
    });

  } catch (error) {
    console.error(`❌  MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
