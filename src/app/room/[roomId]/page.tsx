'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchCustomDeckById } from '@/lib/supabaseDecks';
import { uploadCardImageToSupabase } from '@/lib/supabaseStorage';
import { CardData, CardInstance, GameRoom, KindanType, PlayerState } from '@/types/game';
import CutInOverlay, { CutInEvent } from '@/components/CutInOverlay';

type ZoneType = 'hand' | 'mana' | 'battleZone' | 'shields' | 'graveyard';
type EvolutionSourceZone = 'battleZone' | 'mana' | 'graveyard' | 'hand' | 'deck';
type SoundEventType =
  | 'turnEnd'
  | 'attack'
  | 'shieldBreak'
  | 'directAttack'
  | 'block'
  | 'revZeroTrigger'
  | 'summon'
  | 'spell'
  | 'kindanRelease';

type BattleCardInstance = CardInstance & {
  ignored?: boolean;
  shieldOverlaySlot?: string;
};

interface SelectedEvolutionMaterial {
  card: BattleCardInstance;
  sourceZone: EvolutionSourceZone;
}

interface PendingDirectAttack {
  id: string;
  attackerPlayerId: string;
  attackerPlayerName: string;
  defenderPlayerId: string;
  card: BattleCardInstance;
  timestamp: number;
}

type ExtendedRoom = GameRoom & {
  pendingDirectAttack?: PendingDirectAttack | null;
  soundEvent?: { id: string; type: SoundEventType; timestamp: number } | null;
  inspectingText?: string | null;
  cutIn?: CutInEvent | null;
  publicReveal?: {
    playerName: string;
    cards: BattleCardInstance[];
  } | null;
};

interface RoomUpdateMeta {
  sound?: SoundEventType;
  cutIn?: {
    type: CutInEvent['type'];
    playerName: string;
    card: BattleCardInstance;
    subText?: string;
  };
}

// public/sounds/ 内のMP3ファイル名マッピング（半角英数字・日本語の両方に自動対応）
const SOUND_FILE_CANDIDATES: Partial<Record<SoundEventType, string[]>> = {
  shieldBreak: ['/sounds/shield.mp3', '/sounds/ガラスが割れる1.mp3', '/sounds/ガラスが割れる1.mp3.mp3'],
  summon: ['/sounds/summon.mp3', '/sounds/シャキーン1.mp3', '/sounds/シャキーン1.mp3.mp3'],
  revZeroTrigger: ['/sounds/summon.mp3', '/sounds/シャキーン1.mp3', '/sounds/シャキーン1.mp3.mp3'],
  directAttack: ['/sounds/direct.mp3', '/sounds/爆発2.mp3', '/sounds/爆発2.mp3.mp3'],
  spell: ['/sounds/spell.mp3', '/sounds/魔法陣を展開.mp3', '/sounds/魔法陣を展開.mp3.mp3'],
  kindanRelease: ['/sounds/kindan.mp3', '/sounds/地響き.mp3', '/sounds/地響き.mp3.mp3'],
  attack: ['/sounds/attack.mp3', '/sounds/大パンチ.mp3', '/sounds/大パンチ.mp3.mp3'],
};

// 合成音フォールバック＆ターンエンド・ブロック音
function playSynthFallback(type: SoundEventType) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const now = ctx.currentTime;

    if (type === 'turnEnd') {
      const notes = [587.33, 880.0];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.11);

        gain.gain.setValueAtTime(0.001, now + idx * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.22, now + idx * 0.11 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.38);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.11);
        osc.stop(now + idx * 0.11 + 0.4);
      });
    } else if (type === 'block') {
      [320, 640, 1280].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = idx === 0 ? 'square' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.85, now + 0.35);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.4);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.27);
    }
  } catch (e) {
    console.warn('Synth sound skipped:', e);
  }
}

let lastGlobalSoundType: SoundEventType | null = null;
let lastGlobalSoundTime = 0;

// 効果音再生メイン関数（候補のMP3を順番に試して確実に再生・短時間の重複鳴りを防止）
function playGameSound(type: SoundEventType) {
  try {
    const nowMs = Date.now();
    if (lastGlobalSoundType === type && nowMs - lastGlobalSoundTime < 250) {
      return;
    }
    lastGlobalSoundType = type;
    lastGlobalSoundTime = nowMs;

    const candidates = SOUND_FILE_CANDIDATES[type];
    if (candidates && candidates.length > 0) {
      const tryPlay = (index: number) => {
        if (index >= candidates.length) {
          console.error(`音声ファイルが見つかりません (${type}):`, candidates);
          return;
        }
        const rawPath = candidates[index];
        const audio = new Audio(encodeURI(rawPath));
        audio.volume = 0.85;
        audio.play().catch(() => {
          tryPlay(index + 1);
        });
      };
      tryPlay(0);
      return;
    }
    playSynthFallback(type);
  } catch (e) {
    console.warn('Sound playback error:', e);
  }
}

