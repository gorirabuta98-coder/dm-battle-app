export type Civilization = 'fire' | 'water' | 'nature' | 'light' | 'darkness' | 'zero';

export type KindanType = 'none' | 'dokindam' | 'dormageddon';

export interface CardData {
  id: string;
  name: string;
  cost: number;
  civilization: Civilization[];
  type: 'creature' | 'spell' | 'evolution' | 'tamaseed' | 'field';
  power?: number;
  text: string;
  isShieldTrigger?: boolean;
  isD2Field?: boolean;
  imageUrl?: string;
  aiEffects?: {
    onPlayLookDeck?: number;
    onPlayText?: string;
    onAttackEvolution?: boolean;
    onAttackText?: string;
  };
}

export interface CardInstance extends CardData {
  instanceId: string;
  tapped: boolean;
  faceUp: boolean;
  underCards: CardInstance[];
  kindanRole?: 'dokindam' | 'dormageddon';
  kindanAwakened?: boolean;
  kindanAwakenedImageUrl?: string;
  d2Switched?: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  deckId: string;
  kindanType?: KindanType;
  kindanFrontImageUrl?: string;
  kindanBackImageUrl?: string;
  deck: CardInstance[];
  hand: CardInstance[];
  mana: CardInstance[];
  shields: CardInstance[];
  battleZone: CardInstance[];
  graveyard: CardInstance[];
}

export interface GameRoom {
  roomId: string;
  status: 'waiting' | 'playing' | 'finished';
  turnPlayerId: string;
  turnCount: number;
  createdAt?: number;
  leftPlayers?: {
    [playerId: string]: boolean;
  };
  players: {
    [playerId: string]: PlayerState;
  };
  cutIn?: {
    id: string;
    type: 'summon' | 'ability' | 'attack' | 'evolution' | 'trigger';
    playerName: string;
    cardName: string;
    imageUrl?: string;
    subText?: string;
    timestamp: number;
  } | null;
  inspectingText?: string | null;
  publicReveal?: {
    playerName: string;
    cards: CardInstance[];
  } | null;
}