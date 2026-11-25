import { supabase } from '@/lib/supabase';

export interface CustomDeckRecord {
  id: string;
  name: string;
  description?: string;
  kindan_type?: string;
  kindan_front_image_url?: string;
  kindan_back_image_url?: string;
  cards: unknown[];
  updated_at?: string;
}

export async function fetchCustomDecks(): Promise<CustomDeckRecord[]> {
  const { data, error } = await supabase
    .from('custom_decks')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) {
    throw error;
  }
  return (data ?? []) as CustomDeckRecord[];
}

export async function fetchCustomDeckById(deckId: string): Promise<CustomDeckRecord | null> {
  const { data, error } = await supabase
    .from('custom_decks')
    .select('*')
    .eq('id', deckId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as CustomDeckRecord | null) ?? null;
}

export async function saveCustomDeck(deck: CustomDeckRecord): Promise<void> {
  const { error } = await supabase
    .from('custom_decks')
    .upsert(
      {
        id: deck.id,
        name: deck.name,
        description: deck.description ?? '',
        kindan_type: deck.kindan_type ?? 'none',
        kindan_front_image_url: deck.kindan_front_image_url ?? '',
        kindan_back_image_url: deck.kindan_back_image_url ?? '',
        cards: deck.cards ?? [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

  if (error) {
    throw error;
  }
}

export async function deleteCustomDeck(deckId: string): Promise<void> {
  const { error } = await supabase.from('custom_decks').delete().eq('id', deckId);
  if (error) {
    throw error;
  }
}