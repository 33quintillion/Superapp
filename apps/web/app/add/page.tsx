import { redirect } from 'next/navigation';

/** The "Find" box on the account page: /add?code=... becomes /add/CODE. */
export default async function AddByQuery({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const clean = (code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10);
  redirect(clean ? `/add/${clean}` : '/account');
}
