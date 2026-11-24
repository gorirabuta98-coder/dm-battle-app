export type Civilization = 'fire' | 'water' | 'nature' | 'light' | 'darkness' | 'zero';

export interface CardData {
  id: string;
  name: string;
  cost: number;
  civilization: Civilization[];
  type: 'creature' | 'spell' | 'evolution' | 'tamaseed' | 'field';
  power?: number;
  text: string;
  isShieldTrigger?: boolean;
  imageUrl?: string;
  // AI審判用の能力メタデータ（後続ステップでAIが自動付与）
  aiEffects?: {
    onPlayLookDeck?: number; // 登場時に山札の上から見る枚数（例: 4）
    onPlayText?: string; // 登場時効果の要約
    onAttackEvolution?: boolean; // 攻撃時に進化・チェンジ可能か
    onAttackText?: string; // 攻撃時効果の要約
  };
}

export interface CardInstance extends CardData {
  instanceId: string;
  tapped: boolean;
  faceUp: boolean;
  underCards: CardInstance[];
}

export interface PlayerState {
  id: string;
  name: string;
  deckId: string;
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
}