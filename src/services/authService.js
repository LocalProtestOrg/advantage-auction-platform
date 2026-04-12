const jwt = require('jsonwebtoken');
const db = require('../db/index');

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

    // TEMP DEV LOGIN (replace with bcrypt later)
    if (email !== 'seller1@example.com' || password !== 'test') {
      throw new Error('Invalid credentials');
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
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