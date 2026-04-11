// AuthService skeleton
class AuthService {
  async authenticate(credentials) {
    // TODO: Verify email/password or token, return user object with role
    throw new Error('Not implemented');
  }

  async authorize(user, role) {
    // TODO: Check if user.role matches required role (seller, buyer, admin)
    throw new Error('Not implemented');
  }
}

module.exports = new AuthService();
