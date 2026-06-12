const bcrypt = require('bcryptjs');

const password = process.argv[2] || 'SaveLife@2026';

bcrypt.genSalt(12).then(salt => bcrypt.hash(password, salt)).then(hash => {
  console.log(hash);
});
