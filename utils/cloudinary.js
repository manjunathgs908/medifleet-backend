const fareUtils = require('./fareCalculator');
module.exports = { cloudinary: fareUtils.cloudinary, uploadToCloudinary: fareUtils.uploadToCloudinary };