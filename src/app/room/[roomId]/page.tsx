'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchCustomDeckById } from '@/lib/supabaseDecks';
import { uploadCardImageToSupabase } from '@/lib/supabaseStorage';
import { CardData, CardInstance, GameRoom, KindanType, PlayerState } from '@/types/game';
import CutInOverlay, { CutInEvent } from '@/components/CutInOverlay';
import { DirectAttackVideoOverlay, VideoCutInData } from '@/components/CutInOverlay';

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
  | 'evolve'
  | 'ability'
  | 'd2Switch'
  | 'spell'
  | 'kindanRelease'
  | 'okPikoon'
  | 'targetSelect'
  | 'customSe1'
  | 'customSe2';

type BattleCardInstance = CardInstance & {
  ignored?: boolean;
  shieldOverlaySlot?: string;
};

interface ShieldSlotData {
  slot: string;
  baseCard: BattleCardInstance | null;
  faceUpOverlays: BattleCardInstance[];
}

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

interface ActiveAttackTarget {
  id: string;
  attackerPlayerId: string;
  attackerPlayerName: string;
  attackerCardId?: string;
  attackerCardName: string;
  defenderPlayerId: string;
  shieldIds: string[];
  shieldSlots?: string[];
  creatureId?: string | null;
  isPreview?: boolean;
  timestamp: number;
}

interface PublicHandReveal {
  playerId: string;
  playerName: string;
  cards: BattleCardInstance[];
}

interface TurnBannerState {
  id: string;
  turnCount: number;
  turnPlayerName: string;
  isMyTurn: boolean;
}

interface TargetZoneCutIn {
  id: string;
  fromPlayerName: string;
  cardName: string;
  imageUrl: string;
  destinationLabel: string;
  timestamp: number;
}

