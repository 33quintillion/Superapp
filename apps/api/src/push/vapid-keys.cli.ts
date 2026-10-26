import { generateVapidKeys } from './webpush';

// Prints a new VAPID key pair for Web Push. Keep the private key secret; rotating it
// invalidates every existing browser subscription.
const keys = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
