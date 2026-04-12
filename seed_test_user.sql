WITH new_user AS (
INSERT INTO users (email, password_hash, role)
VALUES (
'seller1@example.com',
'$2b$10$exampleplaceholderhashreplaceifneeded',
'seller'
)
RETURNING id
)
INSERT INTO seller_profiles (user_id, display_name, business_name, phone)
SELECT
id,
'Test Seller',
'Test Seller Auctions',
'555-555-5555'
FROM new_user;
