'use strict';
const mongoose = require('mongoose');

// The CRM's on/off switch for the AI telecaller pilot — one document
// (key 'global'). It can only ever turn calling OFF further: the env var
// AI_CALLER_ENABLED must also be 'true' for any call to start
// (services/aiCaller/config.js). Missing document = off.
const AiCallerSettingSchema = new mongoose.Schema(
  {
    key      : { type: String, default: 'global', unique: true },
    enabled  : { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AiCallerSetting', AiCallerSettingSchema);
