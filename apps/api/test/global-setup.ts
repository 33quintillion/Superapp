import { resetDatabase } from './helpers';

export default async function globalSetup() {
  await resetDatabase();
}