function buildCutInEvent(
  type: CutInEvent['type'],
  playerName: string,
  card: BattleCardInstance,
  subText?: string
): CutInEvent {
  const displayImg =
    card.kindanRole && card.kindanAwakened && card.kindanAwakenedImageUrl
      ? card.kindanAwakenedImageUrl
      : card.imageUrl;
  return {
    id: `cutin-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    type,
    playerName,
    cardName: card.name,
    imageUrl: displayImg,
    subText,
    timestamp: Date.now(),
  };
}

function createDeckInstances(cards: CardData[]): BattleCardInstance[] {
  const instances: BattleCardInstance[] = cards.map((card, index) => ({
    ...card,
    instanceId: `${card.id}-${index}-${Math.random().toString(36).substring(2, 7)}`,
    tapped: false,
    faceUp: false,
    underCards: [],
    ignored: false,
    shieldOverlaySlot: undefined,
  }));
  for (let i = instances.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [instances[i], instances[j]] = [instances[j], instances[i]];
  }
  return instances;
}

function createKindanCard(
  kindanType: KindanType | undefined,
  seals: BattleCardInstance[],
  frontImageUrl?: string,
  backImageUrl?: string
): BattleCardInstance | null {
  if (kindanType === 'dokindam') {
    return {
      instanceId: `kindan-dokindam-${Math.random().toString(36).substring(2, 7)}`,
      id: 'kindan-dokindam-x',
      name: '禁断 ～封印されしX～ / 伝説の禁断 ドキンダムX',
      cost: 99,
      civilization: ['fire'],
      type: 'creature',
      power: 99999,
      text: '【禁断の鼓動】ゲーム開始時、封印を6つ付けてバトルゾーンに置く。コマンドを出した時、封印を1つ墓地に置く。封印がすべてなくなった時、裏返して「伝説の禁断 ドキンダムX」に禁断解放する。',
      imageUrl: frontImageUrl || '',
      kindanAwakenedImageUrl: backImageUrl || frontImageUrl || '',
      tapped: false,
      faceUp: true,
      underCards: seals,
      kindanRole: 'dokindam',
      kindanAwakened: false,
      ignored: false,
    };
  }
  if (kindanType === 'dormageddon') {
    return {
      instanceId: `kindan-dormageddon-${Math.random().toString(36).substring(2, 7)}`,
      id: 'kindan-dormageddon-x',
      name: 'FORBIDDEN STAR ～世界最後の日～ / 終焉の禁断 ドルマゲドンX',
      cost: 99,
      civilization: ['fire', 'darkness'],
      type: 'creature',
      power: 99999,
      text: '【禁断爆発】ゲーム開始時、封印を4つ付けてバトルゾーンに置く。封印がすべてなくなった時、裏返して「終焉の禁断 ドルマゲドンX」に禁断爆発する。',
      imageUrl: frontImageUrl || '',
      kindanAwakenedImageUrl: backImageUrl || frontImageUrl || '',
      tapped: false,
      faceUp: true,
      underCards: seals,
      kindanRole: 'dormageddon',
      kindanAwakened: false,
      ignored: false,
    };
  }
  return null;
}

async function fetchRoomState(targetRoomId: string): Promise<ExtendedRoom | null> {
  const { data, error } = await supabase
    .from('rooms')
    .select('state')
    .eq('room_id', targetRoomId)
    .maybeSingle();

  if (error) throw error;
  return (data?.state as ExtendedRoom | undefined) ?? null;
}

async function saveRoomState(targetRoomId: string, nextState: ExtendedRoom): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .upsert(
      {
        room_id: targetRoomId,
        state: nextState,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id' }
    );

  if (error) throw error;
}

async function deleteRoomRow(targetRoomId: string): Promise<void> {
  const { error } = await supabase.from('rooms').delete().eq('room_id', targetRoomId);
  if (error) throw error;
}

function BattleRoomContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = (params.roomId as string)?.trim();

  const [room, setRoom] = useState<ExtendedRoom | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string>('');
  const [spectatorShowHands, setSpectatorShowHands] = useState<boolean>(true);
  const [isEvolvingBusy, setIsEvolvingBusy] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [directAttackModalOpen, setDirectAttackModalOpen] = useState<boolean>(false);
  const [defenseSubMode, setDefenseSubMode] = useState<'main' | 'revZero' | 'blocker'>('main');

  const roomRef = useRef<ExtendedRoom | null>(null);
  const prevTurnCountRef = useRef<number | null>(null);
  const prevTurnPlayerRef = useRef<string | null>(null);
  const prevSoundEventIdRef = useRef<string | null>(null);
  const prevCutInIdRef = useRef<string | null>(null);
  const prevPendingDirectIdRef = useRef<string | null>(null);
  const soundEnabledRef = useRef<boolean>(true);
  const notFoundAlertedRef = useRef<boolean>(false);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const [selectedCard, setSelectedCard] = useState<{
    card: BattleCardInstance;
    zone: ZoneType;
    shieldSlotIndex?: number;
  } | null>(null);

  const [inspectCard, setInspectCard] = useState<{
    card: BattleCardInstance;
    ownerName: string;
    sourceZone?: ZoneType;
    isOpponentCard?: boolean;
  } | null>(null);

  const [brokenShieldCard, setBrokenShieldCard] = useState<{
    card: BattleCardInstance;
    slotLabel?: string;
  } | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [deckSearchOpen, setDeckSearchOpen] = useState(false);
  const [graveSearchOpen, setGraveSearchOpen] = useState(false);
  const [oppGraveViewOpen, setOppGraveViewOpen] = useState(false);
  const [peekCount, setPeekCount] = useState<number>(4);

  const [peekState, setPeekState] = useState<{
    cards: BattleCardInstance[];
    isPublic: boolean;
  } | null>(null);

  const [evolutionBuilder, setEvolutionBuilder] = useState<{
    evolvingCard: BattleCardInstance;
    fromZone: 'hand' | 'mana' | 'graveyard';
    activeTab: EvolutionSourceZone;
    selectedMaterials: SelectedEvolutionMaterial[];
  } | null>(null);

  const [revolutionChangePending, setRevolutionChangePending] = useState<{
    card: BattleCardInstance;
    fromZone: 'hand' | 'mana' | 'graveyard';
  } | null>(null);

  const [resetting, setResetting] = useState(false);

  // 1回の操作につき1回だけDB保存し、効果音とカットインも同一更新内で発火させる
  const applyRoomUpdate = useCallback(
    async (updater: (current: ExtendedRoom) => ExtendedRoom, meta?: RoomUpdateMeta) => {
      if (!roomId) return;
      const latest = (await fetchRoomState(roomId)) ?? roomRef.current;
      if (!latest) return;

      const now = Date.now();
      const baseNext = updater(latest);
      const soundEvent = meta?.sound
        ? {
            id: `se-${meta.sound}-${now}-${Math.random().toString(36).substring(2, 6)}`,
            type: meta.sound,
            timestamp: now,
          }
        : baseNext.soundEvent;

      const cutIn = meta?.cutIn
        ? {
            ...buildCutInEvent(
              meta.cutIn.type,
              meta.cutIn.playerName,
              meta.cutIn.card,
              meta.cutIn.subText
            ),
            timestamp: now,
          }
        : baseNext.cutIn;

      const next: ExtendedRoom = {
        ...baseNext,
        soundEvent,
        cutIn,
      };

      if (meta?.sound && soundEnabledRef.current) {
        if (soundEvent?.id) {
          prevSoundEventIdRef.current = soundEvent.id;
        }
        playGameSound(meta.sound);
      } else if (next.soundEvent?.id) {
        prevSoundEventIdRef.current = next.soundEvent.id;
      }

      if (cutIn?.id) {
        prevCutInIdRef.current = cutIn.id;
      }

      roomRef.current = next;
      setRoom(next);
      await saveRoomState(roomId, next);
    },
    [roomId]
  );

  const setInspectingStatus = async (text: string | null) => {
    if (!roomId) return;
    await applyRoomUpdate((cur) => ({
      ...cur,
      inspectingText: text,
    }));
  };

  useEffect(() => {
    const savedId = localStorage.getItem('dm_player_id') || '';
    setMyPlayerId(savedId);

    if (!roomId) return;

    const handleIncomingRoom = (data: ExtendedRoom | null) => {
      if (!data) {
        if (!notFoundAlertedRef.current) {
          notFoundAlertedRef.current = true;
          alert('部屋が見つかりません');
          router.push('/');
        }
        return;
      }

      if (
        prevTurnCountRef.current !== null &&
        prevTurnPlayerRef.current !== null &&
        (data.turnCount > prevTurnCountRef.current ||
          data.turnPlayerId !== prevTurnPlayerRef.current)
      ) {
        if (soundEnabledRef.current) {
          playGameSound('turnEnd');
        }
      }
      prevTurnCountRef.current = data.turnCount;
      prevTurnPlayerRef.current = data.turnPlayerId;

      const se = data.soundEvent;
      if (se && se.id && se.id !== prevSoundEventIdRef.current) {
        const isInitialLoad = prevSoundEventIdRef.current === null;
        prevSoundEventIdRef.current = se.id;
        if (!isInitialLoad || Date.now() - se.timestamp < 3000) {
          if (soundEnabledRef.current) {
            playGameSound(se.type);
          }
        }
      } else if (!se && prevSoundEventIdRef.current === null) {
        prevSoundEventIdRef.current = 'init';
      }

      if (data.cutIn?.id) {
        prevCutInIdRef.current = data.cutIn.id;
      }

      const pda = data.pendingDirectAttack;
      if (pda && pda.id !== prevPendingDirectIdRef.current) {
        prevPendingDirectIdRef.current = pda.id;
        setDefenseSubMode('main');
      } else if (!pda) {
        prevPendingDirectIdRef.current = null;
      }

      roomRef.current = data;
      setRoom(data);
    };

    fetchRoomState(roomId)
      .then(handleIncomingRoom)
      .catch((err) => {
        console.error('ルーム読み込みエラー:', err);
        if (!notFoundAlertedRef.current) {
          notFoundAlertedRef.current = true;
          alert('部屋が見つかりません');
          router.push('/');
        }
      });

    const channel = supabase
      .channel(`room-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rooms',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            handleIncomingRoom(null);
            return;
          }
          const nextState = (payload.new as { state?: ExtendedRoom } | undefined)?.state ?? null;
          handleIncomingRoom(nextState);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, router]);

  if (!room) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        読み込み中...
      </div>
    );
  }

  const playersObj = room.players || {};
  const playerIds = Object.keys(playersObj);
  const isParticipant = !!myPlayerId && playerIds.includes(myPlayerId);
  const isSpectator = !isParticipant || searchParams.get('spectate') === '1';

  const bottomPlayerId = isParticipant ? myPlayerId : playerIds[1] || playerIds[0];
  const topPlayerId = isParticipant
    ? playerIds.find((id) => id !== myPlayerId)
    : playerIds[0] !== bottomPlayerId
    ? playerIds[0]
    : undefined;

  const me: PlayerState | undefined = bottomPlayerId ? playersObj[bottomPlayerId] : undefined;
  const opponent: PlayerState | undefined = topPlayerId ? playersObj[topPlayerId] : undefined;
  const isMyTurn = !isSpectator && room.turnPlayerId === myPlayerId;

  const pendingDirectAttack = room.pendingDirectAttack || null;
  const amIDefendingDirectAttack =
    !isSpectator &&
    !!pendingDirectAttack &&
    pendingDirectAttack.defenderPlayerId === myPlayerId;
  const amIWaitingDirectAttack =
    !isSpectator &&
    !!pendingDirectAttack &&
    pendingDirectAttack.attackerPlayerId === myPlayerId;

  const updateMyState = async (
    newState: Partial<PlayerState>,
    recordUndo = true,
    meta?: RoomUpdateMeta
  ) => {
    if (!me || isSpectator || !myPlayerId) return;

    if (recordUndo) {
      const snapshot = JSON.stringify({
        deck: me.deck || [],
        hand: me.hand || [],
        mana: me.mana || [],
        shields: me.shields || [],
        battleZone: me.battleZone || [],
        graveyard: me.graveyard || [],
      });
      setUndoStack((prev) => [...prev.slice(-19), snapshot]);
    }

    await applyRoomUpdate((cur) => {
      const curPlayers = cur.players || {};
      const curMe = curPlayers[myPlayerId] || me;
      return {
        ...cur,
        players: {
          ...curPlayers,
          [myPlayerId]: {
            ...curMe,
            ...newState,
          },
        },
      };
    }, meta);
  };

  const handleToggleMyIgnore = async (targetCard: BattleCardInstance) => {
    if (!me || isSpectator) return;
    const nextIgnored = !targetCard.ignored;
    const updatedBZ = ((me.battleZone || []) as BattleCardInstance[]).map((c) =>
      c.instanceId === targetCard.instanceId ? { ...c, ignored: nextIgnored } : c
    );
    await updateMyState({ battleZone: updatedBZ });
    setSelectedCard(null);
  };

  const handleToggleOpponentIgnore = async (targetCard: BattleCardInstance) => {
    if (!opponent || !topPlayerId || isSpectator) return;
    const nextIgnored = !targetCard.ignored;
    const updatedOppBZ = ((opponent.battleZone || []) as BattleCardInstance[]).map((c) =>
      c.instanceId === targetCard.instanceId ? { ...c, ignored: nextIgnored } : c
    );
    await applyRoomUpdate((cur) => {
      const curPlayers = cur.players || {};
      const curOpp = curPlayers[topPlayerId] || opponent;
      return {
        ...cur,
        players: {
          ...curPlayers,
          [topPlayerId]: {
            ...curOpp,
            battleZone: updatedOppBZ,
          },
        },
      };
    });
    setInspectCard(null);
  };

  // 【禁断専用】封印を1枚外す／乗せる／禁断解放（地響き.mp3再生！）／表裏画像アップロード
  const handleRemoveOneSeal = async (kindanCard: BattleCardInstance) => {
    if (!me || isSpectator) return;
    const seals = kindanCard.underCards || [];
    if (seals.length === 0) return alert('外せる封印がもうありません');

    const removedSeal: BattleCardInstance = {
      ...seals[seals.length - 1],
      faceUp: true,
      tapped: false,
      underCards: [],
      ignored: false,
    };
    const remainingSeals = seals.slice(0, -1);

    const updatedKindan: BattleCardInstance = {
      ...kindanCard,
      underCards: remainingSeals,
    };

    const nextBZ = (me.battleZone || []).map((c) =>
      c.instanceId === kindanCard.instanceId ? updatedKindan : c
    );
    const nextGrave = [...(me.graveyard || []), removedSeal];

    await updateMyState({
      battleZone: nextBZ,
      graveyard: nextGrave,
    });

    setSelectedCard({ card: updatedKindan, zone: 'battleZone' });
  };

  const handleAddOneSealFromDeck = async (kindanCard: BattleCardInstance) => {
    if (!me || isSpectator) return;
    if ((me.deck || []).length === 0) return alert('山札がありません');

    const nextDeck = [...(me.deck || [])];
    const newSeal: BattleCardInstance = {
      ...nextDeck.shift()!,
      faceUp: false,
      tapped: false,
      underCards: [],
      ignored: false,
    };

    const updatedKindan: BattleCardInstance = {
      ...kindanCard,
      underCards: [...(kindanCard.underCards || []), newSeal],
    };

    const nextBZ = (me.battleZone || []).map((c) =>
      c.instanceId === kindanCard.instanceId ? updatedKindan : c
    );

    await updateMyState({
      deck: nextDeck,
      battleZone: nextBZ,
    });

    setSelectedCard({ card: updatedKindan, zone: 'battleZone' });
  };

  const handleToggleKindanAwaken = async (kindanCard: BattleCardInstance) => {
    if (!me || isSpectator) return;
    const nextAwakened = !kindanCard.kindanAwakened;
    const awakenedName =
      kindanCard.kindanRole === 'dokindam'
        ? nextAwakened
          ? '伝説の禁断 ドキンダムX（禁断解放！）'
          : '禁断 ～封印されしX～'
        : nextAwakened
        ? '終焉の禁断 ドルマゲドンX（禁断爆発！）'
        : 'FORBIDDEN STAR ～世界最後の日～';

    const updatedKindan: BattleCardInstance = {
      ...kindanCard,
      name: awakenedName,
      kindanAwakened: nextAwakened,
    };

    const nextBZ = (me.battleZone || []).map((c) =>
      c.instanceId === kindanCard.instanceId ? updatedKindan : c
    );

    setSelectedCard(null);
    await updateMyState(
      { battleZone: nextBZ },
      true,
      nextAwakened
        ? {
            sound: 'kindanRelease',
            cutIn: {
              type: 'evolution',
              playerName: me.name,
              card: updatedKindan,
              subText:
                kindanCard.kindanRole === 'dokindam'
                  ? '🔥 封印解除！禁断解放！！'
                  : '💀 終焉の禁断爆発！！',
            },
          }
        : undefined
    );
  };

  const handleUploadKindanImageInRoom = async (
    kindanCard: BattleCardInstance,
    side: 'front' | 'back',
    file?: File
  ) => {
    if (!me || isSpectator || !file) return;
    try {
      const publicUrl = await uploadCardImageToSupabase(file, 'kindan', 960);
      const updatedKindan: BattleCardInstance = {
        ...kindanCard,
        ...(side === 'front'
          ? { imageUrl: publicUrl }
          : { kindanAwakenedImageUrl: publicUrl, kindanAwakened: true }),
      };
      const nextBZ = (me.battleZone || []).map((c) =>
        c.instanceId === kindanCard.instanceId ? updatedKindan : c
      );

      await updateMyState({
        battleZone: nextBZ,
        ...(side === 'front'
          ? { kindanFrontImageUrl: publicUrl }
          : { kindanBackImageUrl: publicUrl }),
      });

      const sharedKey =
        kindanCard.kindanRole === 'dokindam'
          ? side === 'front'
            ? 'dokindamFront'
            : 'dokindamBack'
          : side === 'front'
          ? 'dormageddonFront'
          : 'dormageddonBack';
      await supabase.from('shared_kindan_images').upsert(
        {
          key: sharedKey,
          image_url: publicUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' }
      );

      setSelectedCard({ card: updatedKindan, zone: 'battleZone' });
    } catch (e) {
      console.error(e);
      alert('画像のアップロードに失敗しました');
    }
  };

  const handleSendOpponentCardToFaceUpShield = async (
    targetCard: BattleCardInstance,
    sourceZone: ZoneType
  ) => {
    if (!opponent || !topPlayerId || isSpectator) return;

    const removeFrom = (list: BattleCardInstance[]) =>
      list.filter((c) => c.instanceId !== targetCard.instanceId);

    let nextOppBZ = [...((opponent.battleZone || []) as BattleCardInstance[])];
    let nextOppMana = [...((opponent.mana || []) as BattleCardInstance[])];
    let nextOppGrave = [...((opponent.graveyard || []) as BattleCardInstance[])];
    let nextOppShields = [...((opponent.shields || []) as BattleCardInstance[])];

    if (sourceZone === 'battleZone') nextOppBZ = removeFrom(nextOppBZ);
    if (sourceZone === 'mana') nextOppMana = removeFrom(nextOppMana);
    if (sourceZone === 'graveyard') nextOppGrave = removeFrom(nextOppGrave);
    if (sourceZone === 'shields') nextOppShields = removeFrom(nextOppShields);

    if (targetCard.underCards && targetCard.underCards.length > 0) {
      const freedUnder = targetCard.underCards.map((u) => ({
        ...u,
        tapped: false,
        faceUp: true,
        underCards: [],
        ignored: false,
      }));
      nextOppGrave.push(...freedUnder);
    }

    const faceUpShieldCard: BattleCardInstance = {
      ...targetCard,
      tapped: false,
      faceUp: true,
      underCards: [],
      ignored: false,
    };
    nextOppShields.push(faceUpShieldCard);

    setInspectCard(null);
    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curOpp = curPlayers[topPlayerId] || opponent;
        return {
          ...cur,
          players: {
            ...curPlayers,
            [topPlayerId]: {
              ...curOpp,
              battleZone: nextOppBZ,
              mana: nextOppMana,
              graveyard: nextOppGrave,
              shields: nextOppShields,
            },
          },
        };
      },
      {
        cutIn: {
          type: 'ability',
          playerName: me?.name || 'プレイヤー',
          card: faceUpShieldCard,
          subText: `${opponent.name} の新しいシールドとして表向きで追加！`,
        },
      }
    );
  };

  const handleUndo = async () => {
    if (isSpectator || undoStack.length === 0 || !me || !myPlayerId) return;
    const lastSnapshotStr = undoStack[undoStack.length - 1];
    const restored = JSON.parse(lastSnapshotStr);
    setUndoStack((prev) => prev.slice(0, -1));
    setPeekState(null);
    setSelectedCard(null);
    setBrokenShieldCard(null);
    setEvolutionBuilder(null);
    await applyRoomUpdate((cur) => {
      const curPlayers = cur.players || {};
      const curMe = curPlayers[myPlayerId] || me;
      return {
        ...cur,
        inspectingText: null,
        publicReveal: null,
        pendingDirectAttack: null,
        players: {
          ...curPlayers,
          [myPlayerId]: {
            ...curMe,
            ...restored,
          },
        },
      };
    });
  };

  const handleResetMatch = async () => {
    if (isSpectator) return;
    if (
      !confirm(
        '現在の試合を強制終了し、両プレイヤーの山札をシャッフルして最初から（シールド5枚・手札5枚・禁断封印）やり直しますか？'
      )
    ) {
      return;
    }

    setResetting(true);
    try {
      const updatedPlayers: Record<string, PlayerState> = {};
      const { data: sharedRows } = await supabase
        .from('shared_kindan_images')
        .select('key, image_url');
      const sharedImgs: Record<string, string> = {};
      (sharedRows || []).forEach((r) => {
        if (r.key && r.image_url) sharedImgs[r.key] = r.image_url;
      });

      for (const pid of playerIds) {
        const p = playersObj[pid];
        let baseCards: CardData[] = [];

        if (p.deckId) {
          const deckRecord = await fetchCustomDeckById(p.deckId);
          if (deckRecord) {
            baseCards = (deckRecord.cards || []) as CardData[];
          }
        }

        if (baseCards.length === 0) {
          const collected: CardInstance[] = [
            ...(p.deck || []),
            ...(p.hand || []),
            ...(p.mana || []),
            ...(p.shields || []),
            ...(p.graveyard || []),
          ];
          (p.battleZone || []).forEach((bz) => {
            if (!bz.kindanRole) {
              collected.push(bz);
            }
            if (bz.underCards) collected.push(...bz.underCards);
          });
          baseCards = collected;
        }

        const shuffled = createDeckInstances(baseCards);
        const shields = shuffled.slice(0, 5).map((c) => ({ ...c, faceUp: false }));
        const hand = shuffled.slice(5, 10).map((c) => ({ ...c, faceUp: true }));

        const kType: KindanType = p.kindanType || 'none';
        const sealCount = kType === 'dokindam' ? 6 : kType === 'dormageddon' ? 4 : 0;
        const seals = shuffled
          .slice(10, 10 + sealCount)
          .map((c) => ({ ...c, faceUp: false, tapped: false }));
        const deck = shuffled.slice(10 + sealCount);

        const existingKindan = (p.battleZone || []).find((c) => c.kindanRole);
        const frontImg =
          p.kindanFrontImageUrl ||
          existingKindan?.imageUrl ||
          (kType === 'dokindam' ? sharedImgs.dokindamFront : sharedImgs.dormageddonFront) ||
          '';
        const backImg =
          p.kindanBackImageUrl ||
          existingKindan?.kindanAwakenedImageUrl ||
          (kType === 'dokindam' ? sharedImgs.dokindamBack : sharedImgs.dormageddonBack) ||
          '';

        const initialBZ: BattleCardInstance[] = [];
        const kindanCard = createKindanCard(kType, seals, frontImg, backImg);
        if (kindanCard) {
          initialBZ.push(kindanCard);
        }

        updatedPlayers[pid] = {
          ...p,
          deck,
          hand,
          mana: [],
          shields,
          battleZone: initialBZ,
          graveyard: [],
        };
      }

      const firstPlayerId = playerIds[0] || myPlayerId;
      await applyRoomUpdate((cur) => ({
        ...cur,
        players: updatedPlayers,
        turnPlayerId: firstPlayerId,
        turnCount: 1,
        inspectingText: null,
        cutIn: null,
        publicReveal: null,
        pendingDirectAttack: null,
      }));

      setUndoStack([]);
      setPeekState(null);
      setSelectedCard(null);
      setBrokenShieldCard(null);
      setEvolutionBuilder(null);
    } catch (error) {
      console.error(error);
      alert('試合のリセットに失敗しました');
    } finally {
      setResetting(false);
    }
  };

  const deck = (me?.deck || []) as BattleCardInstance[];
  const hand = (me?.hand || []) as BattleCardInstance[];
  const mana = (me?.mana || []) as BattleCardInstance[];
  const shields = (me?.shields || []) as BattleCardInstance[];
  const battleZone = (me?.battleZone || []) as BattleCardInstance[];
  const graveyard = (me?.graveyard || []) as BattleCardInstance[];

  const oppDeck = (opponent?.deck || []) as BattleCardInstance[];
  const oppHand = (opponent?.hand || []) as BattleCardInstance[];
  const oppMana = (opponent?.mana || []) as BattleCardInstance[];
  const oppShields = (opponent?.shields || []) as BattleCardInstance[];
  const oppBattleZone = (opponent?.battleZone || []) as BattleCardInstance[];
  const oppGraveyard = (opponent?.graveyard || []) as BattleCardInstance[];

  const normalBattleZone = battleZone.filter((c) => !c.kindanRole);
  const kindanBattleZone = battleZone.find((c) => c.kindanRole);

  const oppNormalBattleZone = oppBattleZone.filter((c) => !c.kindanRole);
  const oppKindanBattleZone = oppBattleZone.find((c) => c.kindanRole);

  const handleTopDeckTo = async (dest: 'hand' | 'mana' | 'graveyard' | 'shields') => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const newDeck = [...deck];
    const topCard = newDeck.shift()!;
    const updatedCard: BattleCardInstance = {
      ...topCard,
      tapped: false,
      faceUp: dest !== 'shields',
      ignored: false,
      shieldOverlaySlot: undefined,
    };

    if (dest === 'hand') {
      await updateMyState({ deck: newDeck, hand: [...hand, updatedCard] });
    } else if (dest === 'mana') {
      await updateMyState({ deck: newDeck, mana: [...mana, updatedCard] });
    } else if (dest === 'graveyard') {
      await updateMyState({ deck: newDeck, graveyard: [...graveyard, updatedCard] });
    } else if (dest === 'shields') {
      await updateMyState({ deck: newDeck, shields: [...shields, updatedCard] });
    }
  };

  const handleShuffle = async () => {
    if (!me || isSpectator || deck.length <= 1) return;
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await updateMyState({ deck: shuffled });
    alert('山札をシャッフルしました');
  };

  const handleTurnStart = async () => {
    if (!me || isSpectator) return;
    const untappedMana = mana.map((c) => ({ ...c, tapped: false }));
    const untappedBZ = battleZone.map((c) => ({ ...c, tapped: false, ignored: false }));
    const newDeck = [...deck];
    const newHand = [...hand];
    if (newDeck.length > 0) {
      const drawn = newDeck.shift()!;
      drawn.faceUp = true;
      newHand.push(drawn);
    }
    await updateMyState({
      mana: untappedMana,
      battleZone: untappedBZ,
      deck: newDeck,
      hand: newHand,
    });
  };

  const handleTurnEnd = async () => {
    if (isSpectator) return;
    if (!topPlayerId) return alert('対戦相手がまだいません');
    await applyRoomUpdate((cur) => ({
      ...cur,
      turnPlayerId: topPlayerId,
      turnCount: (cur.turnCount || 1) + 1,
      pendingDirectAttack: null,
    }));
  };

  const handlePeekTopDeck = async (count: number, isPublic: boolean) => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const actualCount = Math.min(count, deck.length);
    const newDeck = [...deck];
    const revealed = newDeck.splice(0, actualCount).map((c) => ({ ...c, faceUp: true }));

    await updateMyState({ deck: newDeck });

    if (isPublic) {
      await applyRoomUpdate((cur) => ({
        ...cur,
        inspectingText: `${me.name} が山札の上から ${actualCount} 枚を公開中！`,
        publicReveal: {
          playerName: me.name,
          cards: revealed,
        },
      }));
    } else {
      await setInspectingStatus(`${me.name} が山札の上から ${actualCount} 枚を非公開で確認中...`);
    }

    setPeekState({ cards: revealed, isPublic });
  };

  const handleMoveFromPeek = async (
    picked: BattleCardInstance,
    dest: 'hand' | 'battleZone' | 'mana' | 'graveyard'
  ) => {
    if (!peekState || !me || isSpectator) return;
    const remaining = peekState.cards.filter((c) => c.instanceId !== picked.instanceId);
    const updatedCard: BattleCardInstance = {
      ...picked,
      faceUp: true,
      tapped: false,
      ignored: false,
      shieldOverlaySlot: undefined,
    };

    if (dest === 'hand') {
      await updateMyState({ hand: [...hand, updatedCard] });
    } else if (dest === 'battleZone') {
      const cleanBZ = battleZone.filter((c) => c.instanceId !== updatedCard.instanceId);
      await updateMyState(
        { battleZone: [...cleanBZ, updatedCard] },
        true,
        {
          sound: 'summon',
          cutIn: {
            type: 'summon',
            playerName: me.name,
            card: updatedCard,
            subText: '山札からバトルゾーンへ！',
          },
        }
      );
    } else if (dest === 'mana') {
      await updateMyState({ mana: [...mana, updatedCard] });
    } else if (dest === 'graveyard') {
      await updateMyState({ graveyard: [...graveyard, updatedCard] });
    }

    if (remaining.length === 0) {
      setPeekState(null);
      await applyRoomUpdate((cur) => ({
        ...cur,
        inspectingText: null,
        publicReveal: null,
      }));
    } else {
      setPeekState({ ...peekState, cards: remaining });
      if (peekState.isPublic) {
        await applyRoomUpdate((cur) => ({
          ...cur,
          publicReveal: {
            playerName: me.name,
            cards: remaining,
          },
        }));
      }
    }
  };

  const handleFinishPeek = async (destination: 'bottom' | 'top' | 'graveyard') => {
    if (!peekState || isSpectator) return;
    if (destination === 'bottom') {
      const hidden = peekState.cards.map((c) => ({ ...c, faceUp: false }));
      await updateMyState({ deck: [...deck, ...hidden] }, false);
    } else if (destination === 'top') {
      const hidden = peekState.cards.map((c) => ({ ...c, faceUp: false }));
      await updateMyState({ deck: [...hidden, ...deck] }, false);
    } else {
      const toGrave = peekState.cards.map((c) => ({ ...c, faceUp: true, tapped: false }));
      await updateMyState({ graveyard: [...graveyard, ...toGrave] }, false);
    }
    setPeekState(null);
    await applyRoomUpdate((cur) => ({
      ...cur,
      inspectingText: null,
      publicReveal: null,
    }));
  };

  const moveCard = async (
    card: BattleCardInstance,
    fromZone: ZoneType,
    toZone: ZoneType | 'shieldsFaceUp' | 'deckTop' | 'deckBottom',
    skipSound = false,
    shieldOverlaySlot?: string,
    overrideCutIn?: RoomUpdateMeta['cutIn']
  ) => {
    if (!me || isSpectator) return;

    const removeFrom = (list: BattleCardInstance[]) =>
      list.filter((c) => c.instanceId !== card.instanceId);

    const nextDeck = [...deck];
    let nextHand = [...hand];
    let nextMana = [...mana];
    let nextShields = [...shields];
    let nextBZ = [...battleZone];
    let nextGrave = [...graveyard];

    // バトルゾーンから墓地へ送る際、進化元（underCards）があれば一番上の進化元を場に残し、進化カードのみを墓地へ送る
    const isTopEvolutionToGraveyard =
      fromZone === 'battleZone' &&
      toZone === 'graveyard' &&
      !card.kindanRole &&
      !!card.underCards &&
      card.underCards.length > 0;

    if (isTopEvolutionToGraveyard) {
      const underList = card.underCards!;
      const topUnder = underList[underList.length - 1];
      const remainingUnder = underList.slice(0, -1).map((u) => ({
        ...u,
        tapped: false,
        faceUp: true,
        underCards: [],
        ignored: false,
      }));
      const promotedUnderCard: BattleCardInstance = {
        ...topUnder,
        tapped: card.tapped,
        faceUp: true,
        underCards: remainingUnder,
        ignored: false,
        shieldOverlaySlot: undefined,
      };
      nextBZ = nextBZ.map((c) =>
        c.instanceId === card.instanceId ? promotedUnderCard : c
      );
    } else {
      if (fromZone === 'hand') nextHand = removeFrom(nextHand);
      if (fromZone === 'mana') nextMana = removeFrom(nextMana);
      if (fromZone === 'battleZone') nextBZ = removeFrom(nextBZ);
      if (fromZone === 'shields') nextShields = removeFrom(nextShields);
      if (fromZone === 'graveyard') nextGrave = removeFrom(nextGrave);
    }

    const isFaceUpDest =
      toZone !== 'shields' && toZone !== 'deckTop' && toZone !== 'deckBottom';

    const cleanCard: BattleCardInstance = {
      ...card,
      tapped: false,
      faceUp: isFaceUpDest,
      underCards:
        isTopEvolutionToGraveyard
          ? []
          : toZone === 'battleZone'
          ? card.underCards || []
          : [],
      ignored: false,
      shieldOverlaySlot: toZone === 'shieldsFaceUp' ? shieldOverlaySlot : undefined,
    };

    if (toZone === 'hand') nextHand.push(cleanCard);
    if (toZone === 'mana') nextMana.push(cleanCard);
    if (toZone === 'battleZone') {
      nextBZ = removeFrom(nextBZ);
      nextBZ.push(cleanCard);
    }
    if (toZone === 'shields' || toZone === 'shieldsFaceUp') nextShields.push(cleanCard);
    if (toZone === 'graveyard') nextGrave.push(cleanCard);
    if (toZone === 'deckTop') nextDeck.unshift(cleanCard);
    if (toZone === 'deckBottom') nextDeck.push(cleanCard);

    const originLabel =
      fromZone === 'mana'
        ? 'マナゾーンから登場！'
        : fromZone === 'graveyard'
        ? '墓地から登場！'
        : 'バトルゾーンに登場！';

    const meta: RoomUpdateMeta | undefined =
      toZone === 'battleZone'
        ? {
            sound: skipSound ? undefined : 'summon',
            cutIn: overrideCutIn ?? {
              type: 'summon',
              playerName: me.name,
              card: cleanCard,
              subText: originLabel,
            },
          }
        : toZone === 'shieldsFaceUp'
        ? {
            cutIn: overrideCutIn ?? {
              type: 'ability',
              playerName: me.name,
              card: cleanCard,
              subText: shieldOverlaySlot
                ? `${shieldOverlaySlot} に表向きシールドとして配置！`
                : '新しいシールドとして表向きで配置！',
            },
          }
        : overrideCutIn
        ? { cutIn: overrideCutIn }
        : undefined;

    setSelectedCard(null);
    await updateMyState(
      {
        deck: nextDeck,
        hand: nextHand,
        mana: nextMana,
        shields: nextShields,
        battleZone: nextBZ,
        graveyard: nextGrave,
      },
      true,
      meta
    );
  };

  const toggleTap = async (card: BattleCardInstance, zone: 'mana' | 'battleZone') => {
    if (!me || isSpectator) return;
    const list = zone === 'mana' ? mana : battleZone;
    const updated = list.map((c) =>
      c.instanceId === card.instanceId ? { ...c, tapped: !c.tapped } : c
    );
    await updateMyState({ [zone]: updated });
    setSelectedCard(null);
  };

  // シンプルな攻撃宣言（大パンチ.mp3）
  const handleAttackDeclare = async (attacker: BattleCardInstance) => {
    if (!me || isSpectator) return;
    const updatedBZ = battleZone.map((c) =>
      c.instanceId === attacker.instanceId ? { ...c, tapped: true } : c
    );
    setSelectedCard(null);
    await updateMyState(
      { battleZone: updatedBZ },
      true,
      {
        sound: 'attack',
        cutIn: {
          type: 'attack',
          playerName: me.name,
          card: attacker,
          subText: 'クリーチャーで攻撃宣言！',
        },
      }
    );
  };

  // ダイレクトアタック宣言（大パンチ.mp3 → 相手が敗北承認で 爆発2.mp3）
  const handleDeclareDirectAttack = async (attacker: BattleCardInstance) => {
    if (!me || isSpectator) return;
    if (!topPlayerId) return alert('対戦相手がまだいません');

    const updatedBZ = battleZone.map((c) =>
      c.instanceId === attacker.instanceId ? { ...c, tapped: true } : c
    );
    const snapshot = JSON.stringify({
      deck: me.deck || [],
      hand: me.hand || [],
      mana: me.mana || [],
      shields: me.shields || [],
      battleZone: me.battleZone || [],
      graveyard: me.graveyard || [],
    });
    setUndoStack((prev) => [...prev.slice(-19), snapshot]);
    setDirectAttackModalOpen(false);
    setSelectedCard(null);

    const pendingPayload: PendingDirectAttack = {
      id: `da-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      attackerPlayerId: myPlayerId,
      attackerPlayerName: me.name,
      defenderPlayerId: topPlayerId,
      card: attacker,
      timestamp: Date.now(),
    };

    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          pendingDirectAttack: pendingPayload,
          players: {
            ...curPlayers,
            [myPlayerId]: {
              ...curMe,
              battleZone: updatedBZ,
            },
          },
        };
      },
      {
        sound: 'attack',
        cutIn: {
          type: 'attack',
          playerName: me.name,
          card: attacker,
          subText: '⚠️ ダイレクトアタック宣言！！相手の対応待ち...',
        },
      }
    );
  };

  // 相手が「敗北を認める」を押した時（爆発2.mp3）
  const handleAcceptDefeat = async () => {
    if (!pendingDirectAttack || !me) return;
    const { attackerPlayerName, card } = pendingDirectAttack;

    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        pendingDirectAttack: null,
      }),
      {
        sound: 'directAttack',
        cutIn: {
          type: 'attack',
          playerName: attackerPlayerName,
          card,
          subText: `🏆 決着！！${me.name} が敗北を認めた！（${attackerPlayerName} の勝利！）`,
        },
      }
    );
  };

  // 革命0トリガー発動（キャラ出し＝シャキーン1.mp3 / 呪文詠唱＝魔法陣を展開.mp3）
  const handleActivateRevZeroTrigger = async (
    card: BattleCardInstance,
    dest: 'battleZone' | 'graveyard'
  ) => {
    if (!me || !pendingDirectAttack || !myPlayerId) return;

    const nextHand = hand.filter((c) => c.instanceId !== card.instanceId);
    const cleanCard: BattleCardInstance = {
      ...card,
      tapped: false,
      faceUp: true,
      underCards: [],
      ignored: false,
      shieldOverlaySlot: undefined,
    };

    const nextPlayerPartial: Partial<PlayerState> =
      dest === 'battleZone'
        ? {
            hand: nextHand,
            battleZone: [
              ...battleZone.filter((c) => c.instanceId !== cleanCard.instanceId),
              cleanCard,
            ],
          }
        : {
            hand: nextHand,
            graveyard: [...graveyard, cleanCard],
          };

    const snapshot = JSON.stringify({
      deck: me.deck || [],
      hand: me.hand || [],
      mana: me.mana || [],
      shields: me.shields || [],
      battleZone: me.battleZone || [],
      graveyard: me.graveyard || [],
    });
    setUndoStack((prev) => [...prev.slice(-19), snapshot]);

    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          pendingDirectAttack: null,
          players: {
            ...curPlayers,
            [myPlayerId]: {
              ...curMe,
              ...nextPlayerPartial,
            },
          },
        };
      },
      {
        sound: dest === 'battleZone' ? 'revZeroTrigger' : 'spell',
        cutIn: {
          type: 'trigger',
          playerName: me.name,
          card: cleanCard,
          subText:
            dest === 'battleZone'
              ? '🔥 革命0トリガー発動！！バトルゾーンへ降臨！'
              : '🔥 革命0トリガー呪文発動！！',
        },
      }
    );
  };

  const handleBlockDirectAttack = async (blocker: BattleCardInstance) => {
    if (!me || !pendingDirectAttack || !myPlayerId) return;

    const updatedBZ = battleZone.map((c) =>
      c.instanceId === blocker.instanceId ? { ...c, tapped: true } : c
    );
    const snapshot = JSON.stringify({
      deck: me.deck || [],
      hand: me.hand || [],
      mana: me.mana || [],
      shields: me.shields || [],
      battleZone: me.battleZone || [],
      graveyard: me.graveyard || [],
    });
    setUndoStack((prev) => [...prev.slice(-19), snapshot]);

    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          pendingDirectAttack: null,
          players: {
            ...curPlayers,
            [myPlayerId]: {
              ...curMe,
              battleZone: updatedBZ,
            },
          },
        };
      },
      {
        sound: 'block',
        cutIn: {
          type: 'ability',
          playerName: me.name,
          card: blocker,
          subText: '🛡️ ブロッカー発動！ダイレクトアタックをブロック！！',
        },
      }
    );
  };

  // シールドブレイク（ガラスが割れる1.mp3）
  const handleBreakShield = async (card: BattleCardInstance, slotIndex?: number) => {
    if (!me || isSpectator) return;
    const slotLabel =
      card.shieldOverlaySlot || (slotIndex !== undefined ? `S${slotIndex + 1}` : undefined);
    const nextShields = shields.filter((c) => c.instanceId !== card.instanceId);
    const addedToHand: BattleCardInstance = {
      ...card,
      faceUp: true,
      tapped: false,
      underCards: [],
      ignored: false,
      shieldOverlaySlot: undefined,
    };
    const nextHand = [...hand, addedToHand];

    await updateMyState(
      {
        shields: nextShields,
        hand: nextHand,
      },
      true,
      { sound: 'shieldBreak' }
    );
    setBrokenShieldCard({ card: addedToHand, slotLabel });
  };

  const toggleEvolutionMaterial = (card: BattleCardInstance, sourceZone: EvolutionSourceZone) => {
    if (!evolutionBuilder) return;
    const exists = evolutionBuilder.selectedMaterials.some(
      (m) => m.card.instanceId === card.instanceId
    );
    const nextSelected = exists
      ? evolutionBuilder.selectedMaterials.filter((m) => m.card.instanceId !== card.instanceId)
      : [...evolutionBuilder.selectedMaterials, { card, sourceZone }];

    setEvolutionBuilder({
      ...evolutionBuilder,
      selectedMaterials: nextSelected,
    });
  };

  // 進化確定（シャキーン1.mp3）
  const handleConfirmFreeEvolution = async () => {
    if (!me || isSpectator || !evolutionBuilder || isEvolvingBusy) return;
    const { evolvingCard, fromZone, selectedMaterials } = evolutionBuilder;

    if (selectedMaterials.length === 0) {
      return alert('進化元（下に敷くカード）を1枚以上選んでください');
    }

    setIsEvolvingBusy(true);
    try {
      let nextDeck = [...deck];
      let nextHand = [...hand];
      let nextMana = [...mana];
      let nextGrave = [...graveyard];
      let nextBZ = [...battleZone].filter((c) => c.instanceId !== evolvingCard.instanceId);

      if (fromZone === 'hand') {
        nextHand = nextHand.filter((c) => c.instanceId !== evolvingCard.instanceId);
      } else if (fromZone === 'mana') {
        nextMana = nextMana.filter((c) => c.instanceId !== evolvingCard.instanceId);
      } else if (fromZone === 'graveyard') {
        nextGrave = nextGrave.filter((c) => c.instanceId !== evolvingCard.instanceId);
      }

      const collectedUnderCards: BattleCardInstance[] = [];
      let inheritedTapState = false;
      let firstBZAnchorId: string | null = null;
      const bzIdsToRemove = new Set<string>();

      for (const mat of selectedMaterials) {
        if (mat.sourceZone === 'battleZone') {
          const found = nextBZ.find((c) => c.instanceId === mat.card.instanceId);
          if (found) {
            if (!firstBZAnchorId) {
              firstBZAnchorId = found.instanceId;
              inheritedTapState = found.tapped;
            } else {
              bzIdsToRemove.add(found.instanceId);
            }
            if (found.underCards && found.underCards.length > 0) {
              collectedUnderCards.push(
                ...found.underCards.map((u) => ({
                  ...u,
                  tapped: false,
                  faceUp: true,
                  underCards: [],
                  ignored: false,
                }))
              );
            }
            collectedUnderCards.push({
              ...found,
              tapped: false,
              faceUp: true,
              underCards: [],
              ignored: false,
            });
          }
        } else if (mat.sourceZone === 'mana') {
          nextMana = nextMana.filter((c) => c.instanceId !== mat.card.instanceId);
          collectedUnderCards.push({
            ...mat.card,
            tapped: false,
            faceUp: true,
            underCards: [],
            ignored: false,
          });
        } else if (mat.sourceZone === 'graveyard') {
          nextGrave = nextGrave.filter((c) => c.instanceId !== mat.card.instanceId);
          collectedUnderCards.push({
            ...mat.card,
            tapped: false,
            faceUp: true,
            underCards: [],
            ignored: false,
          });
        } else if (mat.sourceZone === 'hand') {
          nextHand = nextHand.filter((c) => c.instanceId !== mat.card.instanceId);
          collectedUnderCards.push({
            ...mat.card,
            tapped: false,
            faceUp: true,
            underCards: [],
            ignored: false,
          });
        } else if (mat.sourceZone === 'deck') {
          nextDeck = nextDeck.filter((c) => c.instanceId !== mat.card.instanceId);
          collectedUnderCards.push({
            ...mat.card,
            tapped: false,
            faceUp: true,
            underCards: [],
            ignored: false,
          });
        }
      }

      const evolvedCard: BattleCardInstance = {
        ...evolvingCard,
        tapped: inheritedTapState,
        faceUp: true,
        underCards: collectedUnderCards,
        ignored: false,
        shieldOverlaySlot: undefined,
      };

      if (firstBZAnchorId) {
        nextBZ = nextBZ
          .filter((c) => !bzIdsToRemove.has(c.instanceId))
          .map((c) => (c.instanceId === firstBZAnchorId ? evolvedCard : c));
      } else {
        nextBZ.push(evolvedCard);
      }

      const usedDeck = selectedMaterials.some((m) => m.sourceZone === 'deck');
      if (usedDeck && nextDeck.length > 1) {
        for (let i = nextDeck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [nextDeck[i], nextDeck[j]] = [nextDeck[j], nextDeck[i]];
        }
      }

      const sourceNames = selectedMaterials.map((m) => m.card.name).join('・');
      setEvolutionBuilder(null);
      setSelectedCard(null);

      await updateMyState(
        {
          deck: nextDeck,
          hand: nextHand,
          mana: nextMana,
          graveyard: nextGrave,
          battleZone: nextBZ,
        },
        true,
        {
          sound: 'summon',
          cutIn: {
            type: 'evolution',
            playerName: me.name,
            card: evolvedCard,
            subText: `進化！（下敷き ${selectedMaterials.length}枚：${sourceNames}）`,
          },
        }
      );
    } finally {
      setIsEvolvingBusy(false);
    }
  };

  // 革命チェンジ（シャキーン1.mp3）
  const handleExecuteRevolutionChange = async (targetCard: BattleCardInstance) => {
    if (!me || isSpectator || !revolutionChangePending) return;
    const { card: incomingCard, fromZone } = revolutionChangePending;

    let nextHand = [...hand];
    let nextMana = [...mana];
    let nextGrave = [...graveyard];

    if (fromZone === 'hand') {
      nextHand = nextHand.filter((c) => c.instanceId !== incomingCard.instanceId);
    } else if (fromZone === 'mana') {
      nextMana = nextMana.filter((c) => c.instanceId !== incomingCard.instanceId);
    } else if (fromZone === 'graveyard') {
      nextGrave = nextGrave.filter((c) => c.instanceId !== incomingCard.instanceId);
    }

    const returnedCards: BattleCardInstance[] = [
      { ...targetCard, tapped: false, faceUp: true, underCards: [], ignored: false },
      ...(targetCard.underCards || []).map((u) => ({
        ...u,
        tapped: false,
        faceUp: true,
        underCards: [],
        ignored: false,
      })),
    ];
    nextHand = [...nextHand, ...returnedCards];

    const changedCard: BattleCardInstance = {
      ...incomingCard,
      tapped: targetCard.tapped,
      faceUp: true,
      underCards: [],
      ignored: false,
      shieldOverlaySlot: undefined,
    };

    const nextBZ = battleZone
      .filter((c) => c.instanceId !== incomingCard.instanceId)
      .map((c) => (c.instanceId === targetCard.instanceId ? changedCard : c));

    setRevolutionChangePending(null);
    setSelectedCard(null);

    await updateMyState(
      {
        hand: nextHand,
        mana: nextMana,
        graveyard: nextGrave,
        battleZone: nextBZ,
      },
      true,
      {
        sound: 'summon',
        cutIn: {
          type: 'evolution',
          playerName: me.name,
          card: changedCard,
          subText: `革命チェンジ！（『${targetCard.name}』は手札へ）`,
        },
      }
    );
  };

  const handleExtractUnderCard = async (
    topCard: BattleCardInstance,
    underCard: BattleCardInstance,
    dest: 'hand' | 'graveyard' | 'mana'
  ) => {
    if (!me || isSpectator) return;
    const remainingUnder = (topCard.underCards || []).filter(
      (u) => u.instanceId !== underCard.instanceId
    );
    const updatedTop: BattleCardInstance = { ...topCard, underCards: remainingUnder };
    const nextBZ = battleZone.map((c) =>
      c.instanceId === topCard.instanceId ? updatedTop : c
    );
    const movedUnder: BattleCardInstance = {
      ...underCard,
      tapped: false,
      faceUp: true,
      ignored: false,
    };

    await updateMyState({
      battleZone: nextBZ,
      ...(dest === 'hand' ? { hand: [...hand, movedUnder] } : {}),
      ...(dest === 'graveyard' ? { graveyard: [...graveyard, movedUnder] } : {}),
      ...(dest === 'mana' ? { mana: [...mana, movedUnder] } : {}),
    });

    setSelectedCard({ card: updatedTop, zone: 'battleZone' });
  };

  const handleMoveFromDeckSearch = async (
    card: BattleCardInstance,
    toZone: 'hand' | 'battleZone' | 'mana' | 'graveyard' | 'shields'
  ) => {
    if (!me || isSpectator) return;
    const nextDeck = deck.filter((c) => c.instanceId !== card.instanceId);
    const updatedCard: BattleCardInstance = {
      ...card,
      tapped: false,
      faceUp: toZone !== 'shields',
      ignored: false,
      shieldOverlaySlot: undefined,
    };

    if (toZone === 'hand') {
      await updateMyState({ deck: nextDeck, hand: [...hand, updatedCard] });
    } else if (toZone === 'battleZone') {
      const cleanBZ = battleZone.filter((c) => c.instanceId !== updatedCard.instanceId);
      await updateMyState(
        { deck: nextDeck, battleZone: [...cleanBZ, updatedCard] },
        true,
        {
          sound: 'summon',
          cutIn: {
            type: 'summon',
            playerName: me.name,
            card: updatedCard,
            subText: '山札からバトルゾーンへ！',
          },
        }
      );
    } else if (toZone === 'mana') {
      await updateMyState({ deck: nextDeck, mana: [...mana, updatedCard] });
    } else if (toZone === 'graveyard') {
      await updateMyState({ deck: nextDeck, graveyard: [...graveyard, updatedCard] });
    } else if (toZone === 'shields') {
      await updateMyState({ deck: nextDeck, shields: [...shields, updatedCard] });
    }
  };

  const renderCard = (
    card: BattleCardInstance,
    zone: ZoneType,
    isControllable: boolean,
    ownerName: string,
    index?: number,
    forceHideFaceForSpectator = false
  ) => {
    const showFace = forceHideFaceForSpectator
      ? false
      : card.faceUp || (isControllable && zone === 'hand') || (isSpectator && zone === 'hand');
    const underCount = card.underCards?.length || 0;
    const canClick = isControllable || showFace;
    const isKindan = !!card.kindanRole;
    const isIgnored = zone === 'battleZone' && !!card.ignored;

    const kindanDisplayImage = isKindan
      ? card.kindanAwakened
        ? card.kindanAwakenedImageUrl || card.imageUrl
        : card.imageUrl
      : card.imageUrl;

    const slotName = `S${(index ?? 0) + 1}`;
    const shieldBadgeLabel =
      card.shieldOverlaySlot || (zone === 'shields' && index !== undefined ? slotName : '🛡️表盾');

    return (
      <div
        key={card.instanceId}
        onClick={() => {
          if (!isControllable) {
            if (showFace) {
              setInspectCard({
                card,
                ownerName,
                sourceZone: zone,
                isOpponentCard: !isSpectator,
              });
            }
            return;
          }

          if (zone === 'shields' && !card.faceUp) {
            handleBreakShield(card, index);
            return;
          }
          if (zone === 'shields' && card.faceUp) {
            setSelectedCard({ card, zone: 'shields', shieldSlotIndex: index });
            return;
          }
          if (zone === 'mana') {
            toggleTap(card, 'mana');
            return;
          }
          setSelectedCard({ card, zone });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!isControllable) {
            if (showFace) {
              setInspectCard({
                card,
                ownerName,
                sourceZone: zone,
                isOpponentCard: !isSpectator,
              });
            }
            return;
          }
          setSelectedCard({ card, zone, shieldSlotIndex: zone === 'shields' ? index : undefined });
        }}
        title={
          zone === 'shields' && !card.faceUp
            ? `${slotName}（タップでブレイク）`
            : showFace
            ? `${card.name}（タップで操作・拡大）`
            : '裏向きカード'
        }
        className={`relative select-none transition-all shrink-0 ${
          canClick ? 'cursor-pointer active:scale-95' : 'cursor-default'
        } ${card.tapped ? 'rotate-90 mx-2.5 opacity-85' : ''} ${
          isIgnored ? 'brightness-50 saturate-50' : ''
        } ${underCount > 0 ? 'mt-2 ml-1.5' : ''}`}
      >
        {underCount > 0 && (
          <div
            className={`absolute -top-2 -left-1.5 w-full h-full rounded-md border shadow-sm pointer-events-none ${
              isKindan
                ? 'bg-rose-950 border-amber-400'
                : 'bg-purple-900 border-purple-400'
            }`}
          />
        )}

        <div
          className={`relative rounded-md shadow-md overflow-hidden flex flex-col justify-between ${
            isKindan
              ? `w-16 h-22 sm:w-20 sm:h-26 border-2 ${
                  card.kindanAwakened
                    ? 'bg-gradient-to-br from-rose-700 via-amber-600 to-rose-900 border-yellow-300 ring-2 ring-amber-400'
                    : 'bg-gradient-to-br from-slate-900 via-rose-950 to-purple-950 border-rose-500'
                } text-white`
              : showFace
              ? `w-14 h-20 sm:w-16 sm:h-24 bg-slate-800 ${
                  zone === 'shields'
                    ? 'border-2 border-amber-400 ring-2 ring-amber-400/50'
                    : isIgnored
                    ? 'border border-slate-600'
                    : 'border border-slate-400'
                } text-white`
              : 'w-12 h-16 sm:w-14 sm:h-20 bg-indigo-950 border-2 border-amber-500/70 text-amber-300 items-center justify-center'
          }`}
        >
          {isKindan ? (
            kindanDisplayImage ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={kindanDisplayImage}
                  alt={card.name}
                  className="w-full h-full object-cover"
                />
                <span
                  className={`absolute top-0.5 left-0.5 right-0.5 text-center text-[8px] font-extrabold px-1 rounded shadow ${
                    card.kindanAwakened
                      ? 'bg-yellow-300 text-slate-950'
                      : 'bg-rose-600/95 text-white'
                  }`}
                >
                  {card.kindanAwakened ? '🔥 禁断解放！' : '🔒 鼓動 / 封印中'}
                </span>
                <span className="absolute bottom-0.5 left-0.5 right-0.5 text-center bg-black/85 border border-amber-400/80 text-amber-300 text-[9px] font-extrabold py-0.5 rounded">
                  封印 {underCount}枚
                </span>
              </>
            ) : (
              <div className="p-1 flex flex-col justify-between items-center h-full text-center">
                <span
                  className={`w-full text-[8px] font-extrabold px-1 rounded ${
                    card.kindanAwakened
                      ? 'bg-yellow-300 text-slate-950'
                      : 'bg-rose-600 text-white'
                  }`}
                >
                  {card.kindanAwakened ? '🔥 禁断解放！' : '🔒 鼓動 / 封印中'}
                </span>
                <div className="text-[9px] sm:text-[10px] font-extrabold leading-tight line-clamp-2 text-amber-200">
                  {card.kindanRole === 'dokindam' ? 'ドキンダムX' : 'ドルマゲドンX'}
                </div>
                <span className="w-full bg-black/80 border border-amber-400/70 text-amber-300 text-[9px] font-extrabold py-0.5 rounded">
                  封印 {underCount}枚
                </span>
              </div>
            )
          ) : showFace ? (
            card.imageUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={card.imageUrl}
                  alt={card.name}
                  className="w-full h-full object-cover"
                />
                {zone === 'shields' && (
                  <span className="absolute top-0.5 left-0.5 bg-amber-400 text-slate-950 text-[8px] font-extrabold px-1 rounded shadow">
                    {shieldBadgeLabel}
                  </span>
                )}
                {card.isShieldTrigger && (
                  <span className="absolute top-0.5 right-0.5 bg-yellow-400 text-slate-950 text-[8px] font-extrabold px-1 rounded shadow">
                    ⚡ST
                  </span>
                )}
                {underCount > 0 && (
                  <span className="absolute bottom-0.5 left-0.5 bg-purple-600 text-white text-[8px] font-extrabold px-1 rounded shadow">
                    進化+{underCount}
                  </span>
                )}
                {isIgnored && (
                  <span className="absolute bottom-0.5 right-0.5 bg-slate-950/90 border border-slate-400/70 text-slate-200 text-[8px] font-extrabold px-1 rounded shadow">
                    🌑無視
                  </span>
                )}
              </>
            ) : (
              <div className="p-1 flex flex-col justify-center items-center h-full">
                {zone === 'shields' && (
                  <span className="mb-0.5 bg-amber-400 text-slate-950 text-[8px] font-extrabold px-1 rounded">
                    {shieldBadgeLabel}
                  </span>
                )}
                <div className="text-[9px] font-bold leading-tight line-clamp-3 text-center">
                  {card.name}
                </div>
                {isIgnored && (
                  <span className="mt-1 bg-slate-950 text-slate-300 text-[8px] px-1 rounded">
                    🌑無視
                  </span>
                )}
              </div>
            )
          ) : (
            <span className="text-xs font-bold">
              {zone === 'shields' ? slotName : 'DM'}
            </span>
          )}
        </div>
      </div>
    );
  };

  const tappedManaCount = mana.filter((c) => c.tapped).length;
  const untappedManaCount = mana.length - tappedManaCount;
  const turnOwnerName = playersObj[room.turnPlayerId]?.name || 'プレイヤー';

  const activePublicReveal =
    room.publicReveal && room.publicReveal.playerName !== me?.name ? room.publicReveal : null;

  const getEvolutionCandidates = (): BattleCardInstance[] => {
    if (!evolutionBuilder) return [];
    const excludeId = evolutionBuilder.evolvingCard.instanceId;
    if (evolutionBuilder.activeTab === 'battleZone') {
      return battleZone.filter((c) => c.instanceId !== excludeId);
    }
    if (evolutionBuilder.activeTab === 'mana') {
      return mana.filter((c) => c.instanceId !== excludeId);
    }
    if (evolutionBuilder.activeTab === 'graveyard') {
      return graveyard.filter((c) => c.instanceId !== excludeId);
    }
    if (evolutionBuilder.activeTab === 'hand') {
      return hand.filter((c) => c.instanceId !== excludeId);
    }
    return deck.filter((c) => c.instanceId !== excludeId);
  };

  const shieldSlotChoices = Array.from(
    { length: Math.max(shields.length, 5) },
    (_, i) => `S${i + 1}`
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-2 sm:p-4 max-w-6xl mx-auto">
      <CutInOverlay event={room.cutIn} />

      {/* 上部バー */}
      <header className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 p-2.5 rounded-lg border border-slate-800">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-xs sm:text-sm bg-slate-800 px-2.5 py-1 rounded font-mono font-bold text-amber-400">
            ID: {room.roomId}
          </span>
          {isSpectator && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs bg-indigo-600 px-2.5 py-1 rounded font-bold text-white">
                👁️ 観戦モード
              </span>
              <button
                type="button"
                onClick={() => setSpectatorShowHands((prev) => !prev)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-amber-400/70 text-amber-300 rounded text-xs font-bold"
              >
                {spectatorShowHands ? '🙈 両方の手札を隠す' : '👁️ 両方の手札を見る'}
              </button>
            </div>
          )}
          <span className="text-xs sm:text-sm font-bold">
            ターン {room.turnCount}：
            <span className={isMyTurn ? 'text-emerald-400' : 'text-amber-300'}>
              {isSpectator
                ? `${turnOwnerName}のターン`
                : isMyTurn
                ? 'あなたのターン'
                : `${opponent?.name || '相手'}のターン`}
            </span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              if (next) playGameSound('turnEnd');
            }}
            title="効果音のON/OFF"
            className={`px-2.5 py-1.5 rounded text-xs font-bold border transition ${
              soundEnabled
                ? 'bg-slate-800 hover:bg-slate-700 border-amber-400/60 text-amber-300'
                : 'bg-slate-900 border-slate-700 text-slate-500'
            }`}
          >
            {soundEnabled ? '🔊 音ON' : '🔇 音OFF'}
          </button>

          {!isSpectator && (
            <>
              <button
                type="button"
                onClick={() => setDirectAttackModalOpen(true)}
                className="px-3 py-1.5 bg-gradient-to-r from-rose-600 via-red-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white border border-yellow-300/80 rounded text-xs font-extrabold shadow-md animate-pulse"
              >
                💥 ダイレクトアタック
              </button>
              <button
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 border border-slate-600 rounded text-xs font-bold transition"
              >
                ↩️ 1つ戻る ({undoStack.length})
              </button>
              <button
                onClick={handleTurnStart}
                className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-bold"
              >
                ターン開始(全起き+1ドロー)
              </button>
              <button
                onClick={handleTurnEnd}
                className="px-2.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-xs font-bold"
              >
                ターンエンド
              </button>
              <button
                onClick={handleResetMatch}
                disabled={resetting}
                className="px-2.5 py-1.5 bg-rose-800 hover:bg-rose-700 border border-rose-500/60 rounded text-xs font-bold"
              >
                🔄 試合リセット
              </button>
            </>
          )}
          <button
            onClick={async () => {
              localStorage.removeItem('dm_last_room_id');
              localStorage.removeItem('dm_last_room_ts');

              if (!isSpectator && roomId && myPlayerId) {
                try {
                  const latest = (await fetchRoomState(roomId)) ?? roomRef.current;
                  if (latest) {
                    const pIds = Object.keys(latest.players || {});
                    const nextLeftMap = {
                      ...(latest.leftPlayers || {}),
                      [myPlayerId]: true,
                    };
                    const allLeft = pIds.length > 0 && pIds.every((id) => nextLeftMap[id]);
                    if (allLeft) {
                      await deleteRoomRow(roomId);
                    } else {
                      await saveRoomState(roomId, {
                        ...latest,
                        leftPlayers: nextLeftMap,
                      });
                    }
                  }
                } catch (e) {
                  console.error(e);
                }
              }

              router.push('/');
            }}
            className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300"
          >
            退出
          </button>
        </div>
      </header>

      {/* ダイレクトアタック宣言送信後の待機バナー（攻撃側） */}
      {amIWaitingDirectAttack && pendingDirectAttack && (
        <div className="my-1.5 p-2.5 bg-rose-950/90 border-2 border-amber-400 rounded-xl flex items-center justify-between gap-2 text-xs font-bold text-amber-200 animate-pulse">
          <span>
            ⚔️ 「{pendingDirectAttack.card.name}」でダイレクトアタック宣言中！相手の対応（敗北宣言 / 革命0トリガー / ブロック）を待っています...
          </span>
          <button
            type="button"
            onClick={async () => {
              await applyRoomUpdate((cur) => ({
                ...cur,
                pendingDirectAttack: null,
              }));
            }}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px] shrink-0 text-slate-200"
          >
            取り消し
          </button>
        </div>
      )}

      {room.inspectingText && (
        <div className="my-1.5 py-1.5 px-4 bg-sky-900/90 border border-sky-400 rounded-lg text-center text-xs sm:text-sm font-bold text-sky-200 animate-pulse">
          🔍 {room.inspectingText}
        </div>
      )}

      {activePublicReveal && activePublicReveal.cards && activePublicReveal.cards.length > 0 && (
        <div className="my-1.5 p-3 bg-amber-950/90 border-2 border-amber-400 rounded-xl space-y-2 shadow-xl">
          <div className="flex items-center justify-between text-xs font-bold text-amber-300">
            <span>
              👁️ {activePublicReveal.playerName} が山札の上からめくって公開中（タップで能力拡大）
            </span>
            <span>残り {activePublicReveal.cards.length} 枚</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activePublicReveal.cards.map((c) => (
              <div
                key={c.instanceId}
                onClick={() =>
                  setInspectCard({ card: c, ownerName: activePublicReveal.playerName })
                }
                className="cursor-pointer bg-slate-900 border border-amber-400/70 rounded-lg p-1.5 flex flex-col items-center w-20 sm:w-24 hover:scale-105 transition"
              >
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.imageUrl}
                    alt={c.name}
                    className="w-16 h-22 sm:w-20 sm:h-28 object-cover rounded"
                  />
                ) : (
                  <div className="w-16 h-22 bg-slate-800 rounded flex items-center justify-center text-[10px] text-center p-1">
                    {c.name}
                  </div>
                )}
                <span className="text-[10px] font-bold truncate w-full text-center mt-1">
                  {c.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ================= 上側フィールド（相手 または プレイヤー1） ================= */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-xl p-2 sm:p-3 space-y-2 my-1">
        <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-400">
          <span className="font-bold text-rose-300">
            {isSpectator ? 'プレイヤー1' : '相手'}：{opponent ? opponent.name : '参加待ち...'}
          </span>
          <div className="flex items-center gap-3">
            <span>山札: {oppDeck.length}</span>
            <span>手札: {oppHand.length}</span>
            <span>マナ: {oppMana.length}</span>
            {opponent && (
              <button
                type="button"
                onClick={() => setOppGraveViewOpen(true)}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 border border-rose-500/50 rounded text-rose-300 font-bold"
              >
                墓地: {oppGraveyard.length}（見る）
              </button>
            )}
          </div>
        </div>

        {/* 観戦モード専用：プレイヤー1の手札表示 */}
        {isSpectator && opponent && (
          <div className="bg-slate-950/90 p-2 rounded-lg border border-indigo-500/40">
            <div className="text-[10px] text-rose-300 font-bold mb-1">
              {opponent.name}の手札 ({oppHand.length}枚)
            </div>
            <div className="flex flex-wrap gap-1.5 min-h-[68px]">
              {oppHand.map((c) =>
                renderCard(
                  c,
                  'hand',
                  false,
                  opponent.name,
                  undefined,
                  !spectatorShowHands
                )
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1 min-h-[32px] bg-slate-950/50 p-1.5 rounded items-center">
          <span className="text-[10px] text-slate-500 mr-1">マナ:</span>
          {oppMana.map((c) => renderCard(c, 'mana', false, opponent?.name || '相手'))}
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[40px] bg-slate-950/50 p-1.5 rounded items-center">
          <span className="text-[10px] text-slate-500 mr-1">
            シールド ({oppShields.length}枚):
          </span>
          {oppShields.map((c, idx) =>
            renderCard(c, 'shields', false, opponent?.name || '相手', idx)
          )}
        </div>

        {/* 相手バトルゾーン */}
        <div className="flex items-center justify-between gap-2 min-h-[70px] bg-slate-800/40 p-2 rounded">
          <div className="flex flex-wrap gap-2 items-center flex-1">
            <span className="text-[10px] text-slate-400 mr-1">
              バトルゾーン (タップで能力拡大・行動不能化・盾送り):
            </span>
            {oppNormalBattleZone.map((c) =>
              renderCard(c, 'battleZone', false, opponent?.name || '相手')
            )}
          </div>
          {oppKindanBattleZone && (
            <div className="pl-2 border-l border-rose-500/40 shrink-0">
              {renderCard(oppKindanBattleZone, 'battleZone', false, opponent?.name || '相手')}
            </div>
          )}
        </div>
      </section>

      {/* ================= 下側フィールド（自分 または プレイヤー2） ================= */}
      <section className="bg-slate-900 border border-slate-700 rounded-xl p-2 sm:p-3 space-y-2 my-1">
        {isSpectator && (
          <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-slate-400">
            <span className="font-bold text-emerald-300">
              プレイヤー2：{me ? me.name : '参加待ち...'}
            </span>
            <div className="flex items-center gap-3">
              <span>山札: {deck.length}</span>
              <span>手札: {hand.length}</span>
              <span>マナ: {mana.length}</span>
              <button
                type="button"
                onClick={() => setGraveSearchOpen(true)}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 border border-emerald-500/50 rounded text-emerald-300 font-bold"
              >
                墓地: {graveyard.length}（見る）
              </button>
            </div>
          </div>
        )}

        {/* 自分バトルゾーン */}
        <div className="flex items-center justify-between gap-2 min-h-[85px] bg-slate-800/60 p-2 rounded">
          <div className="flex flex-wrap gap-2 items-center flex-1">
            <span className="text-[10px] text-emerald-400 font-bold mr-1">バトルゾーン:</span>
            {normalBattleZone.map((c) =>
              renderCard(c, 'battleZone', !isSpectator, me?.name || '自分')
            )}
          </div>
          {kindanBattleZone && (
            <div className="pl-2 border-l border-amber-500/40 shrink-0">
              {renderCard(kindanBattleZone, 'battleZone', !isSpectator, me?.name || '自分')}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/60 p-2 rounded">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-amber-400 font-bold mr-1">
              シールド ({shields.length}枚){!isSpectator && '(S1〜S5タップでブレイク／表盾タップで拡大)'}:
            </span>
            {shields.map((c, idx) =>
              renderCard(c, 'shields', !isSpectator, me?.name || '自分', idx)
            )}
          </div>

          {!isSpectator && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <button
                onClick={() => handleTopDeckTo('hand')}
                className="px-2.5 py-1.5 bg-sky-600 hover:bg-sky-500 rounded text-xs font-bold"
              >
                1ドロー ({deck.length})
              </button>
              <button
                onClick={() => handleTopDeckTo('mana')}
                className="px-2.5 py-1.5 bg-lime-700 hover:bg-lime-600 rounded text-xs font-bold"
              >
                山札→マナ
              </button>
              <button
                onClick={() => handleTopDeckTo('graveyard')}
                className="px-2.5 py-1.5 bg-rose-800 hover:bg-rose-700 rounded text-xs font-bold"
              >
                山札→墓地
              </button>
              <button
                onClick={() => handleTopDeckTo('shields')}
                className="px-2.5 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-xs font-bold"
              >
                山札→シールド
              </button>

              <div className="flex items-center bg-indigo-950 border border-indigo-500 rounded overflow-hidden">
                <select
                  value={peekCount}
                  onChange={(e) => setPeekCount(Number(e.target.value))}
                  className="bg-indigo-950 text-white text-xs font-bold px-2 py-1.5 focus:outline-none cursor-pointer"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                    <option key={num} value={num}>
                      {num === 1 ? '1枚(トップ)' : `${num}枚`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => handlePeekTopDeck(peekCount, false)}
                  title="相手には見せず自分だけ確認します"
                  className="px-2 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-bold border-l border-indigo-400/40"
                >
                  🔒 自分だけ見る
                </button>
                <button
                  onClick={() => handlePeekTopDeck(peekCount, true)}
                  title="相手にもカードを見せながらめくって選びます"
                  className="px-2 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 text-xs font-extrabold border-l border-amber-300/40"
                >
                  👁️ 相手に見せてめくる
                </button>
              </div>

              <button
                onClick={() => setDeckSearchOpen(true)}
                className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold"
              >
                山札全確認
              </button>
              <button
                onClick={handleShuffle}
                className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
              >
                シャッフル
              </button>
              <button
                onClick={() => setGraveSearchOpen(true)}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-xs text-rose-300 font-bold"
              >
                墓地 ({graveyard.length})
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[45px] bg-slate-950/60 p-2 rounded items-center justify-between">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-lime-400 font-bold mr-1">
              マナ (使用可能 {untappedManaCount} / 合計 {mana.length})
              {!isSpectator && ' ※タップで寝かせる'}:
            </span>
            {mana.map((c) => renderCard(c, 'mana', !isSpectator, me?.name || '自分'))}
          </div>
          {!isSpectator && mana.length > 0 && (
            <button
              onClick={() => setSelectedCard({ card: mana[mana.length - 1], zone: 'mana' })}
              className="px-2.5 py-1.5 bg-lime-900 hover:bg-lime-800 border border-lime-500/50 rounded text-[11px] font-bold text-lime-200"
            >
              マナ拡大・場に出す・進化
            </button>
          )}
        </div>

        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
          <div className="text-[10px] text-slate-400 mb-1.5">
            {isSpectator
              ? `${me?.name || 'プレイヤー2'}の手札 (${hand.length}枚)`
              : `自分の手札 (${hand.length}枚) - タップで超拡大＆マナ置き・召喚・進化・革命チェンジ`}
          </div>
          <div className="flex flex-wrap gap-2 min-h-[90px]">
            {hand.map((c) =>
              renderCard(
                c,
                'hand',
                !isSpectator,
                me?.name || '自分',
                undefined,
                isSpectator && !spectatorShowHands
              )
            )}
          </div>
        </div>
      </section>

      {/* ================= 【防御側専用】ダイレクトアタック迎撃・敗北選択モーダル ================= */}
      {amIDefendingDirectAttack && pendingDirectAttack && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-gradient-to-b from-rose-950 via-slate-900 to-slate-950 border-2 border-rose-500 rounded-2xl p-4 sm:p-5 max-w-lg w-full max-h-[92vh] overflow-y-auto space-y-4 shadow-2xl">
            <div className="text-center space-y-1">
              <span className="inline-block px-3 py-0.5 bg-rose-600 text-white text-xs font-extrabold rounded-full animate-bounce">
                🚨 絶体絶命！ダイレクトアタックを受けた！
              </span>
              <h3 className="font-extrabold text-base sm:text-lg text-amber-300">
                {pendingDirectAttack.attackerPlayerName} の「{pendingDirectAttack.card.name}」がとどめを刺しに来た！
              </h3>
            </div>

            {pendingDirectAttack.card.imageUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pendingDirectAttack.card.imageUrl}
                  alt={pendingDirectAttack.card.name}
                  className="w-28 h-40 object-contain rounded-xl border-2 border-rose-400 bg-slate-950 shadow-xl"
                />
              </div>
            )}

            {defenseSubMode === 'main' && (
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={handleAcceptDefeat}
                  className="w-full py-3.5 px-4 bg-gradient-to-r from-slate-800 via-rose-900 to-slate-800 hover:from-rose-800 hover:to-rose-700 border-2 border-rose-400 rounded-xl text-sm sm:text-base font-extrabold text-white shadow-lg transition transform active:scale-95"
                >
                  💀 敗北を認める（もうこれ以上あがけない…）
                </button>

                <button
                  type="button"
                  onClick={() => setDefenseSubMode('revZero')}
                  className="w-full py-3.5 px-4 bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 hover:from-amber-400 hover:to-red-500 text-slate-950 rounded-xl text-sm sm:text-base font-extrabold shadow-lg transition transform active:scale-95"
                >
                  🔥 革命0トリガーを発動する！（手札から選択）
                </button>

                <button
                  type="button"
                  onClick={() => setDefenseSubMode('blocker')}
                  className="w-full py-3.5 px-4 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white border border-sky-300/60 rounded-xl text-sm sm:text-base font-extrabold shadow-lg transition transform active:scale-95"
                >
                  🛡️ ブロッカーでブロックする！（場のクリーチャー）
                </button>
              </div>
            )}

            {defenseSubMode === 'revZero' && (
              <div className="space-y-3 bg-slate-950/80 p-3 rounded-xl border border-amber-400/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-amber-300">
                    🔥 手札から革命0トリガーとして使うカードを選択
                  </span>
                  <button
                    type="button"
                    onClick={() => setDefenseSubMode('main')}
                    className="px-2.5 py-1 bg-slate-700 rounded text-xs font-bold"
                  >
                    ← 戻る
                  </button>
                </div>

                {hand.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-4">手札がありません</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[45vh] overflow-y-auto">
                    {hand.map((c) => (
                      <div
                        key={c.instanceId}
                        className="bg-slate-800 border border-amber-400/60 rounded-lg p-2 flex flex-col items-center space-y-1.5"
                      >
                        {c.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.imageUrl}
                            alt={c.name}
                            className="w-16 h-22 object-cover rounded"
                          />
                        ) : (
                          <div className="w-16 h-22 bg-slate-700 rounded flex items-center justify-center text-[10px] p-1 text-center">
                            {c.name}
                          </div>
                        )}
                        <div className="text-[10px] font-bold truncate w-full text-center">
                          {c.name}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleActivateRevZeroTrigger(c, 'battleZone')}
                          className="w-full py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-[10px] font-extrabold"
                        >
                          場に出す
                        </button>
                        <button
                          type="button"
                          onClick={() => handleActivateRevZeroTrigger(c, 'graveyard')}
                          className="w-full py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-[10px] font-bold"
                        >
                          呪文詠唱(墓地)
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {defenseSubMode === 'blocker' && (
              <div className="space-y-3 bg-slate-950/80 p-3 rounded-xl border border-sky-400/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-sky-300">
                    🛡️ ブロックする自分のクリーチャーを選択（タップされます）
                  </span>
                  <button
                    type="button"
                    onClick={() => setDefenseSubMode('main')}
                    className="px-2.5 py-1 bg-slate-700 rounded text-xs font-bold"
                  >
                    ← 戻る
                  </button>
                </div>

                {battleZone.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-4">
                    バトルゾーンにクリーチャーがいません
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[45vh] overflow-y-auto">
                    {battleZone.map((c) => {
                      const img =
                        c.kindanRole && c.kindanAwakened && c.kindanAwakenedImageUrl
                          ? c.kindanAwakenedImageUrl
                          : c.imageUrl;
                      return (
                        <button
                          key={c.instanceId}
                          type="button"
                          onClick={() => handleBlockDirectAttack(c)}
                          className={`bg-slate-800 hover:bg-sky-900 border border-sky-400/70 rounded-lg p-2 flex flex-col items-center space-y-1.5 transition ${
                            c.ignored ? 'brightness-50' : ''
                          }`}
                        >
                          {img ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={img}
                              alt={c.name}
                              className="w-16 h-22 object-cover rounded"
                            />
                          ) : (
                            <div className="w-16 h-22 bg-slate-700 rounded flex items-center justify-center text-[10px] p-1 text-center">
                              {c.name}
                            </div>
                          )}
                          <div className="text-[10px] font-bold truncate w-full text-center">
                            {c.ignored ? `🌑[無視] ${c.name}` : c.name}
                          </div>
                          <span className="w-full py-1 bg-sky-500 text-slate-950 rounded text-[10px] font-extrabold">
                            🛡️ ブロックする
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= ダイレクトアタック宣言クリーチャー選択モーダル（攻撃側） ================= */}
      {!isSpectator && directAttackModalOpen && (
        <div
          onClick={() => setDirectAttackModalOpen(false)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-yellow-400 rounded-2xl p-4 sm:p-5 max-w-lg w-full space-y-4 shadow-2xl"
          >
            <div className="text-center space-y-1">
              <h3 className="font-extrabold text-lg text-yellow-300">
                💥 ダイレクトアタックするクリーチャーを選択！
              </h3>
              <p className="text-xs text-slate-300">
                選択すると相手の画面に「敗北を認める / 革命0トリガー / ブロック」の最終選択が出現します！
              </p>
            </div>

            {battleZone.length === 0 ? (
              <p className="text-center text-xs text-slate-400 py-6">
                バトルゾーンにクリーチャーがいません
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto p-1">
                {battleZone.map((c) => {
                  const displayImg =
                    c.kindanRole && c.kindanAwakened && c.kindanAwakenedImageUrl
                      ? c.kindanAwakenedImageUrl
                      : c.imageUrl;
                  return (
                    <button
                      key={c.instanceId}
                      type="button"
                      onClick={() => handleDeclareDirectAttack(c)}
                      className={`bg-gradient-to-b from-rose-900/90 to-slate-900 hover:from-rose-700 hover:to-amber-900 border-2 border-amber-400 rounded-xl p-2 flex flex-col items-center space-y-1.5 transition transform hover:scale-105 active:scale-95 shadow-lg ${
                        c.ignored ? 'brightness-50' : ''
                      }`}
                    >
                      {displayImg ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={displayImg}
                          alt={c.name}
                          className="w-20 h-28 object-cover rounded border border-yellow-300/60"
                        />
                      ) : (
                        <div className="w-20 h-28 bg-slate-800 rounded flex items-center justify-center text-xs font-bold p-1 text-center">
                          {c.name}
                        </div>
                      )}
                      <span className="text-xs font-extrabold text-white truncate w-full text-center">
                        {c.ignored ? `🌑[無視] ${c.name}` : c.name}
                      </span>
                      <span className="px-2 py-0.5 bg-yellow-400 text-slate-950 rounded text-[10px] font-extrabold">
                        💥 とどめを刺す！
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={() => setDirectAttackModalOpen(false)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-xs font-bold"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* ================= シールドブレイク後の秘匿確認モーダル ================= */}
      {!isSpectator && brokenShieldCard && (
        <div
          onClick={() => setBrokenShieldCard(null)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-2 sm:p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-yellow-400 rounded-2xl p-3 sm:p-4 max-w-md w-full max-h-[95vh] flex flex-col items-center justify-between space-y-2.5 shadow-2xl"
          >
            <div className="w-full flex items-center justify-between">
              <span className="px-2.5 py-0.5 rounded bg-yellow-400 text-slate-950 text-xs font-extrabold">
                🛡️ {brokenShieldCard.slotLabel ? `${brokenShieldCard.slotLabel} ` : ''}ブレイク（あなただけに見えています）
              </span>
              {brokenShieldCard.card.isShieldTrigger && (
                <span className="px-2 py-0.5 rounded bg-rose-600 text-white text-xs font-extrabold">
                  ⚡ S・トリガー持ち！
                </span>
              )}
            </div>

            {brokenShieldCard.card.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brokenShieldCard.card.imageUrl}
                alt={brokenShieldCard.card.name}
                className="w-[80vw] max-w-[360px] h-[56vh] max-h-[480px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl"
              />
            ) : (
              <div className="w-64 h-80 bg-slate-800 rounded-xl flex items-center justify-center font-bold text-lg p-4 text-center">
                {brokenShieldCard.card.name}
              </div>
            )}

            <div className="text-center font-bold text-base text-amber-300 truncate w-full">
              {brokenShieldCard.card.name}
            </div>

            <div className="w-full space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                <button
                  onClick={async () => {
                    const c = brokenShieldCard.card;
                    setBrokenShieldCard(null);
                    await moveCard(c, 'hand', 'battleZone', false, undefined, {
                      type: 'trigger',
                      playerName: me?.name || '自分',
                      card: c,
                      subText: 'S・トリガーでバトルゾーンへ！',
                    });
                  }}
                  className="py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl"
                >
                  ⚡ ST：場に出す
                </button>
                <button
                  onClick={async () => {
                    const c = brokenShieldCard.card;
                    setBrokenShieldCard(null);
                    await moveCard(c, 'hand', 'graveyard', true, undefined, {
                      type: 'trigger',
                      playerName: me?.name || '自分',
                      card: c,
                      subText: 'S・トリガー呪文を詠唱！',
                    });
                    if (soundEnabledRef.current) {
                      playGameSound('spell');
                    }
                  }}
                  className="py-2.5 bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-xl"
                >
                  ⚡ ST：呪文を唱える
                </button>
              </div>
              <button
                onClick={() => setBrokenShieldCard(null)}
                className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-xl text-xs sm:text-sm"
              >
                使わずに手札に加える（相手には見えません）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 相手のカード（または観戦中のカード）超拡大プレビュー＆暗転＆シールド貼り付け ================= */}
      {inspectCard && (
        <div
          onClick={() => setInspectCard(null)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-2 sm:p-4 z-50 cursor-pointer"
        >
          <div
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="bg-slate-900 border-2 border-slate-500 rounded-2xl p-3 sm:p-4 max-w-md w-full max-h-[95vh] overflow-y-auto flex flex-col items-center justify-between space-y-2.5 shadow-2xl cursor-default"
          >
            <div className="w-full flex items-center justify-between text-xs text-slate-300 font-bold">
              <span>{inspectCard.ownerName} のカード確認</span>
              <span className="truncate max-w-[200px] text-amber-300">{inspectCard.card.name}</span>
            </div>

            {(inspectCard.card.kindanRole &&
            inspectCard.card.kindanAwakened &&
            inspectCard.card.kindanAwakenedImageUrl
              ? inspectCard.card.kindanAwakenedImageUrl
              : inspectCard.card.imageUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={
                  inspectCard.card.kindanRole &&
                  inspectCard.card.kindanAwakened &&
                  inspectCard.card.kindanAwakenedImageUrl
                    ? inspectCard.card.kindanAwakenedImageUrl
                    : inspectCard.card.imageUrl
                }
                alt={inspectCard.card.name}
                onClick={() => setInspectCard(null)}
                className="w-[80vw] max-w-[360px] h-[56vh] max-h-[500px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl cursor-pointer"
              />
            ) : (
              <div className="w-full p-4 bg-slate-800 rounded-xl space-y-2 text-center">
                <div className="font-extrabold text-base text-amber-300">
                  {inspectCard.card.name}
                </div>
                {inspectCard.card.text && (
                  <p className="text-xs text-slate-200 leading-relaxed text-left">
                    {inspectCard.card.text}
                  </p>
                )}
              </div>
            )}

            {(inspectCard.card.underCards?.length || 0) > 0 && (
              <div className="w-full bg-slate-800/80 p-2 rounded-lg text-xs">
                <div className="text-purple-300 font-bold mb-1">
                  {inspectCard.card.kindanRole
                    ? `封印枚数：残り ${inspectCard.card.underCards?.length} 枚（裏向き）`
                    : `進化元 (${inspectCard.card.underCards?.length}枚)：`}
                </div>
                {!inspectCard.card.kindanRole && (
                  <div className="flex flex-wrap gap-1">
                    {inspectCard.card.underCards?.map((u) => (
                      <button
                        key={u.instanceId}
                        onClick={() =>
                          setInspectCard({ card: u, ownerName: inspectCard.ownerName })
                        }
                        className="px-2 py-0.5 bg-purple-900 border border-purple-400 rounded text-[11px]"
                      >
                        {u.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isSpectator &&
              inspectCard.isOpponentCard &&
              inspectCard.sourceZone === 'battleZone' && (
                <button
                  onClick={() => handleToggleOpponentIgnore(inspectCard.card)}
                  className={`w-full py-2.5 font-extrabold rounded-xl text-xs sm:text-sm shadow-lg transition ${
                    inspectCard.card.ignored
                      ? 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                      : 'bg-slate-700 hover:bg-slate-600 border border-slate-400 text-white'
                  }`}
                >
                  {inspectCard.card.ignored
                    ? '☀️ 元の明るさに戻す（行動不能・無視を解除）'
                    : '🌑 暗くする（行動不能・無視する目印）'}
                </button>
              )}

            {!isSpectator &&
              inspectCard.isOpponentCard &&
              !inspectCard.card.kindanRole &&
              (inspectCard.sourceZone === 'battleZone' || inspectCard.sourceZone === 'mana') && (
                <button
                  onClick={() =>
                    handleSendOpponentCardToFaceUpShield(
                      inspectCard.card,
                      inspectCard.sourceZone!
                    )
                  }
                  className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold rounded-xl text-xs sm:text-sm shadow-lg transition"
                >
                  🛡️ 表向きにして相手のシールドに追加（新シールド）
                </button>
              )}

            <button
              onClick={() => setInspectCard(null)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-xl text-xs sm:text-sm"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ================= 山札の上から1〜10枚めくり選択モーダル（非公開＆公開対応） ================= */}
      {!isSpectator && peekState && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50">
          <div
            className={`bg-slate-900 border-2 ${
              peekState.isPublic ? 'border-amber-400' : 'border-sky-400'
            } rounded-2xl p-4 sm:p-5 max-w-3xl w-full max-h-[92vh] flex flex-col space-y-3`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3
                  className={`font-bold text-base ${
                    peekState.isPublic ? 'text-amber-400' : 'text-sky-400'
                  }`}
                >
                  {peekState.isPublic
                    ? '👁️ 山札の上からめくったカード（相手にも見せています）'
                    : '🔒 山札の上からめくったカード（あなただけ見えています）'}
                </h3>
                <p className="text-xs text-slate-400">
                  手札に加える・場に出す・マナや墓地に置くカードを選び、残りを山札の下（または上）に戻してください
                </p>
              </div>
              {!peekState.isPublic && me && (
                <button
                  onClick={async () => {
                    setPeekState({ ...peekState, isPublic: true });
                    await applyRoomUpdate((cur) => ({
                      ...cur,
                      inspectingText: `${me.name} が山札の上から ${peekState.cards.length} 枚を公開中！`,
                      publicReveal: {
                        playerName: me.name,
                        cards: peekState.cards,
                      },
                    }));
                  }}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 rounded-lg text-xs font-extrabold"
                >
                  👁️ 相手にも見せる
                </button>
              )}
            </div>

            <div className="overflow-y-auto grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3 py-1">
              {peekState.cards.map((c, idx) => (
                <div
                  key={c.instanceId}
                  className="bg-slate-800 border border-slate-600 rounded-xl p-2 flex flex-col items-center space-y-1.5"
                >
                  <div className="text-[10px] text-slate-400 font-bold">上から {idx + 1} 枚目</div>
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.imageUrl}
                      alt={c.name}
                      onClick={() => setInspectCard({ card: c, ownerName: me?.name || '自分' })}
                      className="w-24 h-34 object-contain bg-slate-950 rounded border border-slate-500 cursor-pointer"
                    />
                  ) : (
                    <div className="w-24 h-34 bg-slate-700 rounded flex items-center justify-center text-xs text-center p-1">
                      {c.name}
                    </div>
                  )}
                  <div className="text-[11px] font-bold text-center truncate w-full">{c.name}</div>
                  <button
                    onClick={() => handleMoveFromPeek(c, 'hand')}
                    className="w-full py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-[11px] font-bold"
                  >
                    手札に加える
                  </button>
                  <button
                    onClick={() => handleMoveFromPeek(c, 'battleZone')}
                    className="w-full py-1 bg-amber-600 hover:bg-amber-500 rounded text-[11px] font-bold"
                  >
                    場に出す
                  </button>
                  <div className="grid grid-cols-2 gap-1 w-full">
                    <button
                      onClick={() => handleMoveFromPeek(c, 'mana')}
                      className="py-1 bg-lime-700 hover:bg-lime-600 rounded text-[10px] font-bold"
                    >
                      マナへ
                    </button>
                    <button
                      onClick={() => handleMoveFromPeek(c, 'graveyard')}
                      className="py-1 bg-rose-800 hover:bg-rose-700 rounded text-[10px] font-bold"
                    >
                      墓地へ
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-700">
              <button
                onClick={() => handleFinishPeek('bottom')}
                className="py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-bold"
              >
                残りを山札の下に戻す（終了）
              </button>
              <button
                onClick={() => handleFinishPeek('top')}
                className="py-2.5 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-xs font-bold"
              >
                残りを山札の上に戻す（終了）
              </button>
              <button
                onClick={() => handleFinishPeek('graveyard')}
                className="py-2.5 bg-rose-800 hover:bg-rose-700 rounded-lg text-xs font-bold"
              >
                残りを墓地に置く（終了）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 自分のカード超拡大＆全ゾーン万能移動モーダル ================= */}
      {!isSpectator && selectedCard && (
        <div
          onClick={() => setSelectedCard(null)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-2 sm:p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-slate-500 rounded-2xl p-3 sm:p-4 max-w-md w-full max-h-[95vh] overflow-y-auto space-y-2.5 shadow-2xl"
          >
            {(selectedCard.card.kindanRole &&
            selectedCard.card.kindanAwakened &&
            selectedCard.card.kindanAwakenedImageUrl
              ? selectedCard.card.kindanAwakenedImageUrl
              : selectedCard.card.imageUrl) && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={
                    selectedCard.card.kindanRole &&
                    selectedCard.card.kindanAwakened &&
                    selectedCard.card.kindanAwakenedImageUrl
                      ? selectedCard.card.kindanAwakenedImageUrl
                      : selectedCard.card.imageUrl
                  }
                  alt={selectedCard.card.name}
                  className="w-[78vw] max-w-[350px] h-[46vh] max-h-[420px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-xl"
                />
              </div>
            )}

            <div className="text-center space-y-1">
              <h3 className="font-bold text-base text-amber-400">{selectedCard.card.name}</h3>
              {selectedCard.zone === 'shields' && selectedCard.shieldSlotIndex !== undefined && (
                <div className="inline-block px-2.5 py-0.5 rounded bg-amber-500/20 border border-amber-400 text-[11px] font-extrabold text-amber-300">
                  対象：{selectedCard.card.shieldOverlaySlot || `S${selectedCard.shieldSlotIndex + 1}`}
                </div>
              )}
              {selectedCard.card.kindanRole && (
                <div className="inline-block px-3 py-1 rounded-full bg-rose-950 border border-rose-500 text-xs font-extrabold text-amber-300">
                  現在の封印：{selectedCard.card.underCards?.length || 0} 枚
                </div>
              )}
              {selectedCard.zone === 'mana' && mana.length > 1 && (
                <div className="flex flex-wrap justify-center gap-1 mt-1.5 py-1">
                  {mana.map((m) => (
                    <button
                      key={m.instanceId}
                      onClick={() => setSelectedCard({ card: m, zone: 'mana' })}
                      className={`px-2 py-1 rounded text-[10px] border ${
                        m.instanceId === selectedCard.card.instanceId
                          ? 'bg-lime-600 border-white font-bold'
                          : 'bg-slate-700 border-slate-600'
                      }`}
                    >
                      {m.name.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedCard.card.kindanRole && (
              <div className="bg-rose-950/70 border border-rose-500/60 rounded-xl p-2.5 space-y-2">
                <div className="text-[11px] font-bold text-rose-200 text-center">
                  🔥 禁断・封印コントロール（コマンド召喚時などに1枚ずつ外します）
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-extrabold">
                  <button
                    onClick={() => handleRemoveOneSeal(selectedCard.card)}
                    disabled={(selectedCard.card.underCards?.length || 0) === 0}
                    className="py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 rounded-lg"
                  >
                    🔓 封印を1枚外す（墓地へ）
                  </button>
                  <button
                    onClick={() => handleAddOneSealFromDeck(selectedCard.card)}
                    disabled={deck.length === 0}
                    className="py-2.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg"
                  >
                    🔒 山札から封印を1枚乗せる
                  </button>
                </div>
                <button
                  onClick={() => handleToggleKindanAwaken(selectedCard.card)}
                  className={`w-full py-2.5 rounded-lg text-xs sm:text-sm font-extrabold transition ${
                    selectedCard.card.kindanAwakened
                      ? 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                      : 'bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white shadow-lg'
                  }`}
                >
                  {selectedCard.card.kindanAwakened
                    ? '↩️ 鼓動状態（封印面）に戻す'
                    : selectedCard.card.kindanRole === 'dokindam'
                    ? '🔥 禁断解放！（伝説の禁断 ドキンダムXに裏返す）'
                    : '💀 禁断爆発！（終焉の禁断 ドルマゲドンXに裏返す）'}
                </button>

                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-rose-500/30 text-[11px] font-bold">
                  <label className="py-1.5 px-2 bg-sky-700 hover:bg-sky-600 text-white rounded-lg text-center cursor-pointer">
                    📷 鼓動面(表)画像
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        handleUploadKindanImageInRoom(
                          selectedCard.card,
                          'front',
                          e.target.files?.[0]
                        )
                      }
                    />
                  </label>
                  <label className="py-1.5 px-2 bg-amber-600 hover:bg-amber-500 text-slate-950 rounded-lg text-center cursor-pointer font-extrabold">
                    📷 解放後(裏)画像
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        handleUploadKindanImageInRoom(
                          selectedCard.card,
                          'back',
                          e.target.files?.[0]
                        )
                      }
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-xs font-bold">
              {selectedCard.zone === 'shields' && (
                <button
                  onClick={() => {
                    const c = selectedCard.card;
                    const idx = selectedCard.shieldSlotIndex;
                    setSelectedCard(null);
                    handleBreakShield(c, idx);
                  }}
                  className="py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded col-span-2 text-sm font-extrabold"
                >
                  💥 このシールドをブレイク（手札に加える）
                </button>
              )}

              {selectedCard.zone === 'hand' && (
                <>
                  <button
                    onClick={() => moveCard(selectedCard.card, 'hand', 'mana')}
                    className="py-2.5 bg-lime-600 hover:bg-lime-500 rounded"
                  >
                    マナに置く
                  </button>
                  <button
                    onClick={() => moveCard(selectedCard.card, 'hand', 'battleZone')}
                    className="py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded"
                  >
                    場に出す（召喚）
                  </button>
                  <button
                    onClick={() => {
                      setEvolutionBuilder({
                        evolvingCard: selectedCard.card,
                        fromZone: 'hand',
                        activeTab: normalBattleZone.length > 0 ? 'battleZone' : 'mana',
                        selectedMaterials: [],
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-purple-600 hover:bg-purple-500 rounded"
                  >
                    🧬 進化（下敷き自由選択）
                  </button>
                  <button
                    onClick={() => {
                      setRevolutionChangePending({
                        card: selectedCard.card,
                        fromZone: 'hand',
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-fuchsia-600 hover:bg-fuchsia-500 rounded"
                  >
                    🔄 革命チェンジ
                  </button>
                  <button
                    onClick={async () => {
                      const c = selectedCard.card;
                      await moveCard(c, 'hand', 'graveyard', true, undefined, {
                        type: 'ability',
                        playerName: me?.name || '自分',
                        card: c,
                        subText: '呪文を詠唱！',
                      });
                      if (soundEnabledRef.current) {
                        playGameSound('spell');
                      }
                    }}
                    className="py-2 bg-sky-600 hover:bg-sky-500 rounded col-span-2"
                  >
                    ✨ 呪文を唱える（提示→墓地）
                  </button>
                </>
              )}

              {selectedCard.zone === 'mana' && (
                <>
                  <button
                    onClick={() => moveCard(selectedCard.card, 'mana', 'battleZone')}
                    className="py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded col-span-2"
                  >
                    マナから場に出す（召喚）
                  </button>
                  <button
                    onClick={() => {
                      setEvolutionBuilder({
                        evolvingCard: selectedCard.card,
                        fromZone: 'mana',
                        activeTab: normalBattleZone.length > 0 ? 'battleZone' : 'mana',
                        selectedMaterials: [],
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-purple-600 hover:bg-purple-500 rounded"
                  >
                    🧬 マナから進化
                  </button>
                  <button
                    onClick={() => {
                      setRevolutionChangePending({
                        card: selectedCard.card,
                        fromZone: 'mana',
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-fuchsia-600 hover:bg-fuchsia-500 rounded"
                  >
                    🔄 マナからチェンジ
                  </button>
                  <button
                    onClick={() => toggleTap(selectedCard.card, 'mana')}
                    className="py-2 bg-sky-600 hover:bg-sky-500 rounded col-span-2"
                  >
                    {selectedCard.card.tapped ? 'アンタップ(起こす)' : 'タップ(横にする)'}
                  </button>
                </>
              )}

              {selectedCard.zone === 'battleZone' && (
                <>
                  <button
                    onClick={() => handleAttackDeclare(selectedCard.card)}
                    className="py-2.5 bg-rose-600 hover:bg-rose-500 rounded col-span-2 text-sm"
                  >
                    🔥 攻撃する（タップ＆カード提示）
                  </button>
                  <button
                    onClick={() => handleDeclareDirectAttack(selectedCard.card)}
                    className="py-2 bg-gradient-to-r from-red-600 to-amber-500 hover:from-red-500 hover:to-amber-400 text-white rounded col-span-2 text-xs font-extrabold"
                  >
                    💥 ダイレクトアタック！（決着の一撃！）
                  </button>
                  <button
                    onClick={() => toggleTap(selectedCard.card, 'battleZone')}
                    className="py-2 bg-sky-600 hover:bg-sky-500 rounded"
                  >
                    {selectedCard.card.tapped ? 'アンタップ(起こす)' : 'タップ(横にする)'}
                  </button>
                  <button
                    onClick={async () => {
                      const c = selectedCard.card;
                      setSelectedCard(null);
                      if (me) {
                        await applyRoomUpdate(
                          (cur) => cur,
                          {
                            cutIn: {
                              type: 'ability',
                              playerName: me.name,
                              card: c,
                              subText: '能力発動！',
                            },
                          }
                        );
                      }
                    }}
                    className="py-2 bg-cyan-600 hover:bg-cyan-500 rounded"
                  >
                    ⚡ 能力発動でカード提示
                  </button>
                  <button
                    onClick={() => handleToggleMyIgnore(selectedCard.card)}
                    className={`py-2 rounded col-span-2 font-extrabold border transition ${
                      selectedCard.card.ignored
                        ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 border-yellow-200'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-500'
                    }`}
                  >
                    {selectedCard.card.ignored
                      ? '☀️ 元の明るさに戻す（行動不能・無視を解除）'
                      : '🌑 暗くする（攻撃・ブロック不可／無視の目印）'}
                  </button>
                </>
              )}
            </div>

            {selectedCard.zone === 'battleZone' &&
              !selectedCard.card.kindanRole &&
              (selectedCard.card.underCards?.length || 0) > 0 && (
                <div className="pt-2 border-t border-purple-500/40 space-y-1.5">
                  <div className="text-[11px] font-bold text-purple-300">
                    下に重なっている進化元 ({selectedCard.card.underCards?.length}枚)
                  </div>
                  <div className="space-y-1">
                    {selectedCard.card.underCards?.map((u) => (
                      <div
                        key={u.instanceId}
                        className="flex items-center justify-between bg-slate-800 p-1.5 rounded text-xs"
                      >
                        <button
                          onClick={() =>
                            setInspectCard({ card: u, ownerName: me?.name || '自分' })
                          }
                          className="truncate font-bold text-left underline"
                        >
                          {u.name}
                        </button>
                        <div className="flex gap-1 shrink-0 text-[10px]">
                          <button
                            onClick={() =>
                              handleExtractUnderCard(selectedCard.card, u, 'graveyard')
                            }
                            className="px-2 py-0.5 bg-rose-800 rounded"
                          >
                            墓地へ
                          </button>
                          <button
                            onClick={() =>
                              handleExtractUnderCard(selectedCard.card, u, 'hand')
                            }
                            className="px-2 py-0.5 bg-slate-700 rounded"
                          >
                            手札へ
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {!selectedCard.card.kindanRole && (
              <div className="pt-2 border-t border-slate-700 space-y-2">
                <div className="text-[10px] text-slate-400 text-center">
                  このカードを別の場所へ送る
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-[11px] font-bold">
                  {selectedCard.zone !== 'hand' && (
                    <button
                      onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'hand')}
                      className="py-2 bg-slate-700 hover:bg-slate-600 rounded"
                    >
                      手札へ
                    </button>
                  )}
                  {selectedCard.zone !== 'battleZone' &&
                    selectedCard.zone !== 'hand' &&
                    selectedCard.zone !== 'mana' && (
                      <button
                        onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'battleZone')}
                        className="py-2 bg-amber-600 hover:bg-amber-500 rounded"
                      >
                        場へ出す
                      </button>
                    )}
                  {selectedCard.zone !== 'mana' && selectedCard.zone !== 'hand' && (
                    <button
                      onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'mana')}
                      className="py-2 bg-lime-700 hover:bg-lime-600 rounded"
                    >
                      マナへ
                    </button>
                  )}
                  {selectedCard.zone !== 'graveyard' && (
                    <button
                      onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'graveyard')}
                      className="py-2 bg-rose-800 hover:bg-rose-700 rounded"
                    >
                      墓地へ
                    </button>
                  )}
                  {selectedCard.zone !== 'shields' && (
                    <button
                      onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'shields')}
                      className="py-2 bg-amber-800 hover:bg-amber-700 rounded"
                    >
                      シールドへ(裏)
                    </button>
                  )}
                  <button
                    onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'deckTop')}
                    className="py-2 bg-indigo-800 hover:bg-indigo-700 rounded"
                  >
                    山札の上へ
                  </button>
                  <button
                    onClick={() => moveCard(selectedCard.card, selectedCard.zone, 'deckBottom')}
                    className="py-2 bg-indigo-900 hover:bg-indigo-800 rounded"
                  >
                    山札の下へ
                  </button>
                </div>

                {/* シールドに表向きで乗せる（S1〜S5表記付き） */}
                <div className="bg-amber-950/50 border border-amber-500/40 rounded-lg p-2 space-y-1.5">
                  <div className="text-[10px] font-bold text-amber-300 text-center">
                    🛡️ 表向きシールドとして乗せる（どの盾の上かS1〜S5表記）
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-[11px] font-extrabold">
                    {shieldSlotChoices.map((slot) => (
                      <button
                        key={slot}
                        type="button"
                        onClick={() =>
                          moveCard(
                            selectedCard.card,
                            selectedCard.zone,
                            'shieldsFaceUp',
                            false,
                            slot
                          )
                        }
                        className="py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded transition"
                      >
                        {slot}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={() => setSelectedCard(null)}
              className="w-full py-2 bg-slate-800 rounded text-xs text-slate-300 font-bold"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ================= 自由進化ビルダー ================= */}
      {!isSpectator && evolutionBuilder && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-slate-900 border-2 border-purple-500 rounded-2xl p-4 max-w-3xl w-full max-h-[92vh] flex flex-col space-y-3 shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-bold text-sm sm:text-base text-purple-300">
                  🧬 「{evolutionBuilder.evolvingCard.name}」の進化元（下に敷くカード）を選択
                </h3>
                <p className="text-[11px] text-slate-400">
                  場・マナ・墓地・手札・山札から複数枚（1枚〜何枚でも）選んで下に重ねられます
                </p>
              </div>
              <span className="px-2.5 py-1 bg-purple-700 rounded-lg text-xs font-extrabold shrink-0">
                選択中: {evolutionBuilder.selectedMaterials.length}枚
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5 border-b border-slate-700 pb-2 text-xs font-bold">
              {(
                [
                  { id: 'battleZone', label: `バトルゾーン (${normalBattleZone.length})` },
                  { id: 'mana', label: `マナ (${mana.length})` },
                  { id: 'graveyard', label: `墓地 (${graveyard.length})` },
                  { id: 'hand', label: `手札 (${hand.length})` },
                  { id: 'deck', label: `山札 (${deck.length})` },
                ] as { id: EvolutionSourceZone; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() =>
                    setEvolutionBuilder({ ...evolutionBuilder, activeTab: tab.id })
                  }
                  className={`px-3 py-1.5 rounded-lg transition ${
                    evolutionBuilder.activeTab === tab.id
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {evolutionBuilder.selectedMaterials.length > 0 && (
              <div className="bg-purple-950/60 border border-purple-500/40 rounded-lg p-2 flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] font-bold text-purple-300">下に重ねる順：</span>
                {evolutionBuilder.selectedMaterials.map((m, idx) => (
                  <button
                    key={m.card.instanceId}
                    onClick={() => toggleEvolutionMaterial(m.card, m.sourceZone)}
                    className="px-2 py-0.5 bg-purple-700 hover:bg-rose-700 rounded text-[11px] font-bold flex items-center gap-1"
                  >
                    <span>
                      {idx + 1}. {m.card.name}
                    </span>
                    <span className="text-[9px] opacity-80">✕</span>
                  </button>
                ))}
              </div>
            )}

            <div className="overflow-y-auto grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2.5 py-1 flex-1">
              {getEvolutionCandidates()
                .filter((c) => !c.kindanRole)
                .map((c) => {
                  const isSelected = evolutionBuilder.selectedMaterials.some(
                    (m) => m.card.instanceId === c.instanceId
                  );
                  return (
                    <div
                      key={c.instanceId}
                      onClick={() => toggleEvolutionMaterial(c, evolutionBuilder.activeTab)}
                      className={`cursor-pointer rounded-xl p-2 border-2 flex flex-col items-center space-y-1 transition ${
                        isSelected
                          ? 'bg-purple-900/70 border-purple-400 scale-[1.02]'
                          : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.imageUrl}
                          alt={c.name}
                          className="w-20 h-28 object-cover rounded border border-slate-600"
                        />
                      ) : (
                        <div className="w-20 h-28 bg-slate-700 rounded flex items-center justify-center text-xs text-center p-1">
                          {c.name}
                        </div>
                      )}
                      <div className="text-[11px] font-bold text-center truncate w-full">{c.name}</div>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${
                          isSelected ? 'bg-purple-500 text-white' : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {isSelected ? '✓ 選択中' : '選択する'}
                      </span>
                    </div>
                  );
                })}
              {getEvolutionCandidates().filter((c) => !c.kindanRole).length === 0 && (
                <p className="col-span-full text-center text-xs text-slate-400 py-8">
                  このゾーンに選択できるカードがありません
                </p>
              )}
            </div>

            <div className="flex gap-2 pt-2 border-t border-slate-700">
              <button
                onClick={() => setEvolutionBuilder(null)}
                className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-xs font-bold"
              >
                キャンセル
              </button>
              <button
                onClick={handleConfirmFreeEvolution}
                disabled={evolutionBuilder.selectedMaterials.length === 0 || isEvolvingBusy}
                className="flex-[2] py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-800 disabled:text-slate-500 rounded-xl text-xs sm:text-sm font-extrabold"
              >
                🧬 選んだ {evolutionBuilder.selectedMaterials.length} 枚の上に進化して場に出す！
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 革命チェンジ 対象選択モーダル ================= */}
      {!isSpectator && revolutionChangePending && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border-2 border-fuchsia-500 rounded-xl p-4 max-w-md w-full space-y-3">
            <h3 className="font-bold text-sm text-white">
              🔄 「{revolutionChangePending.card.name}」と革命チェンジする場のキャラを選択（手札に戻ります）
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {normalBattleZone.map((c) => (
                <button
                  key={c.instanceId}
                  onClick={() => handleExecuteRevolutionChange(c)}
                  className="p-2 rounded text-xs font-bold flex items-center gap-2 bg-fuchsia-700 hover:bg-fuchsia-600"
                >
                  {c.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                  )}
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
              {normalBattleZone.length === 0 && (
                <p className="text-xs text-slate-400 col-span-2 py-3 text-center">
                  バトルゾーンにキャラがいません
                </p>
              )}
            </div>
            <button
              onClick={() => setRevolutionChangePending(null)}
              className="w-full py-2 bg-slate-700 rounded text-xs font-bold"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* ================= 山札全確認モーダル ================= */}
      {!isSpectator && deckSearchOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-4 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm">山札の中身（送り先を選んでください）</h3>
              <button
                onClick={() => setDeckSearchOpen(false)}
                className="px-3 py-1 bg-slate-700 rounded text-xs"
              >
                閉じる
              </button>
            </div>
            <div className="overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
              {deck.map((c) => (
                <div
                  key={c.instanceId}
                  className="p-2 bg-slate-900 border border-slate-700 rounded flex items-center justify-between gap-2"
                >
                  <div
                    onClick={() => setInspectCard({ card: c, ownerName: me?.name || '自分' })}
                    className="flex items-center gap-2 min-w-0 cursor-pointer"
                  >
                    {c.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                    )}
                    <div className="font-bold text-xs truncate underline">{c.name}</div>
                  </div>
                  <div className="flex flex-wrap gap-1 shrink-0 text-[10px] font-bold">
                    <button
                      onClick={() => handleMoveFromDeckSearch(c, 'hand')}
                      className="px-2 py-1 bg-sky-600 hover:bg-sky-500 rounded"
                    >
                      手札
                    </button>
                    <button
                      onClick={() => handleMoveFromDeckSearch(c, 'battleZone')}
                      className="px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded"
                    >
                      場
                    </button>
                    <button
                      onClick={() => handleMoveFromDeckSearch(c, 'mana')}
                      className="px-2 py-1 bg-lime-700 hover:bg-lime-600 rounded"
                    >
                      マナ
                    </button>
                    <button
                      onClick={() => handleMoveFromDeckSearch(c, 'graveyard')}
                      className="px-2 py-1 bg-rose-800 hover:bg-rose-700 rounded"
                    >
                      墓地
                    </button>
                    <button
                      onClick={() => handleMoveFromDeckSearch(c, 'shields')}
                      className="px-2 py-1 bg-amber-800 hover:bg-amber-700 rounded"
                    >
                      盾
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ================= 自分の墓地全確認モーダル ================= */}
      {graveSearchOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-rose-500/60 rounded-xl p-4 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm text-rose-300">
                {me?.name || '自分'}の墓地の中身 ({graveyard.length}枚)
              </h3>
              <button
                onClick={() => setGraveSearchOpen(false)}
                className="px-3 py-1 bg-slate-700 rounded text-xs"
              >
                閉じる
              </button>
            </div>
            {graveyard.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">墓地にカードはありません</p>
            ) : (
              <div className="overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                {graveyard.map((c) => (
                  <div
                    key={c.instanceId}
                    className="p-2 bg-slate-900 border border-slate-700 rounded flex items-center justify-between gap-2"
                  >
                    <div
                      onClick={() => setInspectCard({ card: c, ownerName: me?.name || '自分' })}
                      className="flex items-center gap-2 min-w-0 cursor-pointer"
                    >
                      {c.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                      )}
                      <div className="font-bold text-xs truncate underline">{c.name}</div>
                    </div>
                    {!isSpectator && (
                      <div className="flex flex-wrap gap-1 shrink-0 text-[10px] font-bold">
                        <button
                          onClick={() => moveCard(c, 'graveyard', 'hand')}
                          className="px-2 py-1 bg-sky-600 hover:bg-sky-500 rounded"
                        >
                          手札
                        </button>
                        <button
                          onClick={() => moveCard(c, 'graveyard', 'battleZone')}
                          className="px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded"
                        >
                          場
                        </button>
                        <button
                          onClick={() => {
                            setGraveSearchOpen(false);
                            setEvolutionBuilder({
                              evolvingCard: c,
                              fromZone: 'graveyard',
                              activeTab: normalBattleZone.length > 0 ? 'battleZone' : 'graveyard',
                              selectedMaterials: [],
                            });
                          }}
                          className="px-2 py-1 bg-purple-600 hover:bg-purple-500 rounded"
                        >
                          進化
                        </button>
                        <button
                          onClick={() => moveCard(c, 'graveyard', 'mana')}
                          className="px-2 py-1 bg-lime-700 hover:bg-lime-600 rounded"
                        >
                          マナ
                        </button>
                        <button
                          onClick={() => moveCard(c, 'graveyard', 'deckBottom')}
                          className="px-2 py-1 bg-indigo-800 hover:bg-indigo-700 rounded"
                        >
                          山札下
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= 相手（プレイヤー1）の墓地確認モーダル ================= */}
      {oppGraveViewOpen && opponent && (
        <div
          onClick={() => setOppGraveViewOpen(false)}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-800 border border-rose-500/60 rounded-xl p-4 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-3"
          >
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm text-rose-300">
                {opponent.name}の墓地 ({oppGraveyard.length}枚)
              </h3>
              <button
                onClick={() => setOppGraveViewOpen(false)}
                className="px-3 py-1 bg-slate-700 rounded text-xs"
              >
                閉じる
              </button>
            </div>
            {oppGraveyard.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">墓地にカードはありません</p>
            ) : (
              <div className="overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                {oppGraveyard.map((c) => (
                  <div
                    key={c.instanceId}
                    onClick={() => setInspectCard({ card: c, ownerName: opponent.name })}
                    className="p-2 bg-slate-900 border border-slate-700 hover:border-amber-400 rounded flex items-center gap-2 cursor-pointer"
                  >
                    {c.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                    )}
                    <div className="font-bold text-xs truncate underline">{c.name}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BattleRoomPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
          対戦ルームを読み込み中...
        </div>
      }
    >
      <BattleRoomContent />
    </Suspense>
  );
}