const fareUtils = require('./fareCalculator');
module.exports = { sendOtp: fareUtils.sendOtp, sendAlert: fareUtils.sendAlert };