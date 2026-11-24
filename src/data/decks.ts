import { CardData } from '@/types/game';

export interface DeckPreset {
  id: string;
  name: string;
  description: string;
  cards: CardData[];
}

export const PRESET_DECKS: DeckPreset[] = [];