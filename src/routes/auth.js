const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// TEMP TEST LOGIN ONLY
router.post('/login', (req, res) => {
  const { email } = req.body;

  let role = 'buyer';
  if (email && email.includes('admin')) role = 'admin';
  if (email && email.includes('seller')) role = 'seller';

  const token = jwt.sign(
    { id: 'test-user-id', role },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '1h' }
  );

  res.json({ token });
});

module.exports = router;
