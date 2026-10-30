-- Destructive rollback for db/migrations/001_initial_schema.sql.
-- Export and verify order/customer data before running this file.
BEGIN;
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS inventory;
DELETE FROM schema_migrations WHERE version = '001_initial_schema.sql';
COMMIT;
