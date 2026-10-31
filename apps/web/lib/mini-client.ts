// Mini-programs: a business's own small app, built from blocks and shown inside SuperApp.
import type { Business } from './business-client';

export type Action = { type: 'page'; pageId: string } | { type: 'order' } | { type: 'book' } | { type: 'call' } | { type: 'link'; url: string };

export type Block =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'button'; label: string; action: Action }
  | { type: 'items'; title: string }
  | { type: 'hours' }
  | { type: 'location'; lat: number; lng: number; label: string }
  | { type: 'divider' };

export interface MiniPage {
  id: string;
  title: string;
  blocks: Block[];
}

export type Accent = 'navy' | 'burgundy' | 'gold' | 'red' | 'green';

export interface MiniProgram {
  name: string;
  tagline: string;
  icon: string;
  accent: Accent;
  pages: MiniPage[];
}

export interface MiniCard {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  accent: Accent;
  business: { id: string; handle: string; name: string; verified: boolean };
  hasMenu: boolean;
}

export interface OpenedMini extends MiniProgram {
  id: string;
  publishedAt: string;
  business: Business;
}

export interface StaffMini {
  id: string;
  businessId: string;
  draft: MiniProgram;
  published: MiniProgram | null;
  publishedAt: string | null;
  updatedAt: string;
}

export const ACCENTS: Accent[] = ['navy', 'burgundy', 'gold', 'red', 'green'];

export const BLOCK_LABELS: Record<Block['type'], string> = {
  heading: 'Heading',
  text: 'Text',
  button: 'Button',
  items: 'Menu (your catalogue, with prices)',
  hours: 'Opening hours',
  location: 'Map pin',
  divider: 'Divider',
};

export const ACTION_LABELS: Record<Action['type'], string> = {
  page: 'Go to a page',
  order: 'Order for pickup',
  book: 'Book',
  call: 'Call the business',
  link: 'Open a website',
};

/** A starting point for a restaurant or hotel. */
export function starterProgram(businessName: string): MiniProgram {
  return {
    name: businessName.slice(0, 60),
    tagline: '',
    icon: '🛍️',
    accent: 'navy',
    pages: [
      {
        id: 'home',
        title: 'Home',
        blocks: [
          { type: 'heading', text: `Welcome to ${businessName}`.slice(0, 120) },
          { type: 'text', text: 'Tell customers what you offer.' },
          { type: 'button', label: 'See the menu', action: { type: 'page', pageId: 'menu' } },
          { type: 'hours' },
        ],
      },
      { id: 'menu', title: 'Menu', blocks: [{ type: 'items', title: '' }, { type: 'button', label: 'Order for pickup', action: { type: 'order' } }] },
    ],
  };
}
