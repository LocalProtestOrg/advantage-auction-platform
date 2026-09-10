const jwt = require('jsonwebtoken');
const db = require('../db/index');
const bcrypt = require('bcrypt');

class AuthService {
  async authenticate(credentials) {
    const { email, password } = credentials;

    const query = `
      SELECT id, email, role, password_hash, is_active
      FROM users
      WHERE email = $1
      LIMIT 1;
    `;

    const result = await db.query(query, [email]);

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0];

    if (!user.is_active) {
      throw new Error('User account is inactive');
    }

    // No local password (NULL/empty hash) can never authenticate through password login.
    const hash = typeof user.password_hash === 'string' && user.password_hash.length ? user.password_hash : null;
    let validPassword = false;
    if (hash) { try { validPassword = await bcrypt.compare(String(password), hash); } catch (_) { validPassword = false; } }
    if (validPassword !== true) {
      throw new Error('Invalid credentials');
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    };
  }

  async authorize(user, roles) {
    if (!user || !roles.includes(user.role)) {
      throw new Error('Forbidden');
    }
    return true;
  }
}

module.exports = new AuthService();