'use strict';

const { Pricing } = require('../models');

exports.getPricing = async (req, res) => {
  try {
   const pricing = await Pricing.find({});

console.log("PRICING COUNT =", pricing.length);
console.log("PRICING DATA =", pricing);

res.json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPricingByVehicle = async (req, res) => {
  try {
    const pricing = await Pricing.findOne({
      vehicleType: req.params.vehicleType,
      active: true,
    });

    if (!pricing) {
      return res.status(404).json({
        success: false,
        message: 'Pricing not found',
      });
    }

    res.json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createPricing = async (req, res) => {
  try {
    const pricing = await Pricing.create(req.body);
    res.status(201).json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updatePricing = async (req, res) => {
  try {
    const pricing = await Pricing.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    res.json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};