type ExtendedRoom = GameRoom & {
  pendingDirectAttack?: PendingDirectAttack | null;
  attackTarget?: ActiveAttackTarget | null;
  soundEvent?: { id: string; type: SoundEventType; timestamp: number } | null;
  activeBgm?: {
    id: string;
    name: string;
    url: string;
    startedBy: string;
    timestamp: number;
  } | null;
  inspectingText?: string | null;
  cutIn?: CutInEvent | null;
  targetZoneCutIn?: TargetZoneCutIn | null;
  publicReveal?: {
    playerName: string;
    cards: BattleCardInstance[];
  } | null;
  publicHandReveal?: PublicHandReveal | null;
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

const SOUND_FILE_CANDIDATES: Partial<Record<SoundEventType, string[]>> = {
  shieldBreak: ['/sounds/shield.mp3', '/sounds/ガラスが割れる1.mp3', '/sounds/ガラスが割れる1.mp3.mp3'],
  summon: ['/sounds/summon.mp3', '/sounds/シャキーン1.mp3', '/sounds/シャキーン1.mp3.mp3'],
  evolve: ['/sounds/cannon.mp3', '/sounds/summon.mp3'],
  ability: ['/sounds/shot.mp3', '/sounds/シャキーン1.mp3'],
  d2Switch: ['/sounds/d2_switch.mp3', '/sounds/魔法陣を展開.mp3'],
  block: ['/sounds/block.mp3'],
  revZeroTrigger: ['/sounds/rev0.mp3', '/sounds/summon.mp3', '/sounds/シャキーン1.mp3', '/sounds/シャキーン1.mp3.mp3'],
  directAttack: ['/sounds/direct.mp3', '/sounds/爆発2.mp3', '/sounds/爆発2.mp3.mp3'],
  spell: ['/sounds/spell.mp3', '/sounds/魔法陣を展開.mp3', '/sounds/魔法陣を展開.mp3.mp3'],
  kindanRelease: ['/sounds/kindan.mp3', '/sounds/地響き.mp3', '/sounds/地響き.mp3.mp3'],
  attack: ['/sounds/attack.mp3', '/sounds/大パンチ.mp3', '/sounds/大パンチ.mp3.mp3'],
  customSe1: ['/sounds/se1.mp3', '/sounds/shot.mp3'],
  customSe2: ['/sounds/se2.mp3', '/sounds/cannon.mp3'],
};

const QUICK_SOUND_BUTTONS: { label: string; sound: SoundEventType }[] = [
  { label: '💡 ピコーン！(OK)', sound: 'okPikoon' },
  { label: '💥 ビーム', sound: 'ability' },
  { label: '💣 大砲', sound: 'evolve' },
  { label: '🛡️ ブロック', sound: 'block' },
  { label: '🔥 革命0', sound: 'revZeroTrigger' },
  { label: '🌀 D2スイッチ', sound: 'd2Switch' },
];



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
    } else if (type === 'okPikoon') {
      [659.25, 987.77].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.001, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.28, now + idx * 0.08 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.36);
      });
    } else if (type === 'targetSelect') {
      [880, 1174.66].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.06);
        gain.gain.setValueAtTime(0.001, now + idx * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.25, now + idx * 0.06 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.06 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.06);
        osc.stop(now + idx * 0.06 + 0.26);
      });
    } else if (type === 'block') {
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

function playGameSound(type: SoundEventType) {
  try {
    const nowMs = Date.now();
    if (lastGlobalSoundType === type && nowMs - lastGlobalSoundTime < 450) {
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

function assignInitialShieldSlots(cards: BattleCardInstance[]): BattleCardInstance[] {
  return cards.map((c, idx) => ({
    ...c,
    faceUp: false,
    tapped: false,
    ignored: false,
    shieldOverlaySlot: c.shieldOverlaySlot || `S${idx + 1}`,
  }));
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

// シールド配列を S1, S2, S3, S4, S5... のスロット構造に変換（3を削っても1, 2, [3空き], 4, 5の位置・番号を厳密に保持）
function buildShieldSlots(shieldList: BattleCardInstance[]): ShieldSlotData[] {
  const slotMap = new Map<string, ShieldSlotData>();

  const ensureSlot = (slotName: string): ShieldSlotData => {
    if (!slotMap.has(slotName)) {
      slotMap.set(slotName, {
        slot: slotName,
        baseCard: null,
        faceUpOverlays: [],
      });
    }
    return slotMap.get(slotName)!;
  };

  for (let i = 1; i <= 5; i++) {
    ensureSlot(`S${i}`);
  }

  const unassignedBase: BattleCardInstance[] = [];
  const unassignedOverlays: BattleCardInstance[] = [];

  shieldList.forEach((c) => {
    const rawSlot = c.shieldOverlaySlot;
    if (rawSlot && /^S\d+$/.test(rawSlot)) {
      const entry = ensureSlot(rawSlot);
      if (c.faceUp) {
        entry.faceUpOverlays.push(c);
      } else if (!entry.baseCard) {
        entry.baseCard = c;
      } else {
        unassignedBase.push(c);
      }
    } else if (c.faceUp) {
      unassignedOverlays.push(c);
    } else {
      unassignedBase.push(c);
    }
  });

  // スロット番号未指定のカードがある場合のみ、空いている枠（またはS6以降）に割り当てる
  unassignedBase.forEach((c) => {
    const emptySlot = Array.from(slotMap.values()).find(
      (s) => !s.baseCard && s.faceUpOverlays.length === 0
    );
    if (emptySlot) {
      emptySlot.baseCard = { ...c, shieldOverlaySlot: emptySlot.slot };
    } else {
      const nextNum = slotMap.size + 1;
      const created = ensureSlot(`S${nextNum}`);
      created.baseCard = { ...c, shieldOverlaySlot: created.slot };
    }
  });

  unassignedOverlays.forEach((c) => {
    const targetSlot =
      Array.from(slotMap.values()).find((s) => !!s.baseCard) ||
      Array.from(slotMap.values()).find((s) => s.faceUpOverlays.length === 0) ||
      ensureSlot('S1');
    targetSlot.faceUpOverlays.push({ ...c, shieldOverlaySlot: targetSlot.slot });
  });

  return Array.from(slotMap.values()).sort((a, b) => {
    const numA = parseInt(a.slot.replace(/^S/, ''), 10) || 0;
    const numB = parseInt(b.slot.replace(/^S/, ''), 10) || 0;
    return numA - numB;
  });
}

function getNextEmptyOrNewSlot(shieldList: BattleCardInstance[]): string {
  const slots = buildShieldSlots(shieldList);
  const emptyExisting = slots.find((s) => !s.baseCard && s.faceUpOverlays.length === 0);
  if (emptyExisting) return emptyExisting.slot;
  return `S${slots.length + 1}`;
}

function isD2FieldCard(card: Partial<CardInstance> | null | undefined): boolean {
  if (!card) return false;
  return !!card.isD2Field || card.type === 'field';
}

async function fetchRoomState(roomId: string): Promise<ExtendedRoom | null> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('room_id', roomId)
    .maybeSingle();
  if (error) {
    console.error('fetchRoomState error:', error);
    return null;
  }
  if (!data) return null;
  return (data.state ?? data) as ExtendedRoom;
}

async function saveRoomState(roomId: string, state: ExtendedRoom): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .upsert(
      { room_id: roomId, state, updated_at: new Date().toISOString() },
      { onConflict: 'room_id' }
    );
  if (error) {
    console.error('saveRoomState error:', error);
  }
}

async function deleteRoomRow(roomId: string): Promise<void> {
  const { error } = await supabase.from('rooms').delete().eq('room_id', roomId);
  if (error) {
    console.error('deleteRoomRow error:', error);
  }
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
  const [soundBoardOpen, setSoundBoardOpen] = useState<boolean>(false);
  const [directAttackModalOpen, setDirectAttackModalOpen] = useState<boolean>(false);
  const [defenseSubMode, setDefenseSubMode] = useState<'main' | 'revZero' | 'blocker'>('main');
const [targetBlockModalOpen, setTargetBlockModalOpen] = useState<boolean>(false);

  // モーダル内の表示回転角度（反時計回りに -90° ずつ）
  const [inspectRotationDeg, setInspectRotationDeg] = useState<number>(0);
  const [selectedRotationDeg, setSelectedRotationDeg] = useState<number>(0);

  // 相手クリーチャータップ時の「このクリーチャーを選択」枝分かれメニュー開閉
  const [showTargetMoveMenu, setShowTargetMoveMenu] = useState<boolean>(false);

  // 相手から指定されたカードの大きなカットイン通知
  const [activeTargetZoneCutIn, setActiveTargetZoneCutIn] = useState<TargetZoneCutIn | null>(null);
  const prevTargetZoneCutInIdRef = useRef<string | null>(null);

  // BGM管理（マイBGM選択 → 自分＆相手の画面でリアルタイム同期再生・停止）
  const [myBgmList, setMyBgmList] = useState<{ id: string; name: string; url: string }[]>([]);
  const [bgmVolume, setBgmVolume] = useState<number>(0.3);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentPlayingBgmKeyRef = useRef<string>('');

  useEffect(() => {
    import('@/lib/customBgm')
      .then(({ fetchCustomBgms }) => fetchCustomBgms())
      .then((list) => {
        setMyBgmList(list);
      })
      .catch(() => {});
  }, []);

  // room.activeBgm の変化を監視して自分と相手のブラウザで自動再生＆停止
  useEffect(() => {
    const activeBgm = room?.activeBgm;

    if (!activeBgm || !activeBgm.url) {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
        bgmAudioRef.current.src = '';
        bgmAudioRef.current = null;
      }
      currentPlayingBgmKeyRef.current = '';
      return;
    }

    const playKey = `${activeBgm.id}-${activeBgm.timestamp}`;
    if (currentPlayingBgmKeyRef.current === playKey && bgmAudioRef.current) {
      return;
    }

    if (bgmAudioRef.current) {
      bgmAudioRef.current.pause();
      bgmAudioRef.current.src = '';
    }

    const audio = new Audio(activeBgm.url);
    audio.loop = false;
    audio.volume = bgmVolume;
    audio.onended = () => {
      bgmAudioRef.current = null;
      currentPlayingBgmKeyRef.current = '';
      if (!isSpectator) {
        applyRoomUpdate(
          (cur) => {
            if (!cur.activeBgm) return cur;
            return {
              ...cur,
              activeBgm: null,
            };
          },
          undefined,
          true
        ).catch(() => {});
      }
    };
    audio.play().catch((err) => {
      console.warn('BGM再生待機（画面タップ後に再生されます）:', err);
    });

    bgmAudioRef.current = audio;
    currentPlayingBgmKeyRef.current = playKey;
  }, [room?.activeBgm]);

  useEffect(() => {
    if (bgmAudioRef.current) {
      bgmAudioRef.current.volume = bgmVolume;
    }
  }, [bgmVolume]);

  useEffect(() => {
    return () => {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
        bgmAudioRef.current.src = '';
        bgmAudioRef.current = null;
      }
    };
  }, []);

  const handleSelectRoomBgm = async (selectedId: string) => {
    if (isSpectator) return;

    if (selectedId === 'off') {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
        bgmAudioRef.current.src = '';
        bgmAudioRef.current = null;
      }
      currentPlayingBgmKeyRef.current = '';
      await applyRoomUpdate(
        (cur) => ({
          ...cur,
          activeBgm: null,
        }),
        undefined,
        true
      );
      return;
    }

    const found = myBgmList.find((t) => t.id === selectedId);
    if (!found) return;

    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        activeBgm: {
          id: found.id,
          name: found.name,
          url: found.url,
          startedBy: me?.name || 'プレイヤー',
          timestamp: Date.now(),
        },
      }),
      undefined,
      true
    );
  };

  // ターン切り替わり視覚バナー
  const [turnBanner, setTurnBanner] = useState<TurnBannerState | null>(null);

  // シールドスロットタップ時の確認・ブレイクモーダル（裏盾＋重なり表盾を一覧表示）
  const [inspectedShieldSlot, setInspectedShieldSlot] = useState<{
    slot: string;
    isMine: boolean;
    ownerName: string;
    cards: BattleCardInstance[];
  } | null>(null);

  // シールド複数同時選択・チェックモード
  const [multiShieldSelectMode, setMultiShieldSelectMode] = useState<boolean>(false);
  const [selectedShieldIds, setSelectedShieldIds] = useState<string[]>([]);
  const [shieldCheckQueue, setShieldCheckQueue] = useState<BattleCardInstance[]>([]);

  // 手札公開モード（自分の手札から相手に見せるカードを選ぶ）
  const [handRevealModalOpen, setHandRevealModalOpen] = useState<boolean>(false);
  const [selectedRevealHandIds, setSelectedRevealHandIds] = useState<string[]>([]);

  // 墓地横並びモーダル内でタップされたカード
  const [selectedGraveCard, setSelectedGraveCard] = useState<BattleCardInstance | null>(null);

  // 攻撃先指定モード用state
  const [targetingAttacker, setTargetingAttacker] = useState<BattleCardInstance | null>(null);
  const [selectedTargetShieldIds, setSelectedTargetShieldIds] = useState<string[]>([]);
  const [selectedTargetCreatureId, setSelectedTargetCreatureId] = useState<string | null>(null);

  const roomRef = useRef<ExtendedRoom | null>(null);
  const myPlayerIdRef = useRef<string>('');
  const isSpectatorRef = useRef<boolean>(false);
  const isUpdatingRef = useRef<boolean>(false);
  const lastUpdateAtRef = useRef<number>(0);
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

  useEffect(() => {
    myPlayerIdRef.current = myPlayerId;
  }, [myPlayerId]);

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
  const [activeVideoCutIn, setActiveVideoCutIn] = useState<VideoCutInData | null>(null);
  const lastPlayedVideoCutInIdRef = useRef<string | null>(null);

  useEffect(() => {
    const cutIn = (room as any)?.latestVideoCutIn as VideoCutInData | undefined;
    if (!cutIn || !cutIn.id) return;
    if (lastPlayedVideoCutInIdRef.current === cutIn.id) return;

    lastPlayedVideoCutInIdRef.current = cutIn.id;
    setActiveVideoCutIn(cutIn);
  }, [(room as any)?.latestVideoCutIn]);
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

  useEffect(() => {
    setInspectRotationDeg(0);
    setShowTargetMoveMenu(false);
  }, [inspectCard]);

  useEffect(() => {
    setSelectedRotationDeg(0);
  }, [selectedCard]);

  useEffect(() => {
    const cutin = room?.targetZoneCutIn;
    if (!cutin || !cutin.id || cutin.id === prevTargetZoneCutInIdRef.current) return;
    const isInitial = prevTargetZoneCutInIdRef.current === null;
    prevTargetZoneCutInIdRef.current = cutin.id;
    if (isInitial && Date.now() - cutin.timestamp > 4000) return;

    setActiveTargetZoneCutIn(cutin);
    const timer = setTimeout(() => {
      setActiveTargetZoneCutIn(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [room?.targetZoneCutIn]);

  const triggerTurnBanner = useCallback((data: ExtendedRoom) => {
    const pid = myPlayerIdRef.current;
    const spectator = isSpectatorRef.current;
    const ownerName = data.players?.[data.turnPlayerId]?.name || 'プレイヤー';
    const mine = !spectator && !!pid && data.turnPlayerId === pid;
    const bannerId = `turn-${data.turnCount}-${data.turnPlayerId}`;
    setTurnBanner({
      id: bannerId,
      turnCount: data.turnCount || 1,
      turnPlayerName: ownerName,
      isMyTurn: mine,
    });
  }, []);

  useEffect(() => {
    if (!turnBanner) return;
    const timer = setTimeout(() => {
      setTurnBanner(null);
    }, 2200);
    return () => clearTimeout(timer);
  }, [turnBanner]);

  const applyRoomUpdate = useCallback(
    async (
      updater: (current: ExtendedRoom) => ExtendedRoom,
      meta?: RoomUpdateMeta,
      force = false
    ) => {
      if (!roomId) return;
      const now = Date.now();
      if (!force && (isUpdatingRef.current || now - lastUpdateAtRef.current < 350)) {
        return;
      }

      isUpdatingRef.current = true;
      lastUpdateAtRef.current = now;

      try {
        const latest = (await fetchRoomState(roomId)) ?? roomRef.current;
        if (!latest) return;

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

        if (soundEvent?.id) {
          prevSoundEventIdRef.current = soundEvent.id;
        }
        if (cutIn?.id) {
          prevCutInIdRef.current = cutIn.id;
        }

        if (meta?.sound && soundEnabledRef.current) {
          playGameSound(meta.sound);
        }

        roomRef.current = next;
        setRoom(next);
        await saveRoomState(roomId, next);
      } finally {
        isUpdatingRef.current = false;
      }
    },
    [roomId]
  );

  const setInspectingStatus = async (text: string | null, force = false) => {
    if (!roomId) return;
    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        inspectingText: text,
      }),
      undefined,
      force
    );
  };

  useEffect(() => {
    const savedId = localStorage.getItem('dm_player_id') || '';
    setMyPlayerId(savedId);
    myPlayerIdRef.current = savedId;

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

      const pIds = Object.keys(data.players || {});
      const participant = !!myPlayerIdRef.current && pIds.includes(myPlayerIdRef.current);
      isSpectatorRef.current = !participant || searchParams.get('spectate') === '1';

      if (
        prevTurnCountRef.current !== null &&
        prevTurnPlayerRef.current !== null &&
        (data.turnCount > prevTurnCountRef.current ||
          data.turnPlayerId !== prevTurnPlayerRef.current)
      ) {
        if (soundEnabledRef.current) {
          playGameSound('turnEnd');
        }
        triggerTurnBanner(data);
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
  }, [roomId, router, searchParams, triggerTurnBanner]);

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
  const activeAttackTarget = room.attackTarget || null;

  const amIDefendingDirectAttack =
    !isSpectator &&
    !!pendingDirectAttack &&
    pendingDirectAttack.defenderPlayerId === myPlayerId;
  const amIWaitingDirectAttack =
    !isSpectator &&
    !!pendingDirectAttack &&
    pendingDirectAttack.attackerPlayerId === myPlayerId;

  const amIDefendingTargetedAttack =
    !isSpectator &&
    !!activeAttackTarget &&
    activeAttackTarget.defenderPlayerId === myPlayerId;

const isTargetOfAttack = (
    cardInstanceId: string,
    zone: 'shields' | 'battleZone',
    isTargetSideMine: boolean,
    slotName?: string
  ): boolean => {
    if (!activeAttackTarget) return false;
    const expectedDefenderId = isTargetSideMine ? bottomPlayerId : topPlayerId;
    if (!expectedDefenderId || activeAttackTarget.defenderPlayerId !== expectedDefenderId) {
      return false;
    }
    if (zone === 'shields') {
      if (cardInstanceId && activeAttackTarget.shieldIds?.includes(cardInstanceId)) return true;
      if (slotName && activeAttackTarget.shieldSlots?.includes(slotName)) return true;
      return false;
    }
    return activeAttackTarget.creatureId === cardInstanceId;
  };

  // 選択中の攻撃先をリアルタイムで相手画面にも共有するヘルパー
  const syncTargetingPreviewToRoom = async (
    attacker: BattleCardInstance,
    nextShieldIds: string[],
    nextCreatureId: string | null
  ) => {
    if (!me || !myPlayerId || !topPlayerId || isSpectator) return;
    const shieldSlots = nextShieldIds
      .map((sid) => oppShields.find((s) => s.instanceId === sid)?.shieldOverlaySlot)
      .filter((v): v is string => !!v);

    const hasAny = nextShieldIds.length > 0 || !!nextCreatureId;
    const previewTarget: ActiveAttackTarget | null = hasAny
      ? {
          id: `preview-${attacker.instanceId}`,
          attackerPlayerId: myPlayerId,
          attackerPlayerName: me.name,
          attackerCardId: attacker.instanceId,
          attackerCardName: attacker.name,
          defenderPlayerId: topPlayerId,
          shieldIds: nextShieldIds,
          shieldSlots,
          creatureId: nextCreatureId,
          isPreview: true,
          timestamp: Date.now(),
        }
      : null;

    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        attackTarget: previewTarget,
      }),
      undefined,
      true
    );
  };

  const openAttackTargeting = (attacker: BattleCardInstance) => {
    setSelectedCard(null);
    setMultiShieldSelectMode(false);
    setSelectedShieldIds([]);
    setTargetingAttacker(attacker);
    setSelectedTargetShieldIds([]);
    setSelectedTargetCreatureId(null);
  };

  const cancelAttackTargeting = async () => {
    const hadTarget = !!targetingAttacker;
    setTargetingAttacker(null);
    setSelectedTargetShieldIds([]);
    setSelectedTargetCreatureId(null);
    if (hadTarget && !isSpectator && activeAttackTarget?.attackerPlayerId === myPlayerId) {
      await applyRoomUpdate(
        (cur) => ({
          ...cur,
          attackTarget: null,
        }),
        undefined,
        true
      );
    }
  };

  const toggleTargetShield = async (shieldId: string) => {
    if (!targetingAttacker) return;
    const nextCreatureId = null;
    const nextShieldIds = selectedTargetShieldIds.includes(shieldId)
      ? selectedTargetShieldIds.filter((id) => id !== shieldId)
      : [...selectedTargetShieldIds, shieldId];
    setSelectedTargetCreatureId(nextCreatureId);
    setSelectedTargetShieldIds(nextShieldIds);
    await syncTargetingPreviewToRoom(targetingAttacker, nextShieldIds, nextCreatureId);
  };

  const toggleTargetCreature = async (creatureId: string) => {
    if (!targetingAttacker) return;
    const nextShieldIds: string[] = [];
    const nextCreatureId = selectedTargetCreatureId === creatureId ? null : creatureId;
    setSelectedTargetShieldIds(nextShieldIds);
    setSelectedTargetCreatureId(nextCreatureId);
    await syncTargetingPreviewToRoom(targetingAttacker, nextShieldIds, nextCreatureId);
  };

  const toggleMultiShieldId = (shieldId: string) => {
    setSelectedShieldIds((prev) =>
      prev.includes(shieldId) ? prev.filter((id) => id !== shieldId) : [...prev, shieldId]
    );
  };

  const updateMyState = async (
    newState: Partial<PlayerState>,
    recordUndo = true,
    meta?: RoomUpdateMeta,
    force = false
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

    await applyRoomUpdate(
      (cur) => {
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
      },
      meta,
      force
    );
  };

  // 選択した複数シールドをまとめてチェック（表向きにして確認キューへ）
  const handleCheckSelectedShields = () => {
    if (!me || selectedShieldIds.length === 0) return;
    const picked = (me.shields as BattleCardInstance[])
      .filter((s) => selectedShieldIds.includes(s.instanceId))
      .map((s) => ({ ...s, faceUp: true }));
    setShieldCheckQueue(picked);
  };

  // 選択した複数シールドをまとめてブレイク（スロット位置は空いて保持される）
  const handleBreakSelectedShields = async () => {
    if (!me || isSpectator || selectedShieldIds.length === 0) return;
    const idSet = new Set(selectedShieldIds);
    const remainingShields = (me.shields as BattleCardInstance[]).filter(
      (s) => !idSet.has(s.instanceId)
    );
    const brokenCards: BattleCardInstance[] = (me.shields as BattleCardInstance[])
      .filter((s) => idSet.has(s.instanceId))
      .map((s) => ({
        ...s,
        faceUp: true,
        tapped: false,
        underCards: [],
        ignored: false,
        shieldOverlaySlot: undefined,
      }));

    setMultiShieldSelectMode(false);
    setSelectedShieldIds([]);
    await updateMyState(
      {
        shields: remainingShields,
        hand: [...(me.hand || []), ...brokenCards],
      },
      true,
      { sound: 'shieldBreak' }
    );
  };

  // 手札公開（選択した手札カードを相手に見せる）
  const openHandRevealModal = () => {
    const currentHand = (me?.hand || []) as BattleCardInstance[];
    setSelectedRevealHandIds(currentHand.map((c) => c.instanceId));
    setHandRevealModalOpen(true);
  };

  const toggleRevealHandCard = (cardId: string) => {
    setSelectedRevealHandIds((prev) =>
      prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]
    );
  };

  const handlePublishSelectedHand = async () => {
    if (!me || !myPlayerId || isSpectator) return;
    const targets = ((me.hand || []) as BattleCardInstance[]).filter((c) =>
      selectedRevealHandIds.includes(c.instanceId)
    );
    if (targets.length === 0) {
      return alert('相手に見せる手札を1枚以上選んでください');
    }
    setHandRevealModalOpen(false);
    await applyRoomUpdate((cur) => ({
      ...cur,
      inspectingText: `${me.name} が手札（${targets.length}枚）を公開中！`,
      publicHandReveal: {
        playerId: myPlayerId,
        playerName: me.name,
        cards: targets.map((c) => ({ ...c, faceUp: true })),
      },
    }));
  };

  const handleStopPublicHandReveal = async () => {
    await applyRoomUpdate((cur) => ({
      ...cur,
      inspectingText: null,
      publicHandReveal: null,
    }));
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
  const handleActivateD2Switch = async (targetCard: BattleCardInstance) => {
    if (!me || isSpectator) return;
    setSelectedCard(null);
    const nextSwitched = !targetCard.d2Switched;
    await applyRoomUpdate(
      (cur) => {
        const player = cur.players[myPlayerId];
        if (!player) return cur;
        return {
          ...cur,
          players: {
            ...cur.players,
            [myPlayerId]: {
              ...player,
              battleZone: player.battleZone.map((c) =>
                c.instanceId === targetCard.instanceId
                  ? { ...c, d2Switched: nextSwitched, tapped: true }
                  : c
              ),
            },
          },
        };
      },
      nextSwitched
        ? {
            sound: 'd2Switch',
            cutIn: {
              type: 'ability',
              playerName: me.name,
              card: targetCard,
              subText: '🔄 D2スイッチ発動！！',
            },
          }
        : undefined
    );
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

  const handleAnnounceOpponentCreatureTarget = async (
    targetCard: BattleCardInstance,
    destinationLabel: string
  ) => {
    if (!me || isSpectator) return;
    const displayImg =
      targetCard.kindanRole && targetCard.kindanAwakened && targetCard.kindanAwakenedImageUrl
        ? targetCard.kindanAwakenedImageUrl
        : targetCard.imageUrl || '';

    const payload: TargetZoneCutIn = {
      id: `tz-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      fromPlayerName: me.name || '相手プレイヤー',
      cardName: targetCard.name,
      imageUrl: displayImg,
      destinationLabel,
      timestamp: Date.now(),
    };

    prevTargetZoneCutInIdRef.current = payload.id;
    setActiveTargetZoneCutIn(payload);
    setShowTargetMoveMenu(false);
    setInspectCard(null);

    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        targetZoneCutIn: payload,
      }),
      { sound: 'targetSelect' },
      true
    );
  };

  const handleUndo = async () => {
    if (isSpectator || undoStack.length === 0 || !me || !myPlayerId) return;
    const lastSnapshotStr = undoStack[undoStack.length - 1];
    const restored = JSON.parse(lastSnapshotStr);
    setUndoStack((prev) => prev.slice(0, -1));
    setPeekState(null);
    setSelectedCard(null);
    setSelectedGraveCard(null);
    setBrokenShieldCard(null);
    setEvolutionBuilder(null);
    setInspectedShieldSlot(null);
    setSelectedShieldIds([]);
    setShieldCheckQueue([]);
    cancelAttackTargeting();
    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          inspectingText: null,
          publicReveal: null,
          publicHandReveal: null,
          pendingDirectAttack: null,
          attackTarget: null,
          players: {
            ...curPlayers,
            [myPlayerId]: {
              ...curMe,
              ...restored,
            },
          },
        };
      },
      undefined,
      true
    );
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

       const rawCards = createDeckInstances(baseCards);
        const shuffled = (() => {
          let arr = [...rawCards];
          for (let p = 0; p < 7; p++) {
            for (let i = arr.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            if (arr.length >= 4) {
              const cut = 1 + Math.floor(Math.random() * (arr.length - 2));
              arr = [...arr.slice(cut), ...arr.slice(0, cut)];
            }
          }
          return arr;
        })();
        const shields = assignInitialShieldSlots(shuffled.slice(0, 5));
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
      await applyRoomUpdate(
        (cur) => ({
          ...cur,
          players: updatedPlayers,
          turnPlayerId: firstPlayerId,
          turnCount: 1,
          inspectingText: null,
          cutIn: null,
          publicReveal: null,
          publicHandReveal: null,
          pendingDirectAttack: null,
          attackTarget: null,
        }),
        undefined,
        true
      );

      setUndoStack([]);
      setPeekState(null);
      setSelectedCard(null);
      setSelectedGraveCard(null);
      setBrokenShieldCard(null);
      setEvolutionBuilder(null);
      setInspectedShieldSlot(null);
      setSelectedShieldIds([]);
      setShieldCheckQueue([]);
      cancelAttackTargeting();
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

  const myShieldSlots = buildShieldSlots(shields);
  const oppShieldSlots = buildShieldSlots(oppShields);
  const myActiveShieldCount = shields.length;
  const oppActiveShieldCount = oppShields.length;

  const normalBattleZone = battleZone.filter((c) => !c.kindanRole);
  const kindanBattleZone = battleZone.find((c) => c.kindanRole);

  const oppNormalBattleZone = oppBattleZone.filter((c) => !c.kindanRole);
  const oppKindanBattleZone = oppBattleZone.find((c) => c.kindanRole);

  const topGraveyardCard = graveyard.length > 0 ? graveyard[graveyard.length - 1] : null;
  const oppTopGraveyardCard =
    oppGraveyard.length > 0 ? oppGraveyard[oppGraveyard.length - 1] : null;

  const handleTopDeckTo = async (dest: 'hand' | 'mana' | 'graveyard' | 'shields') => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const newDeck = [...deck];
    const topCard = newDeck.shift()!;
    const assignedSlot = dest === 'shields' ? getNextEmptyOrNewSlot(shields) : undefined;
    const updatedCard: BattleCardInstance = {
      ...topCard,
      tapped: false,
      faceUp: dest !== 'shields',
      ignored: false,
      shieldOverlaySlot: assignedSlot,
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
    let shuffled = [...deck];
    for (let p = 0; p < 7; p++) {
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      if (shuffled.length >= 4) {
        const cut = 1 + Math.floor(Math.random() * (shuffled.length - 2));
        shuffled = [...shuffled.slice(cut), ...shuffled.slice(0, cut)];
      }
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
    cancelAttackTargeting();
    const nextTurnCount = (room.turnCount || 1) + 1;
    const nextTurnState: ExtendedRoom = {
      ...room,
      turnPlayerId: topPlayerId,
      turnCount: nextTurnCount,
      pendingDirectAttack: null,
      attackTarget: null,
    };
    triggerTurnBanner(nextTurnState);
    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        turnPlayerId: topPlayerId,
        turnCount: nextTurnCount,
        pendingDirectAttack: null,
        attackTarget: null,
      }),
      undefined,
      true
    );
  };

  const handlePeekTopDeck = async (count: number, isPublic: boolean) => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const actualCount = Math.min(count, deck.length);
    const newDeck = [...deck];
    const revealed = newDeck.splice(0, actualCount).map((c) => ({ ...c, faceUp: true }));

    await updateMyState({ deck: newDeck }, true, undefined, true);

    if (isPublic) {
      await applyRoomUpdate(
        (cur) => ({
          ...cur,
          inspectingText: `${me.name} が山札の上から ${actualCount} 枚を公開中！`,
          publicReveal: {
            playerName: me.name,
            cards: revealed,
          },
        }),
        undefined,
        true
      );
    } else {
      await setInspectingStatus(
        `${me.name} が山札の上から ${actualCount} 枚を確認中...`,
        true
      );
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

    const nextPlayerState: Partial<PlayerState> =
      dest === 'hand'
        ? { hand: [...hand, updatedCard] }
        : dest === 'battleZone'
        ? {
            battleZone: [
              ...battleZone.filter((c) => c.instanceId !== updatedCard.instanceId),
              updatedCard,
            ],
          }
        : dest === 'mana'
        ? { mana: [...mana, updatedCard] }
        : { graveyard: [...graveyard, updatedCard] };

    const meta: RoomUpdateMeta | undefined =
      dest === 'battleZone'
        ? {
            sound: 'summon',
            cutIn: {
              type: 'summon',
              playerName: me.name,
              card: updatedCard,
              subText: '山札からバトルゾーンへ！',
            },
          }
        : undefined;

    if (remaining.length === 0) {
      setPeekState(null);
      await applyRoomUpdate(
        (cur) => {
          const curPlayers = cur.players || {};
          const curMe = curPlayers[myPlayerId] || me;
          return {
            ...cur,
            inspectingText: null,
            publicReveal: null,
            players: {
              ...curPlayers,
              [myPlayerId]: {
                ...curMe,
                ...nextPlayerState,
              },
            },
          };
        },
        meta,
        true
      );
    } else {
      await updateMyState(nextPlayerState, true, meta, true);
      setPeekState({ ...peekState, cards: remaining });
      if (peekState.isPublic) {
        await applyRoomUpdate(
          (cur) => ({
            ...cur,
            publicReveal: {
              playerName: me.name,
              cards: remaining,
            },
          }),
          undefined,
          true
        );
      }
    }
  };

  const handleFinishPeek = async (destination: 'bottom' | 'top' | 'graveyard') => {
    if (!peekState || !me || isSpectator) return;

    const nextDeckPartial: Partial<PlayerState> =
      destination === 'bottom'
        ? {
            deck: [...deck, ...peekState.cards.map((c) => ({ ...c, faceUp: false }))],
          }
        : destination === 'top'
        ? {
            deck: [...peekState.cards.map((c) => ({ ...c, faceUp: false })), ...deck],
          }
        : {
            graveyard: [
              ...graveyard,
              ...peekState.cards.map((c) => ({ ...c, faceUp: true, tapped: false })),
            ],
          };

    setPeekState(null);
    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          inspectingText: null,
          publicReveal: null,
          players: {
            ...curPlayers,
            [myPlayerId]: {
              ...curMe,
              ...nextDeckPartial,
            },
          },
        };
      },
      undefined,
      true
    );
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
      nextBZ = nextBZ.map((c) => (c.instanceId === card.instanceId ? promotedUnderCard : c));
    } else {
      if (fromZone === 'hand') nextHand = removeFrom(nextHand);
      if (fromZone === 'mana') nextMana = removeFrom(nextMana);
      if (fromZone === 'battleZone') nextBZ = removeFrom(nextBZ);
      if (fromZone === 'shields') nextShields = removeFrom(nextShields);
      if (fromZone === 'graveyard') nextGrave = removeFrom(nextGrave);
    }

    const isFaceUpDest =
      toZone !== 'shields' && toZone !== 'deckTop' && toZone !== 'deckBottom';

    const resolvedSlot =
      toZone === 'shieldsFaceUp'
        ? shieldOverlaySlot || card.shieldOverlaySlot || 'S1'
        : toZone === 'shields'
        ? getNextEmptyOrNewSlot(nextShields)
        : undefined;

    const isEnteringBattleZoneAsD2 =
      toZone === 'battleZone' && fromZone !== 'battleZone' && isD2FieldCard(card);

    const cleanCard: BattleCardInstance = {
      ...card,
      tapped: isEnteringBattleZoneAsD2 ? true : false,
      faceUp: isFaceUpDest,
      underCards: isTopEvolutionToGraveyard
        ? []
        : toZone === 'battleZone'
        ? card.underCards || []
        : [],
      ignored: false,
      d2Switched: toZone === 'battleZone' ? card.d2Switched || false : false,
      shieldOverlaySlot: resolvedSlot,
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
              subText: resolvedSlot
                ? `${resolvedSlot} の上に表向きシールドとして配置！`
                : '新しいシールドとして表向きで配置！',
            },
          }
        : overrideCutIn
        ? { cutIn: overrideCutIn }
        : undefined;

    setSelectedCard(null);
    setSelectedGraveCard(null);
    setInspectedShieldSlot(null);
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

const handleAttackDeclare = async (
    attacker: BattleCardInstance,
    targetOverride?: { shieldIds: string[]; creatureId: string | null }
  ) => {
    if (!me || isSpectator || !myPlayerId) return;
    const updatedBZ = battleZone.map((c) =>
      c.instanceId === attacker.instanceId ? { ...c, tapped: true } : c
    );

    const shieldIds = targetOverride?.shieldIds || [];
    const creatureId = targetOverride?.creatureId || null;
    const hasTarget = shieldIds.length > 0 || !!creatureId;

    const targetCreature = creatureId
      ? oppBattleZone.find((c) => c.instanceId === creatureId)
      : undefined;

    const shieldLabels = shieldIds
      .map((sid) => {
        const found = oppShields.find((s) => s.instanceId === sid);
        return found?.shieldOverlaySlot || null;
      })
      .filter((v): v is string => !!v);

    const targetSummary = targetCreature
      ? `相手クリーチャー「${targetCreature.name}」を攻撃！`
      : shieldLabels.length > 0
      ? `相手シールド（${shieldLabels.join('・')}）を攻撃！`
      : 'クリーチャーで攻撃宣言！';

    const nextAttackTarget: ActiveAttackTarget | null =
      hasTarget && topPlayerId
        ? {
            id: `atk-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            attackerPlayerId: myPlayerId,
            attackerPlayerName: me.name,
            attackerCardId: attacker.instanceId,
            attackerCardName: attacker.name,
            defenderPlayerId: topPlayerId,
            shieldIds,
            shieldSlots: shieldLabels,
            creatureId,
            isPreview: false,
            timestamp: Date.now(),
          }
        : null;

    // ※ cancelAttackTargeting() を呼ぶと DB の attackTarget: null と競合するため、ローカル選択状態だけリセット
    setSelectedCard(null);
    setTargetingAttacker(null);
    setSelectedTargetShieldIds([]);
    setSelectedTargetCreatureId(null);

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
          attackTarget: nextAttackTarget,
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
          subText: targetSummary,
        },
      }
    );
  };

  // 通常攻撃（シールド／相手クリーチャー指定）に対するブロッカー宣言
  const handleBlockTargetedAttack = async (blocker: BattleCardInstance) => {
    if (!me || !activeAttackTarget || !myPlayerId) return;

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
    setTargetBlockModalOpen(false);

    await applyRoomUpdate(
      (cur) => {
        const curPlayers = cur.players || {};
        const curMe = curPlayers[myPlayerId] || me;
        return {
          ...cur,
          attackTarget: null,
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
          subText: `🛡️ ブロック発動！${activeAttackTarget.attackerCardName} の攻撃をブロック！`,
        },
      }
    );
  };

  const handleDeclareDirectAttack = async (attacker: BattleCardInstance) => {
    if (!me || isSpectator) return;
    if (!topPlayerId) return alert('対戦相手がまだおらんでい');

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
    cancelAttackTargeting();

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
          attackTarget: null,
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
          subText: '⚠️ ダイレクトアタック宣言！！さぁどうなる',
        },
      }
    );
  };

  const handleAcceptDefeat = async () => {
    if (!pendingDirectAttack || !me) return;
    const { attackerPlayerName, card } = pendingDirectAttack;

    await applyRoomUpdate(
      (cur) => ({
        ...cur,
        pendingDirectAttack: null,
        attackTarget: null,
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
              ? '🔥 革命0トリガー！！まだ終わってへんでぇ！'
              : '🔥 革命0トリガー！！そこのお前気を抜くなよ',
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

  const handleBreakShield = async (card: BattleCardInstance, slotLabel?: string) => {
    if (!me || isSpectator) return;
    const resolvedLabel = slotLabel || card.shieldOverlaySlot;
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

    setInspectedShieldSlot(null);
    await updateMyState(
      {
        shields: nextShields,
        hand: nextHand,
      },
      true,
      { sound: 'shieldBreak' }
    );
    setBrokenShieldCard({ card: addedToHand, slotLabel: resolvedLabel });
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

  const handleConfirmFreeEvolution = async () => {
    if (!me || isSpectator || !evolutionBuilder || isEvolvingBusy) return;
    const { evolvingCard, fromZone, selectedMaterials } = evolutionBuilder;

    if (selectedMaterials.length === 0) {
      return alert('進化元を1枚以上選んでください');
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
          sound: 'evolve',
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
        sound: 'evolve',
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
    const assignedSlot = toZone === 'shields' ? getNextEmptyOrNewSlot(shields) : undefined;
    const updatedCard: BattleCardInstance = {
      ...card,
      tapped: false,
      faceUp: toZone !== 'shields',
      ignored: false,
      shieldOverlaySlot: assignedSlot,
    };

    if (toZone === 'hand') {
      await updateMyState({ deck: nextDeck, hand: [...hand, updatedCard] });
    } else if (toZone === 'battleZone') {
      const cleanBZ = battleZone.filter((c) => c.instanceId !== updatedCard.instanceId);
      await updateMyState({ deck: nextDeck, battleZone: [...cleanBZ, updatedCard] }, true, {
        sound: 'summon',
        cutIn: {
          type: 'summon',
          playerName: me.name,
          card: updatedCard,
          subText: '山札からバトルゾーンへ！',
        },
      });
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
    const isD2 = zone === 'battleZone' && isD2FieldCard(card);
    const isIgnored = zone === 'battleZone' && !!card.ignored;

    const rotationClass = isD2
      ? card.d2Switched
        ? 'rotate-90 mx-2.5'
        : '-rotate-90 mx-2.5'
      : card.tapped
      ? 'rotate-90 mx-2.5 opacity-85'
      : '';

    const isOpponentZone = !isControllable && !isSpectator;
    const isPickedInTargetingMode =
      !isSpectator &&
      !!targetingAttacker &&
      isOpponentZone &&
      zone === 'battleZone' &&
      selectedTargetCreatureId === card.instanceId;

    const isHighlightedByRemoteAttack =
      zone === 'battleZone' && isTargetOfAttack(card.instanceId, 'battleZone', isControllable);

    const isGlowingTarget = isPickedInTargetingMode || isHighlightedByRemoteAttack;

    const kindanDisplayImage = isKindan
      ? card.kindanAwakened
        ? card.kindanAwakenedImageUrl || card.imageUrl
        : card.imageUrl
      : card.imageUrl;

    const slotName = `S${(index ?? 0) + 1}`;

    return (
      <div
        key={card.instanceId}
        onClick={() => {
          if (!isControllable) {
            if (!isSpectator && targetingAttacker && zone === 'battleZone') {
              toggleTargetCreature(card.instanceId);
              return;
            }

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
          setSelectedCard({ card, zone });
        }}
        title={
          !isSpectator && targetingAttacker && isOpponentZone && zone === 'battleZone'
            ? `${card.name}`
            : showFace
            ? `${card.name}`
            : '裏向きカード'
        }
        className={`relative select-none transition-all shrink-0 ${
          canClick || (!isSpectator && targetingAttacker && isOpponentZone && zone === 'battleZone')
            ? 'cursor-pointer active:scale-95'
            : 'cursor-default'
        } ${rotationClass} ${
          isIgnored ? 'brightness-50 saturate-50' : ''
        } ${
          isGlowingTarget
            ? 'ring-4 ring-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.95)] scale-105 z-10 animate-pulse rounded-md'
            : ''
        } ${underCount > 0 ? 'mt-2 ml-1.5' : ''}`}
      >
        {isGlowingTarget && (
          <span className="-top-2.5 left-1/2 -translate-x-1/2 absolute whitespace-nowrap bg-rose-600 text-white border border-yellow-300 text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shadow-lg z-20 pointer-events-none">
            🎯 攻撃対象
          </span>
        )}

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
                  isIgnored ? 'border border-slate-600' : 'border border-slate-400'
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
            <span className="text-xs font-bold">{slotName}</span>
          )}
        </div>
      </div>
    );
  };

  // スロット（S1〜S5＋重なり表向きシールド）を描画するヘルパー
  const renderShieldSlotsRow = (slots: ShieldSlotData[], isMine: boolean, ownerName: string) => (
    <div className="flex flex-wrap gap-2 items-end min-h-[78px] pt-2">
      {slots.map((slotData) => {
        const { slot, baseCard, faceUpOverlays } = slotData;
        const allCardsInSlot: BattleCardInstance[] = [
          ...(baseCard ? [baseCard] : []),
          ...faceUpOverlays,
        ];
        const isEmptySlot = allCardsInSlot.length === 0;
        const topOverlay =
          faceUpOverlays.length > 0 ? faceUpOverlays[faceUpOverlays.length - 1] : null;

        const isAnyCardSelectedForMulti =
          isMine && allCardsInSlot.some((c) => selectedShieldIds.includes(c.instanceId));

       const isAnyCardTargeted =
          (!isMine &&
            !isSpectator &&
            !!targetingAttacker &&
            allCardsInSlot.some((c) => selectedTargetShieldIds.includes(c.instanceId))) ||
          allCardsInSlot.some((c) => isTargetOfAttack(c.instanceId, 'shields', isMine, slot)) ||
          isTargetOfAttack('', 'shields', isMine, slot);

        const handleSlotClick = () => {
          if (isEmptySlot) return;

          if (!isMine) {
            if (!isSpectator && targetingAttacker) {
              const targetCard = topOverlay || baseCard;
              if (targetCard) {
                toggleTargetShield(targetCard.instanceId);
              }
              return;
            }

            if (topOverlay) {
              setInspectCard({
                card: topOverlay,
                ownerName,
                sourceZone: 'shields',
                isOpponentCard: !isSpectator,
              });
            } else if (baseCard && baseCard.faceUp) {
              setInspectCard({
                card: baseCard,
                ownerName,
                sourceZone: 'shields',
                isOpponentCard: !isSpectator,
              });
            }
            return;
          }

          if (multiShieldSelectMode) {
            const primaryCard = topOverlay || baseCard;
            if (primaryCard) {
              toggleMultiShieldId(primaryCard.instanceId);
            }
            return;
          }

          // 自分シールド1回タップ：いきなりブレイクせず、重なり確認＆ブレイク選択モーダルを開く
          setInspectedShieldSlot({
            slot,
            isMine: true,
            ownerName,
            cards: allCardsInSlot,
          });
        };

        return (
          <div
            key={slot}
            onClick={handleSlotClick}
            title={
              isEmptySlot
                ? `${slot}（空き枠）`
                : isMine
                ? `${slot}（タップでシールド確認・ブレイク選択／重なり ${allCardsInSlot.length}枚）`
                : `${slot}（タップで確認）`
            }
            className={`relative select-none transition-all shrink-0 ${
              isEmptySlot ? 'cursor-default opacity-45' : 'cursor-pointer active:scale-95'
            } ${
              isAnyCardTargeted
                ? 'ring-4 ring-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.95)] scale-105 z-10 animate-pulse rounded-md'
                : isAnyCardSelectedForMulti
                ? 'ring-4 ring-sky-400 shadow-[0_0_16px_rgba(56,189,248,0.9)] -translate-y-1 z-10 rounded-md'
                : ''
            }`}
          >
            {isAnyCardTargeted && (
              <span className="-top-2.5 left-1/2 -translate-x-1/2 absolute whitespace-nowrap bg-rose-600 text-white border border-yellow-300 text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shadow-lg z-30 pointer-events-none">
                🎯 攻撃対象
              </span>
            )}

            {isAnyCardSelectedForMulti && (
              <span className="-top-2.5 left-1/2 -translate-x-1/2 absolute whitespace-nowrap bg-sky-500 text-slate-950 border border-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shadow-lg z-30 pointer-events-none">
                ✓ 選択中
              </span>
            )}

            <div className="relative w-12 h-16 sm:w-14 sm:h-20">
              {/* ベースの裏盾（または空き枠） */}
              {baseCard ? (
                <div className="w-full h-full rounded-md bg-indigo-950 border-2 border-amber-500/80 text-amber-300 flex flex-col items-center justify-center shadow-md">
                  <span className="text-xs font-extrabold">{slot}</span>
                  <span className="text-[8px] text-amber-200/80">裏盾</span>
                </div>
              ) : (
                <div className="w-full h-full rounded-md border border-dashed border-slate-700 bg-slate-900/40 text-slate-600 flex flex-col items-center justify-center">
                  <span className="text-[10px] font-bold">{slot}</span>
                  <span className="text-[8px]">空き</span>
                </div>
              )}

              {/* スロットの上に重なっている表向きシールド（複数重なりも段差表示） */}
              {faceUpOverlays.map((ov, ovIdx) => (
                <div
                  key={ov.instanceId}
                  style={{
                    top: `${-6 - ovIdx * 4}px`,
                    left: `${4 + ovIdx * 4}px`,
                  }}
                  className="absolute w-full h-full rounded-md overflow-hidden border-2 border-amber-300 bg-slate-800 shadow-xl z-10"
                >
                  {ov.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={ov.imageUrl}
                      alt={ov.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[8px] font-bold text-center p-0.5 text-amber-200">
                      {ov.name}
                    </div>
                  )}
                  <span className="absolute bottom-0 inset-x-0 bg-amber-400 text-slate-950 text-[8px] font-extrabold text-center py-0.5">
                    {slot} 表{faceUpOverlays.length > 1 ? `(${faceUpOverlays.length})` : ''}
                  </span>
                </div>
              ))}

              {allCardsInSlot.length > 1 && (
                <span className="-top-2 -right-2 absolute bg-purple-600 text-white border border-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shadow z-20">
                  {allCardsInSlot.length}枚重なり
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  // 墓地ゾーンの「一番最新のカードだけ上に表示＋タップで横並び一覧を開く」ウィジェット
  const renderGraveyardStackWidget = (
    topCard: BattleCardInstance | null,
    count: number,
    onOpenList: () => void,
    accentClass: string
  ) => (
    <div
      onClick={onOpenList}
      title="タップで墓地一覧を開く"
      className={`cursor-pointer select-none bg-slate-950/90 border ${accentClass} rounded-xl p-2 flex flex-col items-center justify-center min-w-[84px] sm:min-w-[96px] hover:scale-105 transition shrink-0 shadow-md`}
    >
      <div className="text-[10px] font-extrabold text-slate-300 mb-1">墓地 ({count})</div>
      {topCard ? (
        <div className="relative w-14 h-20 sm:w-16 sm:h-24 rounded-md overflow-hidden border border-slate-500 bg-slate-800 shadow">
          {topCard.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={topCard.imageUrl}
              alt={topCard.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[9px] font-bold text-center p-1">
              {topCard.name}
            </div>
          )}
          <span className="absolute bottom-0 inset-x-0 bg-black/85 text-[8px] font-extrabold text-amber-300 text-center py-0.5 truncate px-1">
            最新
          </span>
        </div>
      ) : (
        <div className="w-14 h-20 sm:w-16 sm:h-24 rounded-md border border-dashed border-slate-700 flex items-center justify-center text-[10px] text-slate-600 font-bold">
          空
        </div>
      )}
    </div>
  );

  const tappedManaCount = mana.filter((c) => c.tapped).length;
  const untappedManaCount = mana.length - tappedManaCount;
  const turnOwnerName = playersObj[room.turnPlayerId]?.name || 'プレイヤー';

  const activePublicReveal =
    room.publicReveal && room.publicReveal.playerName !== me?.name ? room.publicReveal : null;

  const activeOpponentHandReveal =
    room.publicHandReveal && room.publicHandReveal.playerId !== myPlayerId
      ? room.publicHandReveal
      : null;

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

  const shieldSlotChoices = myShieldSlots.map((s) => s.slot);

  const selectedShieldLabelsForBar = selectedTargetShieldIds
    .map((sid) => {
      const found = oppShields.find((s) => s.instanceId === sid);
      return found?.shieldOverlaySlot || null;
    })
    .filter(Boolean);

  const selectedCreatureForBar = selectedTargetCreatureId
    ? oppBattleZone.find((c) => c.instanceId === selectedTargetCreatureId)
    : undefined;

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-2 sm:p-4 max-w-6xl mx-auto">
      <CutInOverlay event={room.cutIn} />

      {/* 相手クリーチャー対象指定カットイン（タップ時と同じ特大サイズで表示） */}
      {activeTargetZoneCutIn && (
        <div
          onClick={() => setActiveTargetZoneCutIn(null)}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-3 sm:p-4 z-[60] cursor-pointer"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-amber-400 rounded-2xl p-4 max-w-md w-full flex flex-col items-center text-center space-y-3 shadow-[0_0_40px_rgba(251,191,36,0.55)] cursor-default"
          >
            <span className="px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400 text-amber-300 text-xs font-extrabold">
              🎯 {activeTargetZoneCutIn.fromPlayerName} がクリーチャーを指定！
            </span>

            {activeTargetZoneCutIn.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeTargetZoneCutIn.imageUrl}
                alt={activeTargetZoneCutIn.cardName}
                className="w-[80vw] max-w-[350px] h-[54vh] max-h-[480px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl"
              />
            ) : (
              <div className="w-64 h-80 bg-slate-800 rounded-xl flex items-center justify-center font-extrabold text-lg p-4">
                {activeTargetZoneCutIn.cardName}
              </div>
            )}

            <div className="font-extrabold text-base text-white">
              {activeTargetZoneCutIn.cardName}
            </div>

            <div className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 text-slate-950 font-black text-base sm:text-lg shadow-lg">
              ➡ 「{activeTargetZoneCutIn.destinationLabel}」送りに指定！
            </div>

            <button
              type="button"
              onClick={() => setActiveTargetZoneCutIn(null)}
              className="w-full py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-xs font-bold"
            >
              確認して閉じる
            </button>
          </div>
        </div>
      )}

      {/* ターン切り替わり視覚バナー */}
      {turnBanner && (
        <div className="fixed inset-x-0 top-20 flex justify-center z-50 pointer-events-none px-4">
          <div
            className={`px-6 py-3 rounded-2xl border-2 shadow-2xl text-center backdrop-blur-md transition-all animate-bounce ${
              turnBanner.isMyTurn
                ? 'bg-emerald-950/95 border-emerald-400 text-emerald-200'
                : 'bg-amber-950/95 border-amber-400 text-amber-200'
            }`}
          >
            <div className="text-[11px] font-extrabold uppercase tracking-widest opacity-90">
              TURN {turnBanner.turnCount}
            </div>
            <div className="text-lg sm:text-2xl font-black">
              {turnBanner.isMyTurn
                ? '⚡ あなたのターンに切り替わりました！'
                : `🔄 ${turnBanner.turnPlayerName} のターンに切り替わりまっちょ`}
            </div>
          </div>
        </div>
      )}

      {/* 上部バー（スクロール時も固定） */}
      <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-1.5 bg-slate-900/95 backdrop-blur-md px-2.5 py-2 rounded-lg border border-slate-700 shadow-lg">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs bg-slate-800 px-2 py-1 rounded font-mono font-bold text-amber-400">
            ID: {room.roomId}
          </span>
          {isSpectator && (
            <div className="flex items-center gap-1">
              <span className="text-xs bg-indigo-600 px-2 py-1 rounded font-bold text-white">
                👁️ 観戦
              </span>
              <button
                type="button"
                onClick={() => setSpectatorShowHands((prev) => !prev)}
                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-amber-400/70 text-amber-300 rounded text-xs font-bold"
              >
                {spectatorShowHands ? '🙈 手札隠す' : '👁️ 手札見る'}
              </button>
            </div>
          )}
          <span
            className={`text-xs font-extrabold px-2 py-1 rounded border whitespace-nowrap ${
              isMyTurn
                ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                : 'bg-amber-950/60 border-amber-500/40 text-amber-300'
            }`}
          >
            T{room.turnCount}：
            {isSpectator
              ? `${turnOwnerName}`
              : isMyTurn
              ? '自分'
              : `${opponent?.name || '相手'}`}
          </span>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={async () => {
              if (soundEnabledRef.current) playGameSound('customSe1');
              await applyRoomUpdate((cur) => cur, { sound: 'customSe1' }, true);
            }}
            title="1タップでSE1（se1.mp3）を鳴らす"
            className="px-2 py-1 bg-amber-600 hover:bg-amber-500 active:scale-95 text-white rounded text-[11px] font-extrabold border border-amber-300/60 transition whitespace-nowrap shrink-0"
          >
            ノートリ
          </button>

          <button
            type="button"
            onClick={async () => {
              if (soundEnabledRef.current) playGameSound('customSe2');
              await applyRoomUpdate((cur) => cur, { sound: 'customSe2' }, true);
            }}
            title="1タップでSE2（se2.mp3）を鳴らす"
            className="px-2 py-1 bg-orange-600 hover:bg-orange-500 active:scale-95 text-white rounded text-[11px] font-extrabold border border-orange-300/60 transition whitespace-nowrap shrink-0"
          >
            拍手喝采
          </button>

          <div className="flex items-center gap-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 shrink-0">
            <select
              value={
                myBgmList.some((t) => t.id === room.activeBgm?.id)
                  ? room.activeBgm?.id
                  : room.activeBgm
                  ? 'remote_playing'
                  : 'off'
              }
              onChange={(e) => handleSelectRoomBgm(e.target.value)}
              disabled={isSpectator}
              className="bg-transparent text-[11px] font-bold text-slate-100 focus:outline-none cursor-pointer max-w-[130px]"
              title="BGM選択（選ぶと相手の画面にも流れます）"
            >
              <option value="off" className="bg-slate-900 text-slate-300">
                 BGM 一覧
              </option>
              {room.activeBgm && !myBgmList.some((t) => t.id === room.activeBgm?.id) && (
                <option value="remote_playing" className="bg-slate-900 text-amber-300">
                  🎵 {room.activeBgm.name}（再生中）
                </option>
              )}
              {myBgmList.map((t) => (
                <option key={t.id} value={t.id} className="bg-slate-900 text-amber-300">
                  🎵 {t.name}
                </option>
              ))}
            </select>
            {room.activeBgm && (
              <>
                <button
                  type="button"
                  onClick={() => handleSelectRoomBgm('off')}
                  title="BGMを停止（自分も相手も止まります）"
                  className="px-1.5 py-0.5 bg-rose-700 hover:bg-rose-600 text-white rounded text-[10px] font-extrabold"
                >
                  ■停止
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bgmVolume}
                  onChange={(e) => setBgmVolume(Number(e.target.value))}
                  className="w-10 accent-emerald-400 cursor-pointer"
                  title="自分のBGM音量"
                />
              </>
            )}
          </div>

          {!isSpectator && (
            <>
              <button
                type="button"
                onClick={openHandRevealModal}
                className="px-2 py-1 bg-fuchsia-700 hover:bg-fuchsia-600 border border-fuchsia-300/60 rounded text-[11px] font-extrabold whitespace-nowrap shrink-0"
              >
                🃏 手札見せる
              </button>
              <button
                type="button"
                onClick={async () => {
                  setDirectAttackModalOpen(true);
                  const videoPayload: VideoCutInData = {
                    id: `da_${Date.now()}`,
                    videoUrl: '/effects/direct-attack.mp4',
                    transparentBlack: false,
                  };
                  lastPlayedVideoCutInIdRef.current = videoPayload.id;
                  setActiveVideoCutIn(videoPayload);
                  await applyRoomUpdate((cur) => cur, {
                    latestVideoCutIn: videoPayload,
                  } as any);
                }}
                title="ダイレクトアタック"
                className="px-2 py-1 bg-gradient-to-r from-rose-600 via-red-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white border border-yellow-300/80 rounded text-[11px] font-extrabold shadow-md animate-pulse whitespace-nowrap shrink-0"
              >
                💥 DA
              </button>
              <button
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 border border-slate-600 rounded text-[11px] font-bold transition whitespace-nowrap shrink-0"
              >
                ↩️ 戻る({undoStack.length})
              </button>
              <button
                onClick={handleTurnStart}
                className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-[11px] font-bold whitespace-nowrap shrink-0"
              >
                ターン開始(+1)
              </button>
              <button
                onClick={handleTurnEnd}
                className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-[11px] font-extrabold whitespace-nowrap shrink-0"
              >
                エンド
              </button>
              <button
                onClick={handleResetMatch}
                disabled={resetting}
                className="px-2 py-1 bg-rose-800 hover:bg-rose-700 border border-rose-500/60 rounded text-[11px] font-bold whitespace-nowrap shrink-0"
              >
                🔄 リセット
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
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px] text-slate-300 whitespace-nowrap shrink-0"
          >
            退出
          </button>
        </div>
      </header>

      {/* 自分が相手に見せている手札の終了バー */}
      {!isSpectator && room.publicHandReveal && room.publicHandReveal.playerId === myPlayerId && (
        <div className="my-1.5 p-2 bg-fuchsia-950/90 border border-fuchsia-400 rounded-xl flex items-center justify-between gap-2 text-xs font-bold text-fuchsia-100">
          <span>
            🃏 相手に手札（{room.publicHandReveal.cards.length}枚）を公開中です
          </span>
          <button
            type="button"
            onClick={handleStopPublicHandReveal}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px] shrink-0"
          >
            公開をやめる
          </button>
        </div>
      )}

      {/* 相手から公開された手札の表示エリア */}
      {activeOpponentHandReveal && activeOpponentHandReveal.cards.length > 0 && (
        <div className="my-1.5 p-3 bg-fuchsia-950/90 border-2 border-fuchsia-400 rounded-xl space-y-2 shadow-xl">
          <div className="flex items-center justify-between text-xs font-bold text-fuchsia-200">
            <span>
              🃏 {activeOpponentHandReveal.playerName} が手札を公開中！
            </span>
            <span>{activeOpponentHandReveal.cards.length} 枚</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeOpponentHandReveal.cards.map((c) => (
              <div
                key={c.instanceId}
                onClick={() =>
                  setInspectCard({
                    card: c,
                    ownerName: activeOpponentHandReveal.playerName,
                  })
                }
                className="cursor-pointer bg-slate-900 border border-fuchsia-400/70 rounded-lg p-1.5 flex flex-col items-center w-20 sm:w-24 hover:scale-105 transition"
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

      {/* 攻撃先指定モード中の操作バー */}
      {!isSpectator && targetingAttacker && (
        <div className="my-1.5 p-2.5 bg-rose-950/95 border-2 border-rose-400 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs font-bold shadow-xl">
          <div className="space-y-0.5">
            <div className="text-amber-300 font-extrabold">
              🎯 「{targetingAttacker.name}」の攻撃先を選択中（相手のシールド複数タップ または 相手クリーチャーをタップ）
            </div>
            <div className="text-rose-200 text-[11px]">
              選択中：
              {selectedCreatureForBar
                ? `相手クリーチャー「${selectedCreatureForBar.name}」`
                : selectedShieldLabelsForBar.length > 0
                ? `シールド ${selectedShieldLabelsForBar.join('・')}`
                : '未選択（攻撃先なしでそのまま攻撃宣言も可）'}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() =>
                handleAttackDeclare(targetingAttacker, {
                  shieldIds: selectedTargetShieldIds,
                  creatureId: selectedTargetCreatureId,
                })
              }
              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white border border-yellow-300 rounded-lg text-xs font-extrabold shadow"
            >
              ⚔️ この攻撃先で攻撃宣言！
            </button>
            <button
              type="button"
              onClick={cancelAttackTargeting}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-bold"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 自分が攻撃宣言した後の表示バナー（攻撃対象が光り続け、ボタンで解除可能） */}
      {!isSpectator &&
        !targetingAttacker &&
        activeAttackTarget &&
        !activeAttackTarget.isPreview &&
        activeAttackTarget.attackerPlayerId === me?.id && (
          <div className="my-1.5 p-2.5 bg-amber-950/95 border-2 border-amber-400 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-amber-100 shadow-lg">
            <span>
              ⚔️ 「{activeAttackTarget.attackerCardName}」で攻撃宣言中 → 対象：
              <strong className="text-yellow-300 underline ml-1">
                {activeAttackTarget.creatureId
                  ? `相手クリーチャー「${
                      opponent?.battleZone.find(
                        (c) => c.instanceId === activeAttackTarget.creatureId
                      )?.name || '対象クリーチャー'
                    }」`
                  : activeAttackTarget.shieldSlots && activeAttackTarget.shieldSlots.length > 0
                  ? `相手シールド ${activeAttackTarget.shieldSlots.join('・')}`
                  : '相手プレイヤー'}
              </strong>
            </span>
            <button
              type="button"
              onClick={async () => {
                await applyRoomUpdate((cur) => ({
                  ...cur,
                  attackTarget: null,
                }));
              }}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px] text-slate-200 shrink-0"
            >
              攻撃表示を消す
            </button>
          </div>
        )}

      {/* 相手から狙われている側への通知＋ブロッカー対応バナー */}
      {amIDefendingTargetedAttack && activeAttackTarget && (
        <div className="my-1.5 p-2.5 bg-rose-950/95 border-2 border-rose-400 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-rose-100 animate-pulse shadow-lg">
          <span>
            🎯 {activeAttackTarget.attackerPlayerName} の「{activeAttackTarget.attackerCardName}」が
            {activeAttackTarget.isPreview ? '攻撃先を選択中：' : '攻撃宣言！対象：'}
            <strong className="text-yellow-300 underline ml-1">
              {activeAttackTarget.creatureId
                ? `クリーチャー「${
                    battleZone.find((c) => c.instanceId === activeAttackTarget.creatureId)?.name ||
                    '対象クリーチャー'
                  }」`
                : activeAttackTarget.shieldSlots && activeAttackTarget.shieldSlots.length > 0
                ? `シールド ${activeAttackTarget.shieldSlots.join('・')}`
                : '光っている対象'}
            </strong>
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setTargetBlockModalOpen(true)}
              className="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white border border-sky-300 rounded text-[11px] font-extrabold"
            >
              🛡️ ブロッカーでブロック
            </button>
            <button
              type="button"
              onClick={async () => {
                await applyRoomUpdate((cur) => ({
                  ...cur,
                  attackTarget: null,
                }));
              }}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px] text-slate-200"
            >
              表示を消す
            </button>
          </div>
        </div>
      )}

      {/* ダイレクトアタック宣言送信後の待機バナー */}
      {amIWaitingDirectAttack && pendingDirectAttack && (
        <div className="my-1.5 p-2.5 bg-rose-950/90 border-2 border-amber-400 rounded-xl flex items-center justify-between gap-2 text-xs font-bold text-amber-200 animate-pulse">
          <span>
            ⚔️ 「{pendingDirectAttack.card.name}」勝てたら何食べたい？
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
              👁️ {activePublicReveal.playerName} が山札の上からめくって公開中
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
            <span>墓地: {oppGraveyard.length}</span>
          </div>
        </div>

        {isSpectator && opponent && (
          <div className="bg-slate-950/90 p-2 rounded-lg border border-indigo-500/40">
            <div className="text-[10px] text-rose-300 font-bold mb-1">
              {opponent.name}の手札 ({oppHand.length}枚)
            </div>
            <div className="flex flex-wrap gap-1.5 min-h-[68px]">
              {oppHand.map((c) =>
                renderCard(c, 'hand', false, opponent.name, undefined, !spectatorShowHands)
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1 min-h-[32px] bg-slate-950/50 p-1.5 rounded items-center">
          <span className="text-[10px] text-slate-500 mr-1">マナ:</span>
          {oppMana.map((c) => renderCard(c, 'mana', false, opponent?.name || '相手'))}
        </div>

        {/* 相手シールドゾーン ＋ 隣に相手墓地 */}
        <div className="flex items-stretch justify-between gap-2 bg-slate-950/50 p-1.5 rounded">
          <div className="flex flex-col justify-between gap-1 min-h-[56px] flex-1">
            <span className="text-[10px] text-slate-500">
              シールド ({oppActiveShieldCount}枚):
            </span>
            {renderShieldSlotsRow(oppShieldSlots, false, opponent?.name || '相手')}
          </div>
          {opponent &&
            renderGraveyardStackWidget(
              oppTopGraveyardCard,
              oppGraveyard.length,
              () => setOppGraveViewOpen(true),
              'border-rose-500/50'
            )}
        </div>

        {/* 相手バトルゾーン */}
        <div className="flex items-center justify-between gap-2 min-h-[70px] bg-slate-800/40 p-2 rounded">
          <div className="flex flex-wrap gap-2 items-center flex-1">
            <span className="text-[10px] text-slate-400 mr-1">
              バトルゾーン :
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
              <span>墓地: {graveyard.length}</span>
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

        {/* 自分シールドゾーン ＋ 隣に自分墓地 */}
        <div className="flex flex-col sm:flex-row items-stretch justify-between gap-2 bg-slate-950/60 p-2 rounded">
          <div className="flex-1 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-amber-400 font-bold">
                シールド ({myActiveShieldCount}枚)
                {!isSpectator &&
                  (multiShieldSelectMode
                    ? ' ※複数選択中（タップでON/OFF）'
                    : ' ')}
              </span>
              {!isSpectator && shields.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setMultiShieldSelectMode((prev) => {
                        const next = !prev;
                        if (!next) setSelectedShieldIds([]);
                        return next;
                      });
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-extrabold border transition ${
                      multiShieldSelectMode
                        ? 'bg-sky-500 text-slate-950 border-white'
                        : 'bg-slate-800 hover:bg-slate-700 text-sky-300 border-sky-500/50'
                    }`}
                  >
                    {multiShieldSelectMode ? '✕ 複数選択を終了' : '🛡️ シールド複数選択'}
                  </button>
                  {multiShieldSelectMode && selectedShieldIds.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleCheckSelectedShields}
                        className="px-2 py-1 bg-amber-400 hover:bg-amber-300 text-slate-950 rounded text-[11px] font-extrabold"
                      >
                        👁️ 選択{selectedShieldIds.length}枚をまとめて確認
                      </button>
                      <button
                        type="button"
                        onClick={handleBreakSelectedShields}
                        className="px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-extrabold"
                      >
                        💥 選択{selectedShieldIds.length}枚をブレイク
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {renderShieldSlotsRow(myShieldSlots, !isSpectator, me?.name || '自分')}

            {!isSpectator && (
              <div className="flex flex-wrap gap-1.5 items-center pt-1">
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
              </div>
            )}
          </div>

          {renderGraveyardStackWidget(
            topGraveyardCard,
            graveyard.length,
            () => {
              setSelectedGraveCard(null);
              setGraveSearchOpen(true);
            },
            'border-emerald-500/50'
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[45px] bg-slate-950/60 p-2 rounded items-center justify-between">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-lime-400 font-bold mr-1">
              マナ (使用可能 {untappedManaCount} / 合計 {mana.length})
              {!isSpectator && ' 真剣にやれ'}:
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
              : `自分の手札 (${hand.length}枚) - ミスんなよぉ`}
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

      {/* ================= シールドスロットタップ時の「確認・ブレイク選択」モーダル ================= */}
      {!isSpectator && inspectedShieldSlot && (
        <div
          onClick={() => setInspectedShieldSlot(null)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-amber-400 rounded-2xl p-4 max-w-2xl w-full max-h-[90vh] flex flex-col space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-extrabold text-sm sm:text-base text-amber-300">
                  🛡️ {inspectedShieldSlot.slot} のシールド確認（重なり {inspectedShieldSlot.cards.length}枚）
                </h3>
                <p className="text-[11px] text-slate-300">
                  シールドブレイクしますか？ブレイクするカードを選ぶと手札に加わります
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectedShieldSlot(null)}
                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>

            <div className="overflow-x-auto flex gap-3 py-2 items-center">
              {inspectedShieldSlot.cards.map((c, idx) => {
                const isBaseHidden = !c.faceUp;
                const layerLabel = isBaseHidden ? '裏盾' : `表盾 ${idx + 1}`;
                return (
                  <div
                    key={c.instanceId}
                    className="bg-slate-800 border border-amber-400/60 rounded-xl p-2.5 flex flex-col items-center w-32 sm:w-36 shrink-0 space-y-2"
                  >
                    <span className="px-2 py-0.5 bg-amber-500/20 border border-amber-400 text-amber-200 rounded text-[10px] font-extrabold">
                      {layerLabel}
                    </span>

                    {c.faceUp && c.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.imageUrl}
                        alt={c.name}
                        onClick={() =>
                          setInspectCard({
                            card: c,
                            ownerName: inspectedShieldSlot.ownerName,
                          })
                        }
                        className="cursor-pointer w-24 h-34 object-cover rounded border border-slate-600 hover:scale-105 transition"
                      />
                    ) : (
                      <div className="w-24 h-34 rounded-lg bg-indigo-950 border-2 border-amber-500/70 text-amber-300 flex flex-col items-center justify-center text-xs font-extrabold">
                        <span>{inspectedShieldSlot.slot}</span>
                        <span className="text-[10px] mt-1">裏向きシールド</span>
                      </div>
                    )}

                    <div className="text-[11px] font-bold truncate w-full text-center">
                      {c.faceUp ? c.name : `${inspectedShieldSlot.slot}（裏向き）`}
                    </div>

                    {c.faceUp && (
                      <button
                        type="button"
                        onClick={() =>
                          setInspectCard({
                            card: c,
                            ownerName: inspectedShieldSlot.ownerName,
                          })
                        }
                        className="w-full py-1 bg-slate-700 hover:bg-slate-600 rounded text-[10px] font-bold text-sky-300"
                      >
                        🔍 拡大して見る
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleBreakShield(c, inspectedShieldSlot.slot)}
                      className="w-full py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-extrabold shadow"
                    >
                      💥 シールドブレイクする
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setInspectedShieldSlot(null)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-xs font-bold"
            >
              ブレイクせずに閉じる
            </button>
          </div>
        </div>
      )}

      {/* ================= シールド複数同時チェックモーダル ================= */}
      {shieldCheckQueue.length > 0 && (
        <div
          onClick={() => setShieldCheckQueue([])}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-amber-400 rounded-2xl p-4 max-w-3xl w-full max-h-[90vh] flex flex-col space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-sm sm:text-base text-amber-300">
                🛡️ 選択したシールドを同時確認中（{shieldCheckQueue.length}枚）
              </h3>
              <button
                type="button"
                onClick={() => setShieldCheckQueue([])}
                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>
            <div className="overflow-x-auto flex gap-3 py-2 items-center">
              {shieldCheckQueue.map((c) => (
                <div
                  key={c.instanceId}
                  onClick={() => setInspectCard({ card: c, ownerName: me?.name || '自分' })}
                  className="cursor-pointer bg-slate-800 border border-amber-400/70 rounded-xl p-2 flex flex-col items-center w-28 sm:w-32 shrink-0 hover:scale-105 transition"
                >
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.imageUrl}
                      alt={c.name}
                      className="w-24 h-34 object-cover rounded border border-slate-600"
                    />
                  ) : (
                    <div className="w-24 h-34 bg-slate-700 rounded flex items-center justify-center text-xs font-bold text-center p-1">
                      {c.name}
                    </div>
                  )}
                  <span className="text-[11px] font-bold truncate w-full text-center mt-1.5">
                    {c.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ================= 相手に手札を見せるカード選択モーダル ================= */}
      {!isSpectator && handRevealModalOpen && (
        <div
          onClick={() => setHandRevealModalOpen(false)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-fuchsia-400 rounded-2xl p-4 max-w-2xl w-full max-h-[90vh] flex flex-col space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-sm sm:text-base text-fuchsia-300">
                🃏 相手に見せる手札を選択（{selectedRevealHandIds.length}枚選択中）
              </h3>
              <button
                type="button"
                onClick={() => setHandRevealModalOpen(false)}
                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>

            {hand.length === 0 ? (
              <p className="text-xs text-slate-400 py-8 text-center">手札がありません</p>
            ) : (
              <div className="overflow-x-auto flex gap-2.5 py-2 items-center">
                {hand.map((c) => {
                  const picked = selectedRevealHandIds.includes(c.instanceId);
                  return (
                    <div
                      key={c.instanceId}
                      onClick={() => toggleRevealHandCard(c.instanceId)}
                      className={`cursor-pointer rounded-xl p-2 border-2 flex flex-col items-center w-24 sm:w-28 shrink-0 transition ${
                        picked
                          ? 'bg-fuchsia-900/70 border-fuchsia-300 scale-105'
                          : 'bg-slate-800 border-slate-700 opacity-75'
                      }`}
                    >
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.imageUrl}
                          alt={c.name}
                          className="w-20 h-28 object-cover rounded"
                        />
                      ) : (
                        <div className="w-20 h-28 bg-slate-700 rounded flex items-center justify-center text-[10px] font-bold text-center p-1">
                          {c.name}
                        </div>
                      )}
                      <span className="text-[10px] font-bold truncate w-full text-center mt-1">
                        {c.name}
                      </span>
                      <span
                        className={`mt-1 px-2 py-0.5 rounded text-[9px] font-extrabold ${
                          picked ? 'bg-fuchsia-400 text-slate-950' : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {picked ? '✓ 見せる' : '隠す'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex gap-2 pt-2 border-t border-slate-700">
              <button
                type="button"
                onClick={() => setHandRevealModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-xs font-bold"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handlePublishSelectedHand}
                className="flex-[2] py-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-xl text-xs sm:text-sm font-extrabold"
              >
                👁️ 選択した {selectedRevealHandIds.length} 枚を相手に見せる！
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 通常攻撃（シールド／相手キャラ指定）に対するブロッカー選択モーダル ================= */}
      {!isSpectator && targetBlockModalOpen && activeAttackTarget && (
        <div
          onClick={() => setTargetBlockModalOpen(false)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-sky-400 rounded-2xl p-4 max-w-lg w-full space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-sm sm:text-base text-sky-300">
                🛡️ 「{activeAttackTarget.attackerCardName}」をブロックするクリーチャーを選択
              </h3>
              <button
                type="button"
                onClick={() => setTargetBlockModalOpen(false)}
                className="px-2.5 py-1 bg-slate-700 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>

            {battleZone.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">
                バトルゾーンにクリーチャーがいません
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[55vh] overflow-y-auto">
                {battleZone.map((c) => {
                  const img =
                    c.kindanRole && c.kindanAwakened && c.kindanAwakenedImageUrl
                      ? c.kindanAwakenedImageUrl
                      : c.imageUrl;
                  return (
                    <button
                      key={c.instanceId}
                      type="button"
                      onClick={() => handleBlockTargetedAttack(c)}
                      className={`bg-slate-800 hover:bg-sky-900 border border-sky-400/70 rounded-xl p-2 flex flex-col items-center space-y-1.5 transition ${
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
                      <div className="text-[11px] font-bold truncate w-full text-center">
                        {c.name}
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
        </div>
      )}

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
                  🛡️ ブロックする！（場のクリーチャー）
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

      {/* ================= ダイレクトアタック宣言クリーチャー選択モーダル ================= */}
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
                わんちゃん勝てるかもなぁ、どう？嬉しいやろ？嬉しいくせに
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
              <div className="flex flex-col items-center w-full">
                <div
                  className="transition-transform duration-200 flex items-center justify-center"
                  style={{
                    transform: `rotate(${inspectRotationDeg}deg)`,
                    margin: Math.abs(inspectRotationDeg) % 180 === 90 ? '36px 0' : '0',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
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
                    className="w-[80vw] max-w-[340px] h-[50vh] max-h-[440px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl cursor-pointer"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setInspectRotationDeg((prev) => (prev - 90) % 360)}
                  className="mt-2 px-3.5 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-extrabold text-slate-100 shadow active:scale-95 transition"
                >
                  🔄 表示を回転
                </button>
              </div>
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
                <>
                  <button
                    onClick={() => handleToggleOpponentIgnore(inspectCard.card)}
                    className={`w-full py-2.5 font-extrabold rounded-xl text-xs sm:text-sm shadow-lg transition ${
                      inspectCard.card.ignored
                        ? 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                        : 'bg-slate-700 hover:bg-slate-600 border border-slate-400 text-white'
                    }`}
                  >
                    {inspectCard.card.ignored
                      ? '☀️ 元の明るさに戻す'
                      : '🌑 暗くする'}
                  </button>

                  {/* 🎯 このクリーチャーを選択 */}
                  <div className="w-full space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowTargetMoveMenu((prev) => !prev)}
                      className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold rounded-xl text-xs sm:text-sm shadow-lg transition"
                    >
                      🎯 このクリーチャーを選択 {showTargetMoveMenu ? '▲' : '▼'}
                    </button>

                    {showTargetMoveMenu && (
                      <div className="grid grid-cols-5 gap-1.5 p-2 rounded-xl bg-slate-800 border border-amber-400/70">
                        {[
                          { label: '山札', icon: '📚' },
                          { label: '墓地', icon: '🪦' },
                          { label: '手札', icon: '✋' },
                          { label: 'マナ', icon: '💎' },
                          { label: 'シールド', icon: '🛡️' },
                        ].map((dest) => (
                          <button
                            key={dest.label}
                            type="button"
                            onClick={() =>
                              handleAnnounceOpponentCreatureTarget(
                                inspectCard.card,
                                dest.label
                              )
                            }
                            className="py-2 px-1 bg-slate-700 hover:bg-amber-500 hover:text-slate-950 text-white rounded-lg text-[11px] font-extrabold flex flex-col items-center gap-0.5 transition active:scale-95"
                          >
                            <span>{dest.icon}</span>
                            <span>{dest.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
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

      {/* ================= 山札の上から1〜10枚めくり選択モーダル ================= */}
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
                  全力で楽しめよぉ
                </p>
              </div>
              {!peekState.isPublic && me && (
                <button
                  onClick={async () => {
                    setPeekState({ ...peekState, isPublic: true });
                    await applyRoomUpdate(
                      (cur) => ({
                        ...cur,
                        inspectingText: `${me.name} が山札の上から ${peekState.cards.length} 枚を公開中！`,
                        publicReveal: {
                          playerName: me.name,
                          cards: peekState.cards,
                        },
                      }),
                      undefined,
                      true
                    );
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
              <div className="flex flex-col items-center">
                <div
                  className="transition-transform duration-200 flex items-center justify-center"
                  style={{
                    transform: `rotate(${selectedRotationDeg}deg)`,
                    margin: Math.abs(selectedRotationDeg) % 180 === 90 ? '32px 0' : '0',
                  }}
                >
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
                    className="w-[78vw] max-w-[330px] h-[44vh] max-h-[400px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-xl"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedRotationDeg((prev) => (prev - 90) % 360)}
                  className="mt-2 px-3.5 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-extrabold text-slate-100 shadow active:scale-95 transition"
                >
                  🔄 表示を90°回転（反時計回り）
                </button>
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
                    setSelectedCard(null);
                    handleBreakShield(c);
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
                    🧬 進化
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
                    onClick={() => openAttackTargeting(selectedCard.card)}
                    className="py-2.5 bg-rose-600 hover:bg-rose-500 rounded col-span-2 text-sm border border-yellow-300/60"
                  >
                    🎯 攻撃先を指定して攻撃（盾・相手キャラ）
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
                        await applyRoomUpdate((cur) => cur, {
                          sound: 'ability',
                          cutIn: {
                            type: 'ability',
                            playerName: me.name,
                            card: c,
                            subText: '能力発動！',
                          },
                        });
                      }
                    }}
                    className="py-2 bg-cyan-600 hover:bg-cyan-500 rounded"
                  >
                    ⚡ 能力発動でカード提示
                  </button>
                  {isD2FieldCard(selectedCard.card) && (
                    <button
                      onClick={() => handleActivateD2Switch(selectedCard.card)}
                      className={`py-2 rounded col-span-2 font-extrabold border transition shadow ${
                        selectedCard.card.d2Switched
                          ? 'bg-slate-700 hover:bg-slate-600 text-cyan-200 border-cyan-500/50'
                          : 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white border-cyan-300'
                      }`}
                    >
                      {selectedCard.card.d2Switched
                        ? '🔄 D2スイッチを未使用状態に戻す（現在：発動済み）'
                        : '🌀🔄 D2スイッチ発動！！（専用SE＆カットイン）'}
                    </button>
                  )}
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
                      シールドへ(裏向き)
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

                <div className="bg-amber-950/50 border border-amber-500/40 rounded-lg p-2 space-y-1.5">
                  <div className="text-[10px] font-bold text-amber-300 text-center">
                    🛡️ 表向きシールドとして乗せる（どのシールドの上に乗せるか選択）
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
                    <img
                      src={c.imageUrl}
                      alt={c.name}
                      className="w-8 h-11 object-cover rounded shrink-0"
                    />
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
                      <img
                        src={c.imageUrl}
                        alt={c.name}
                        className="w-8 h-11 object-cover rounded shrink-0"
                      />
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

      {/* ================= 自分の墓地 ================= */}
      {graveSearchOpen && (
        <div
          onClick={() => {
            setGraveSearchOpen(false);
            setSelectedGraveCard(null);
          }}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border-2 border-rose-500/70 rounded-2xl p-4 max-w-3xl w-full max-h-[90vh] overflow-y-auto flex flex-col space-y-3 shadow-2xl"
          >
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-extrabold text-sm sm:text-base text-rose-300">
                  {me?.name || '自分'}の墓地 ({graveyard.length}枚)
                </h3>
                <p className="text-[11px] text-slate-400">
                  墓地の画質悪くてごめんやでぃ
                </p>
              </div>
              <button
                onClick={() => {
                  setGraveSearchOpen(false);
                  setSelectedGraveCard(null);
                }}
                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>

            {graveyard.length === 0 ? (
              <p className="text-xs text-slate-400 py-8 text-center">墓地にカードはありません</p>
            ) : (
              <div className="overflow-x-auto flex gap-2.5 py-2 items-center min-h-[116px]">
                {graveyard.map((c) => {
                  const isPicked = selectedGraveCard?.instanceId === c.instanceId;
                  return (
                    <div
                      key={c.instanceId}
                      onClick={() =>
                        setSelectedGraveCard((prev) =>
                          prev?.instanceId === c.instanceId ? null : c
                        )
                      }
                      className={`cursor-pointer rounded-xl p-1.5 border-2 flex flex-col items-center w-20 sm:w-24 shrink-0 transition ${
                        isPicked
                          ? 'bg-amber-900/60 border-amber-400 scale-105'
                          : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.imageUrl}
                          alt={c.name}
                          className="w-16 h-24 object-cover rounded border border-slate-600"
                        />
                      ) : (
                        <div className="w-16 h-24 bg-slate-700 rounded flex items-center justify-center text-[10px] font-bold text-center p-1">
                          {c.name}
                        </div>
                      )}
                      <span className="text-[10px] font-bold truncate w-full text-center mt-1">
                        {c.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!isSpectator && selectedGraveCard && (
              <div className="bg-slate-950 border border-amber-400/60 rounded-xl p-3 space-y-3">
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  {selectedGraveCard.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={selectedGraveCard.imageUrl}
                      alt={selectedGraveCard.name}
                      onClick={() =>
                        setInspectCard({
                          card: selectedGraveCard,
                          ownerName: me?.name || '自分',
                        })
                      }
                      className="cursor-pointer w-36 h-52 sm:w-44 sm:h-64 object-contain rounded-xl border-2 border-amber-400/80 bg-slate-900 shadow-xl shrink-0"
                    />
                  ) : (
                    <div className="w-36 h-52 bg-slate-800 rounded-xl flex items-center justify-center text-xs font-bold text-center p-2 shrink-0">
                      {selectedGraveCard.name}
                    </div>
                  )}

                  <div className="flex-1 w-full space-y-2">
                    <div className="text-xs sm:text-sm font-extrabold text-amber-300">
                      選択中：「{selectedGraveCard.name}」
                    </div>
                    <p className="text-[11px] text-slate-400">
                      
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs font-bold">
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'hand')}
                        className="py-2 bg-sky-600 hover:bg-sky-500 rounded-lg"
                      >
                        手札へ
                      </button>
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'battleZone')}
                        className="py-2 bg-amber-600 hover:bg-amber-500 rounded-lg"
                      >
                        場に出す
                      </button>
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'mana')}
                        className="py-2 bg-lime-700 hover:bg-lime-600 rounded-lg"
                      >
                        マナへ
                      </button>
                      <button
                        onClick={() => {
                          const target = selectedGraveCard;
                          setGraveSearchOpen(false);
                          setSelectedGraveCard(null);
                          setEvolutionBuilder({
                            evolvingCard: target,
                            fromZone: 'graveyard',
                            activeTab: normalBattleZone.length > 0 ? 'battleZone' : 'graveyard',
                            selectedMaterials: [],
                          });
                        }}
                        className="py-2 bg-purple-600 hover:bg-purple-500 rounded-lg"
                      >
                        🧬 進化
                      </button>
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'shields')}
                        className="py-2 bg-amber-800 hover:bg-amber-700 rounded-lg"
                      >
                        シールドへ(裏)
                      </button>
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'deckTop')}
                        className="py-2 bg-indigo-700 hover:bg-indigo-600 rounded-lg"
                      >
                        山札の上へ
                      </button>
                      <button
                        onClick={() => moveCard(selectedGraveCard, 'graveyard', 'deckBottom')}
                        className="py-2 bg-indigo-900 hover:bg-indigo-800 rounded-lg col-span-2 sm:col-span-3"
                      >
                        山札の下へ
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* ================= ダイレクトアタック動画カットイン ================= */}
      <DirectAttackVideoOverlay
        data={activeVideoCutIn}
        onComplete={() => setActiveVideoCutIn(null)}
      />

      {/* ================= 相手（プレイヤー1）の墓地確認モーダル（横並びカード表示） ================= */}
      {oppGraveViewOpen && opponent && (
        <div
          onClick={() => setOppGraveViewOpen(false)}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-rose-500/60 rounded-2xl p-4 max-w-3xl w-full max-h-[85vh] flex flex-col space-y-3"
          >
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm text-rose-300">
                {opponent.name}の墓地 ({oppGraveyard.length}枚) 
              </h3>
              <button
                onClick={() => setOppGraveViewOpen(false)}
                className="px-3 py-1 bg-slate-700 rounded text-xs font-bold"
              >
                閉じる
              </button>
            </div>
            {oppGraveyard.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">墓地にカードはありません</p>
            ) : (
              <div className="overflow-x-auto flex gap-2.5 py-2 items-center min-h-[120px]">
                {oppGraveyard.map((c) => (
                  <div
                    key={c.instanceId}
                    onClick={() => setInspectCard({ card: c, ownerName: opponent.name })}
                    className="cursor-pointer bg-slate-800 border border-slate-700 hover:border-amber-400 rounded-xl p-1.5 flex flex-col items-center w-20 sm:w-24 shrink-0 transition"
                  >
                    {c.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.imageUrl}
                        alt={c.name}
                        className="w-16 h-24 object-cover rounded border border-slate-600"
                      />
                    ) : (
                      <div className="w-16 h-24 bg-slate-700 rounded flex items-center justify-center text-[10px] font-bold text-center p-1">
                        {c.name}
                      </div>
                    )}
                    <span className="text-[10px] font-bold truncate w-full text-center mt-1">
                      {c.name}
                    </span>
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