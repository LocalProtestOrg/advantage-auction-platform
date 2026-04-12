SELECT
u.id AS user_id,
u.email,
u.role,
sp.id AS seller_profile_id,
sp.display_name,
sp.business_name
FROM users u
LEFT JOIN seller_profiles sp ON sp.user_id = u.id
WHERE u.email = 'seller1@example.com';
