-- "My QR code", as in WeChat and WhatsApp: a code that opens a chat with you. It can be reset,
-- which stops old printouts and screenshots from working. Made the first time it's asked for.
ALTER TABLE users ADD COLUMN contact_code text UNIQUE CHECK (contact_code ~ '^[23456789A-HJ-NP-Z]{10}$');
