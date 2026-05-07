import { test } from '@playwright/test';

test('GET /api/me/invoices — log real response', async ({ request, baseURL }) => {
  // Step 1: log in as buyer@test.com
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: 'buyer@test.com', password: 'password123' },
  });
  const loginBody = await loginRes.json();
  console.log('[login] status:', loginRes.status());
  console.log('[login] body:', JSON.stringify(loginBody, null, 2));

  const token = loginBody.token;

  // Step 2: call GET /api/me/invoices
  const invoicesRes = await request.get(`${baseURL}/api/me/invoices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const invoicesBody = await invoicesRes.json().catch(async () => {
    const text = await invoicesRes.text();
    return { _raw: text };
  });

  // Step 3: print status and full response body
  console.log('[invoices] status:', invoicesRes.status());
  console.log('[invoices] body:', JSON.stringify(invoicesBody, null, 2));
});
