// Guard: the public GET /api/auctions list must exclude archived auctions, aligning
// it with /api/public/auctions and policy #22 (archived auctions never appear publicly).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auctions.js'), 'utf8');

describe('GET /api/auctions (public list)', () => {
  test('list query excludes draft AND archived auctions', () => {
    const m = src.match(/router\.get\('\/',[\s\S]*?ORDER BY end_time DESC NULLS LAST/);
    expect(m).toBeTruthy();
    const handler = m[0];
    expect(handler).toMatch(/state\s*!=\s*'draft'/);
    expect(handler).toMatch(/is_archived IS NOT TRUE/i);
  });
});
