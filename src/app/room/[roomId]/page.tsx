'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ref, onValue, update, get } from 'firebase/database';
import { db } from '@/lib/firebase';
import { CardData, CardInstance, GameRoom, PlayerState } from '@/types/game';
import { DeckPreset } from '@/data/decks';
import CutInOverlay, { CutInEvent } from '@/components/CutInOverlay';

type ZoneType = 'hand' | 'mana' | 'battleZone' | 'shields' | 'graveyard';
type EvolutionSourceZone = 'battleZone' | 'mana' | 'graveyard' | 'hand' | 'deck';

interface SelectedEvolutionMaterial {
  card: CardInstance;
  sourceZone: EvolutionSourceZone;
}

function createDeckInstances(cards: CardData[]): CardInstance[] {
  const instances: CardInstance[] = cards.map((card, index) => ({
    ...card,
    instanceId: `${card.id}-${index}-${Math.random().toString(36).substring(2, 7)}`,
    tapped: false,
    faceUp: false,
    underCards: [],
  }));
  for (let i = instances.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [instances[i], instances[j]] = [instances[j], instances[i]];
  }
  return instances;
}

function BattleRoomContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = (params.roomId as string)?.trim();

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string>('');

  // 自分のカード選択（操作＆超拡大表示）
  const [selectedCard, setSelectedCard] = useState<{
    card: CardInstance;
    zone: ZoneType;
  } | null>(null);

  // 相手（または観戦中）の表向きカード拡大プレビュー専用モーダル
  const [inspectCard, setInspectCard] = useState<{
    card: CardInstance;
    ownerName: string;
  } | null>(null);

  // シールドブレイク直後の秘匿確認モーダル
  const [brokenShieldCard, setBrokenShieldCard] = useState<CardInstance | null>(null);

  // 1つ戻る（Undo）用の操作履歴スタック
  const [undoStack, setUndoStack] = useState<string[]>([]);

  // 山札全確認モーダル
  const [deckSearchOpen, setDeckSearchOpen] = useState(false);

  // 墓地全確認モーダル
  const [graveSearchOpen, setGraveSearchOpen] = useState(false);

  // 山札の上から見る枚数（1〜10枚）
  const [peekCount, setPeekCount] = useState<number>(4);

  // 山札の上からN枚めくって見るモーダル（自分だけ or 相手にも公開）
  const [peekState, setPeekState] = useState<{
    cards: CardInstance[];
    isPublic: boolean;
  } | null>(null);

  // 自由進化ビルダー（場・マナ・墓地・手札・山札から複数枚選んで進化元にする）
  const [evolutionBuilder, setEvolutionBuilder] = useState<{
    evolvingCard: CardInstance;
    fromZone: 'hand' | 'mana' | 'graveyard';
    activeTab: EvolutionSourceZone;
    selectedMaterials: SelectedEvolutionMaterial[];
  } | null>(null);

  // 革命チェンジの対象選択モーダル
  const [revolutionChangePending, setRevolutionChangePending] = useState<{
    card: CardInstance;
    fromZone: 'hand' | 'mana' | 'graveyard';
  } | null>(null);

  const [resetting, setResetting] = useState(false);

  // 相手に見せる「今何をしているか」の通知
  const setInspectingStatus = async (text: string | null) => {
    if (!roomId) return;
    await update(ref(db, `rooms/${roomId}`), {
      inspectingText: text,
    });
  };

  // 両者＆観戦者の画面中央にカードをデカデカとスッと提示する
  const triggerCutIn = async (
    type: CutInEvent['type'],
    playerName: string,
    card: CardInstance,
    subText?: string
  ) => {
    if (!roomId) return;
    const event: CutInEvent = {
      id: Math.random().toString(36).substring(2, 9),
      type,
      playerName,
      cardName: card.name,
      imageUrl: card.imageUrl,
      subText,
      timestamp: Date.now(),
    };
    await update(ref(db, `rooms/${roomId}`), {
      cutIn: event,
    });
  };

  useEffect(() => {
    const savedId = localStorage.getItem('dm_player_id') || '';
    setMyPlayerId(savedId);

    if (!roomId) return;
    const roomRef = ref(db, `rooms/${roomId}`);
    const unsubscribe = onValue(roomRef, (snapshot) => {
      if (snapshot.exists()) {
        setRoom(snapshot.val() as GameRoom);
      } else {
        alert('部屋が見つかりません');
        router.push('/');
      }
    });

    return () => unsubscribe();
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

  const updateMyState = async (newState: Partial<PlayerState>, recordUndo = true) => {
    if (!me || isSpectator) return;

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

    await update(ref(db, `rooms/${roomId}/players/${myPlayerId}`), newState);
  };

  // 【1つ戻る（Undo）】
  const handleUndo = async () => {
    if (isSpectator || undoStack.length === 0 || !me) return;
    const lastSnapshotStr = undoStack[undoStack.length - 1];
    const restored = JSON.parse(lastSnapshotStr);
    setUndoStack((prev) => prev.slice(0, -1));
    setPeekState(null);
    setSelectedCard(null);
    setBrokenShieldCard(null);
    setEvolutionBuilder(null);
    await update(ref(db, `rooms/${roomId}`), {
      inspectingText: null,
      publicReveal: null,
    });
    await update(ref(db, `rooms/${roomId}/players/${myPlayerId}`), restored);
  };

  // 【試合リセット】
  const handleResetMatch = async () => {
    if (isSpectator) return;
    if (
      !confirm(
        '現在の試合を強制終了し、両プレイヤーの山札をシャッフルして最初から（シールド5枚・手札5枚）やり直しますか？'
      )
    ) {
      return;
    }

    setResetting(true);
    try {
      const updatedPlayers: Record<string, PlayerState> = {};

      for (const pid of playerIds) {
        const p = playersObj[pid];
        let baseCards: CardData[] = [];

        if (p.deckId) {
          const deckSnap = await get(ref(db, `customDecks/${p.deckId}`));
          if (deckSnap.exists()) {
            const preset = deckSnap.val() as DeckPreset;
            baseCards = preset.cards || [];
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
            collected.push(bz);
            if (bz.underCards) collected.push(...bz.underCards);
          });
          baseCards = collected;
        }

        const shuffled = createDeckInstances(baseCards);
        const shields = shuffled.slice(0, 5).map((c) => ({ ...c, faceUp: false }));
        const hand = shuffled.slice(5, 10).map((c) => ({ ...c, faceUp: true }));
        const deck = shuffled.slice(10);

        updatedPlayers[pid] = {
          ...p,
          deck,
          hand,
          mana: [],
          shields,
          battleZone: [],
          graveyard: [],
        };
      }

      const firstPlayerId = playerIds[0] || myPlayerId;
      await update(ref(db, `rooms/${roomId}`), {
        players: updatedPlayers,
        turnPlayerId: firstPlayerId,
        turnCount: 1,
        inspectingText: null,
        cutIn: null,
        publicReveal: null,
      });

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

  const deck = me?.deck || [];
  const hand = me?.hand || [];
  const mana = me?.mana || [];
  const shields = me?.shields || [];
  const battleZone = me?.battleZone || [];
  const graveyard = me?.graveyard || [];

  const oppDeck = opponent?.deck || [];
  const oppHand = opponent?.hand || [];
  const oppMana = opponent?.mana || [];
  const oppShields = opponent?.shields || [];
  const oppBattleZone = opponent?.battleZone || [];
  const oppGraveyard = opponent?.graveyard || [];

  const handleTopDeckTo = async (dest: 'hand' | 'mana' | 'graveyard' | 'shields') => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const newDeck = [...deck];
    const topCard = newDeck.shift()!;
    const updatedCard: CardInstance = {
      ...topCard,
      tapped: false,
      faceUp: dest !== 'shields',
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
    const untappedBZ = battleZone.map((c) => ({ ...c, tapped: false }));
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
    await update(ref(db, `rooms/${roomId}`), {
      turnPlayerId: topPlayerId,
      turnCount: (room.turnCount || 1) + 1,
    });
  };

  // 【新機能】山札の上から1〜10枚めくる（「自分だけ見る」or「相手にも見せてめくる」）
  const handlePeekTopDeck = async (count: number, isPublic: boolean) => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const actualCount = Math.min(count, deck.length);
    const newDeck = [...deck];
    const revealed = newDeck.splice(0, actualCount).map((c) => ({ ...c, faceUp: true }));

    await updateMyState({ deck: newDeck });

    if (isPublic) {
      await update(ref(db, `rooms/${roomId}`), {
        inspectingText: `${me.name} が山札の上から ${actualCount} 枚を公開中！`,
        publicReveal: {
          playerName: me.name,
          cards: revealed,
        },
      });
    } else {
      await setInspectingStatus(`${me.name} が山札の上から ${actualCount} 枚を非公開で確認中...`);
    }

    setPeekState({ cards: revealed, isPublic });
  };

  const handleMoveFromPeek = async (
    picked: CardInstance,
    dest: 'hand' | 'battleZone' | 'mana' | 'graveyard'
  ) => {
    if (!peekState || !me || isSpectator) return;
    const remaining = peekState.cards.filter((c) => c.instanceId !== picked.instanceId);
    const updatedCard: CardInstance = { ...picked, faceUp: true, tapped: false };

    if (dest === 'hand') {
      await updateMyState({ hand: [...hand, updatedCard] });
    } else if (dest === 'battleZone') {
      await updateMyState({ battleZone: [...battleZone, updatedCard] });
      await triggerCutIn('summon', me.name, updatedCard, '山札からバトルゾーンへ！');
    } else if (dest === 'mana') {
      await updateMyState({ mana: [...mana, updatedCard] });
    } else if (dest === 'graveyard') {
      await updateMyState({ graveyard: [...graveyard, updatedCard] });
    }

    if (remaining.length === 0) {
      setPeekState(null);
      await update(ref(db, `rooms/${roomId}`), {
        inspectingText: null,
        publicReveal: null,
      });
    } else {
      setPeekState({ ...peekState, cards: remaining });
      if (peekState.isPublic) {
        await update(ref(db, `rooms/${roomId}`), {
          publicReveal: {
            playerName: me.name,
            cards: remaining,
          },
        });
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
    await update(ref(db, `rooms/${roomId}`), {
      inspectingText: null,
      publicReveal: null,
    });
  };

  const moveCard = async (
    card: CardInstance,
    fromZone: ZoneType,
    toZone: ZoneType | 'deckTop' | 'deckBottom'
  ) => {
    if (!me || isSpectator) return;

    const removeFrom = (list: CardInstance[]) =>
      list.filter((c) => c.instanceId !== card.instanceId);

    let nextDeck = [...deck];
    let nextHand = [...hand];
    let nextMana = [...mana];
    let nextShields = [...shields];
    let nextBZ = [...battleZone];
    let nextGrave = [...graveyard];

    if (fromZone === 'hand') nextHand = removeFrom(nextHand);
    if (fromZone === 'mana') nextMana = removeFrom(nextMana);
    if (fromZone === 'battleZone') nextBZ = removeFrom(nextBZ);
    if (fromZone === 'shields') nextShields = removeFrom(nextShields);
    if (fromZone === 'graveyard') nextGrave = removeFrom(nextGrave);

    const cleanCard: CardInstance = {
      ...card,
      tapped: false,
      faceUp: toZone !== 'shields' && toZone !== 'deckTop' && toZone !== 'deckBottom',
      underCards: toZone === 'battleZone' ? card.underCards || [] : [],
    };

    if (toZone === 'hand') nextHand.push(cleanCard);
    if (toZone === 'mana') nextMana.push(cleanCard);
    if (toZone === 'battleZone') nextBZ.push(cleanCard);
    if (toZone === 'shields') nextShields.push(cleanCard);
    if (toZone === 'graveyard') nextGrave.push(cleanCard);
    if (toZone === 'deckTop') nextDeck.unshift(cleanCard);
    if (toZone === 'deckBottom') nextDeck.push(cleanCard);

    await updateMyState({
      deck: nextDeck,
      hand: nextHand,
      mana: nextMana,
      shields: nextShields,
      battleZone: nextBZ,
      graveyard: nextGrave,
    });
    setSelectedCard(null);

    if (toZone === 'battleZone') {
      const originLabel =
        fromZone === 'mana'
          ? 'マナゾーンから登場！'
          : fromZone === 'graveyard'
          ? '墓地から登場！'
          : 'バトルゾーンに登場！';
      await triggerCutIn('summon', me.name, cleanCard, originLabel);
    }
  };

  const toggleTap = async (card: CardInstance, zone: 'mana' | 'battleZone') => {
    if (!me || isSpectator) return;
    const list = zone === 'mana' ? mana : battleZone;
    const updated = list.map((c) =>
      c.instanceId === card.instanceId ? { ...c, tapped: !c.tapped } : c
    );
    await updateMyState({ [zone]: updated });
    setSelectedCard(null);
  };

  const handleAttackDeclare = async (attacker: CardInstance) => {
    if (!me || isSpectator) return;
    const updatedBZ = battleZone.map((c) =>
      c.instanceId === attacker.instanceId ? { ...c, tapped: true } : c
    );
    await updateMyState({ battleZone: updatedBZ });
    setSelectedCard(null);

    await triggerCutIn('attack', me.name, attacker, 'クリーチャーで攻撃宣言！');
  };

  // シールドブレイク処理（相手に見せず直接手札へ＋自分だけ確認モーダル）
  const handleBreakShield = async (card: CardInstance) => {
    if (!me || isSpectator) return;
    const nextShields = shields.filter((c) => c.instanceId !== card.instanceId);
    const addedToHand: CardInstance = {
      ...card,
      faceUp: true,
      tapped: false,
      underCards: [],
    };
    const nextHand = [...hand, addedToHand];

    await updateMyState({
      shields: nextShields,
      hand: nextHand,
    });

    setBrokenShieldCard(addedToHand);
  };

  // 【新機能】自由進化の選択トグル（場・マナ・墓地・手札・山札から複数枚チェック）
  const toggleEvolutionMaterial = (card: CardInstance, sourceZone: EvolutionSourceZone) => {
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

  // 【新機能】自由進化の確定実行（選ばれた複数枚をすべて下に重ねて場に出す）
  const handleConfirmFreeEvolution = async () => {
    if (!me || isSpectator || !evolutionBuilder) return;
    const { evolvingCard, fromZone, selectedMaterials } = evolutionBuilder;

    if (selectedMaterials.length === 0) {
      return alert('進化元（下に敷くカード）を1枚以上選んでください');
    }

    let nextDeck = [...deck];
    let nextHand = [...hand];
    let nextMana = [...mana];
    let nextGrave = [...graveyard];
    let nextBZ = [...battleZone];

    // 1. 進化クリーチャー本体を元ゾーンから取り除く
    if (fromZone === 'hand') {
      nextHand = nextHand.filter((c) => c.instanceId !== evolvingCard.instanceId);
    } else if (fromZone === 'mana') {
      nextMana = nextMana.filter((c) => c.instanceId !== evolvingCard.instanceId);
    } else if (fromZone === 'graveyard') {
      nextGrave = nextGrave.filter((c) => c.instanceId !== evolvingCard.instanceId);
    }

    // 2. 選択されたすべての進化元カードを取り出し、重ねるリストを構築
    const collectedUnderCards: CardInstance[] = [];
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
          // 既に進化元を持っていた場合はそれも引き継ぐ
          if (found.underCards && found.underCards.length > 0) {
            collectedUnderCards.push(
              ...found.underCards.map((u) => ({ ...u, tapped: false, faceUp: true, underCards: [] }))
            );
          }
          collectedUnderCards.push({ ...found, tapped: false, faceUp: true, underCards: [] });
        }
      } else if (mat.sourceZone === 'mana') {
        nextMana = nextMana.filter((c) => c.instanceId !== mat.card.instanceId);
        collectedUnderCards.push({ ...mat.card, tapped: false, faceUp: true, underCards: [] });
      } else if (mat.sourceZone === 'graveyard') {
        nextGrave = nextGrave.filter((c) => c.instanceId !== mat.card.instanceId);
        collectedUnderCards.push({ ...mat.card, tapped: false, faceUp: true, underCards: [] });
      } else if (mat.sourceZone === 'hand') {
        nextHand = nextHand.filter((c) => c.instanceId !== mat.card.instanceId);
        collectedUnderCards.push({ ...mat.card, tapped: false, faceUp: true, underCards: [] });
      } else if (mat.sourceZone === 'deck') {
        nextDeck = nextDeck.filter((c) => c.instanceId !== mat.card.instanceId);
        collectedUnderCards.push({ ...mat.card, tapped: false, faceUp: true, underCards: [] });
      }
    }

    const evolvedCard: CardInstance = {
      ...evolvingCard,
      tapped: inheritedTapState,
      faceUp: true,
      underCards: collectedUnderCards,
    };

    if (firstBZAnchorId) {
      // バトルゾーンにいた進化元が選ばれている場合：2体目以降のBZ素材を消し、1体目の位置に置き換える
      nextBZ = nextBZ
        .filter((c) => !bzIdsToRemove.has(c.instanceId))
        .map((c) => (c.instanceId === firstBZAnchorId ? evolvedCard : c));
    } else {
      // マナ進化・墓地進化・デッキ進化など：新しくバトルゾーンに出現
      nextBZ.push(evolvedCard);
    }

    // 山札から進化元を選んでいた場合は自動で山札シャッフル
    const usedDeck = selectedMaterials.some((m) => m.sourceZone === 'deck');
    if (usedDeck && nextDeck.length > 1) {
      for (let i = nextDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nextDeck[i], nextDeck[j]] = [nextDeck[j], nextDeck[i]];
      }
    }

    await updateMyState({
      deck: nextDeck,
      hand: nextHand,
      mana: nextMana,
      graveyard: nextGrave,
      battleZone: nextBZ,
    });

    const sourceNames = selectedMaterials.map((m) => m.card.name).join('・');
    setEvolutionBuilder(null);
    setSelectedCard(null);

    await triggerCutIn(
      'evolution',
      me.name,
      evolvedCard,
      `進化！（下敷き ${selectedMaterials.length}枚：${sourceNames}）`
    );
  };

  // 革命チェンジ実行
  const handleExecuteRevolutionChange = async (targetCard: CardInstance) => {
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

    const returnedCards: CardInstance[] = [
      { ...targetCard, tapped: false, faceUp: true, underCards: [] },
      ...(targetCard.underCards || []).map((u) => ({
        ...u,
        tapped: false,
        faceUp: true,
        underCards: [],
      })),
    ];
    nextHand = [...nextHand, ...returnedCards];

    const changedCard: CardInstance = {
      ...incomingCard,
      tapped: targetCard.tapped,
      faceUp: true,
      underCards: [],
    };

    const nextBZ = battleZone.map((c) =>
      c.instanceId === targetCard.instanceId ? changedCard : c
    );

    await updateMyState({
      hand: nextHand,
      mana: nextMana,
      graveyard: nextGrave,
      battleZone: nextBZ,
    });

    setRevolutionChangePending(null);
    setSelectedCard(null);

    await triggerCutIn(
      'evolution',
      me.name,
      changedCard,
      `革命チェンジ！（『${targetCard.name}』は手札へ）`
    );
  };

  const handleExtractUnderCard = async (
    topCard: CardInstance,
    underCard: CardInstance,
    dest: 'hand' | 'graveyard' | 'mana'
  ) => {
    if (!me || isSpectator) return;
    const remainingUnder = (topCard.underCards || []).filter(
      (u) => u.instanceId !== underCard.instanceId
    );
    const updatedTop: CardInstance = { ...topCard, underCards: remainingUnder };
    const nextBZ = battleZone.map((c) =>
      c.instanceId === topCard.instanceId ? updatedTop : c
    );
    const movedUnder: CardInstance = { ...underCard, tapped: false, faceUp: true };

    await updateMyState({
      battleZone: nextBZ,
      ...(dest === 'hand' ? { hand: [...hand, movedUnder] } : {}),
      ...(dest === 'graveyard' ? { graveyard: [...graveyard, movedUnder] } : {}),
      ...(dest === 'mana' ? { mana: [...mana, movedUnder] } : {}),
    });

    setSelectedCard({ card: updatedTop, zone: 'battleZone' });
  };

  const handleMoveFromDeckSearch = async (
    card: CardInstance,
    toZone: 'hand' | 'battleZone' | 'mana' | 'graveyard' | 'shields'
  ) => {
    if (!me || isSpectator) return;
    const nextDeck = deck.filter((c) => c.instanceId !== card.instanceId);
    const updatedCard: CardInstance = {
      ...card,
      tapped: false,
      faceUp: toZone !== 'shields',
    };

    if (toZone === 'hand') {
      await updateMyState({ deck: nextDeck, hand: [...hand, updatedCard] });
    } else if (toZone === 'battleZone') {
      await updateMyState({ deck: nextDeck, battleZone: [...battleZone, updatedCard] });
      await triggerCutIn('summon', me.name, updatedCard, '山札からバトルゾーンへ！');
    } else if (toZone === 'mana') {
      await updateMyState({ deck: nextDeck, mana: [...mana, updatedCard] });
    } else if (toZone === 'graveyard') {
      await updateMyState({ deck: nextDeck, graveyard: [...graveyard, updatedCard] });
    } else if (toZone === 'shields') {
      await updateMyState({ deck: nextDeck, shields: [...shields, updatedCard] });
    }
  };

  // カード表示コンポーネント
  const renderCard = (
    card: CardInstance,
    zone: ZoneType,
    isControllable: boolean,
    ownerName: string,
    index?: number
  ) => {
    const showFace = card.faceUp || (isControllable && zone === 'hand');
    const underCount = card.underCards?.length || 0;
    const canClick = isControllable || showFace;

    return (
      <div
        key={card.instanceId}
        onClick={() => {
          if (!isControllable) {
            if (showFace) {
              setInspectCard({ card, ownerName });
            }
            return;
          }

          if (zone === 'shields' && !card.faceUp) {
            handleBreakShield(card);
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
            if (showFace) setInspectCard({ card, ownerName });
            return;
          }
          setSelectedCard({ card, zone });
        }}
        title={showFace ? `${card.name}（タップで拡大表示）` : '裏向きカード'}
        className={`relative select-none transition-transform ${
          canClick ? 'cursor-pointer active:scale-95' : 'cursor-default'
        } ${card.tapped ? 'rotate-90 mx-2.5 opacity-85' : ''} ${
          underCount > 0 ? 'mt-2 ml-1.5' : ''
        }`}
      >
        {underCount > 0 && (
          <div className="absolute -top-2 -left-1.5 w-full h-full rounded-md bg-purple-900 border border-purple-400 shadow-sm pointer-events-none" />
        )}

        <div
          className={`relative rounded-md shadow-md overflow-hidden flex flex-col justify-between ${
            showFace
              ? 'w-14 h-20 sm:w-16 sm:h-24 bg-slate-800 border border-slate-400 text-white'
              : 'w-12 h-16 sm:w-14 sm:h-20 bg-indigo-950 border-2 border-amber-500/70 text-amber-300 items-center justify-center'
          }`}
        >
          {showFace ? (
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
              </>
            ) : (
              <div className="p-1 flex flex-col justify-center items-center h-full">
                <div className="text-[9px] font-bold leading-tight line-clamp-3 text-center">
                  {card.name}
                </div>
              </div>
            )
          ) : (
            <span className="text-xs font-bold">{zone === 'shields' ? `S${(index ?? 0) + 1}` : 'DM'}</span>
          )}
        </div>
      </div>
    );
  };

  const tappedManaCount = mana.filter((c) => c.tapped).length;
  const untappedManaCount = mana.length - tappedManaCount;
  const turnOwnerName = playersObj[room.turnPlayerId]?.name || 'プレイヤー';

  // 相手が公開めくりを実行している時の表示データ
  const activePublicReveal =
    room.publicReveal && room.publicReveal.playerName !== me?.name ? room.publicReveal : null;

  // 自由進化ビルダーで現在選択中のタブに並べる候補カード一覧
  const getEvolutionCandidates = (): CardInstance[] => {
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

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-2 sm:p-4 max-w-6xl mx-auto">
      {/* 中央デカデカカード提示オーバーレイ */}
      <CutInOverlay event={room.cutIn} />

      {/* 上部バー */}
      <header className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 p-2.5 rounded-lg border border-slate-800">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-xs sm:text-sm bg-slate-800 px-2.5 py-1 rounded font-mono font-bold text-amber-400">
            ID: {room.roomId}
          </span>
          {isSpectator && (
            <span className="text-xs bg-indigo-600 px-2.5 py-1 rounded font-bold text-white">
              👁️ 観戦モード
            </span>
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
          {!isSpectator && (
            <>
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
            onClick={() => router.push('/')}
            className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300"
          >
            退出
          </button>
        </div>
      </header>

      {/* 山札確認中などのリアルタイムテロップ */}
      {room.inspectingText && (
        <div className="my-1.5 py-1.5 px-4 bg-sky-900/90 border border-sky-400 rounded-lg text-center text-xs sm:text-sm font-bold text-sky-200 animate-pulse">
          🔍 {room.inspectingText}
        </div>
      )}

      {/* 相手（またはプレイヤー）が「相手に見せてめくる」を実行中のリアルタイム公開パネル */}
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
        <div className="flex justify-between items-center text-xs text-slate-400">
          <span className="font-bold text-rose-300">
            {isSpectator ? 'プレイヤー1' : '相手'}：{opponent ? opponent.name : '参加待ち...'}
          </span>
          <div className="flex gap-3">
            <span>山札: {oppDeck.length}</span>
            <span>手札: {oppHand.length}</span>
            <span>マナ: {oppMana.length}</span>
            <span>墓地: {oppGraveyard.length}</span>
          </div>
        </div>

        {/* 上側マナ */}
        <div className="flex flex-wrap gap-1 min-h-[32px] bg-slate-950/50 p-1.5 rounded">
          <span className="text-[10px] text-slate-500 mr-1">マナ:</span>
          {oppMana.map((c) => renderCard(c, 'mana', false, opponent?.name || '相手'))}
        </div>

        {/* 上側シールド */}
        <div className="flex flex-wrap gap-1.5 min-h-[40px] bg-slate-950/50 p-1.5 rounded items-center">
          <span className="text-[10px] text-slate-500 mr-1">シールド:</span>
          {oppShields.map((c, idx) =>
            renderCard(c, 'shields', false, opponent?.name || '相手', idx)
          )}
        </div>

        {/* 上側バトルゾーン */}
        <div className="flex flex-wrap gap-2 min-h-[70px] bg-slate-800/40 p-2 rounded items-center">
          <span className="text-[10px] text-slate-400 mr-1">
            バトルゾーン (カードタップで能力拡大):
          </span>
          {oppBattleZone.map((c) =>
            renderCard(c, 'battleZone', false, opponent?.name || '相手')
          )}
        </div>
      </section>

      {/* ================= 下側フィールド（自分 または プレイヤー2） ================= */}
      <section className="bg-slate-900 border border-slate-700 rounded-xl p-2 sm:p-3 space-y-2 my-1">
        {isSpectator && (
          <div className="flex justify-between items-center text-xs text-slate-400">
            <span className="font-bold text-emerald-300">
              プレイヤー2：{me ? me.name : '参加待ち...'}
            </span>
            <div className="flex gap-3">
              <span>山札: {deck.length}</span>
              <span>手札: {hand.length}</span>
              <span>マナ: {mana.length}</span>
              <span>墓地: {graveyard.length}</span>
            </div>
          </div>
        )}

        {/* 下側バトルゾーン */}
        <div className="flex flex-wrap gap-2 min-h-[85px] bg-slate-800/60 p-2 rounded items-center">
          <span className="text-[10px] text-emerald-400 font-bold mr-1">バトルゾーン:</span>
          {battleZone.map((c) => renderCard(c, 'battleZone', !isSpectator, me?.name || '自分'))}
        </div>

        {/* 下側シールド & 山札・墓地操作ボタン群 */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/60 p-2 rounded">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-amber-400 font-bold mr-1">
              シールド{!isSpectator && '(タップでブレイク→自分だけ確認して手札へ)'}:
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

              {/* 山札の上から1〜10枚めくる（「自分だけ見る」＆「相手に見せてめくる」） */}
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

        {/* 下側マナ */}
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

        {/* 下側手札 */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
          <div className="text-[10px] text-slate-400 mb-1.5">
            {isSpectator
              ? `${me?.name || 'プレイヤー2'}の手札 (${hand.length}枚)`
              : `自分の手札 (${hand.length}枚) - タップで超拡大＆マナ置き・召喚・進化・革命チェンジ`}
          </div>
          <div className="flex flex-wrap gap-2 min-h-[90px]">
            {hand.map((c) => renderCard(c, 'hand', !isSpectator, me?.name || '自分'))}
          </div>
        </div>
      </section>

      {/* ================= シールドブレイク後の秘匿確認モーダル（自分だけ見られる） ================= */}
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
                🛡️ シールドブレイク（あなただけに見えています）
              </span>
              {brokenShieldCard.isShieldTrigger && (
                <span className="px-2 py-0.5 rounded bg-rose-600 text-white text-xs font-extrabold">
                  ⚡ S・トリガー持ち！
                </span>
              )}
            </div>

            {brokenShieldCard.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brokenShieldCard.imageUrl}
                alt={brokenShieldCard.name}
                className="w-[80vw] max-w-[360px] h-[56vh] max-h-[480px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl"
              />
            ) : (
              <div className="w-64 h-80 bg-slate-800 rounded-xl flex items-center justify-center font-bold text-lg p-4 text-center">
                {brokenShieldCard.name}
              </div>
            )}

            <div className="text-center font-bold text-base text-amber-300 truncate w-full">
              {brokenShieldCard.name}
            </div>

            <div className="w-full space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                <button
                  onClick={async () => {
                    const c = brokenShieldCard;
                    setBrokenShieldCard(null);
                    await moveCard(c, 'hand', 'battleZone');
                    if (me) {
                      await triggerCutIn('trigger', me.name, c, 'S・トリガーでバトルゾーンへ！');
                    }
                  }}
                  className="py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl"
                >
                  ⚡ ST：場に出す
                </button>
                <button
                  onClick={async () => {
                    const c = brokenShieldCard;
                    setBrokenShieldCard(null);
                    await moveCard(c, 'hand', 'graveyard');
                    if (me) {
                      await triggerCutIn('trigger', me.name, c, 'S・トリガー呪文を詠唱！');
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

      {/* ================= 相手のカード（または観戦中のカード）超拡大プレビュー ================= */}
      {inspectCard && (
        <div
          onClick={() => setInspectCard(null)}
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-2 sm:p-4 z-50 cursor-pointer"
        >
          <div
            onClick={(e) => {
              e.stopPropagation();
              setInspectCard(null);
            }}
            className="bg-slate-900 border-2 border-slate-500 rounded-2xl p-3 sm:p-4 max-w-md w-full max-h-[95vh] flex flex-col items-center justify-between space-y-2.5 shadow-2xl"
          >
            <div className="w-full flex items-center justify-between text-xs text-slate-300 font-bold">
              <span>{inspectCard.ownerName} のカード確認</span>
              <span className="truncate max-w-[200px] text-amber-300">{inspectCard.card.name}</span>
            </div>

            {inspectCard.card.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={inspectCard.card.imageUrl}
                alt={inspectCard.card.name}
                className="w-[82vw] max-w-[380px] h-[64vh] max-h-[550px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-2xl"
              />
            ) : (
              <div className="w-64 h-80 bg-slate-800 rounded-xl flex items-center justify-center font-bold text-lg p-4 text-center">
                {inspectCard.card.name}
              </div>
            )}

            {(inspectCard.card.underCards?.length || 0) > 0 && (
              <div className="w-full bg-slate-800/80 p-2 rounded-lg text-xs">
                <div className="text-purple-300 font-bold mb-1">
                  進化元 ({inspectCard.card.underCards?.length}枚)：
                </div>
                <div className="flex flex-wrap gap-1">
                  {inspectCard.card.underCards?.map((u) => (
                    <button
                      key={u.instanceId}
                      onClick={(e) => {
                        e.stopPropagation();
                        setInspectCard({ card: u, ownerName: inspectCard.ownerName });
                      }}
                      className="px-2 py-0.5 bg-purple-900 border border-purple-400 rounded text-[11px]"
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setInspectCard(null)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-xl text-xs sm:text-sm"
            >
              閉じる（タップでも閉じます）
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
              {/* 途中から公開に切り替えることも可能 */}
              {!peekState.isPublic && me && (
                <button
                  onClick={async () => {
                    setPeekState({ ...peekState, isPublic: true });
                    await update(ref(db, `rooms/${roomId}`), {
                      inspectingText: `${me.name} が山札の上から ${peekState.cards.length} 枚を公開中！`,
                      publicReveal: {
                        playerName: me.name,
                        cards: peekState.cards,
                      },
                    });
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
            {selectedCard.card.imageUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selectedCard.card.imageUrl}
                  alt={selectedCard.card.name}
                  className="w-[78vw] max-w-[350px] h-[50vh] max-h-[450px] object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-xl"
                />
              </div>
            )}

            <div className="text-center">
              <h3 className="font-bold text-base text-amber-400">{selectedCard.card.name}</h3>
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

            <div className="grid grid-cols-2 gap-2 text-xs font-bold">
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
                        activeTab: battleZone.length > 0 ? 'battleZone' : 'mana',
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
                      await moveCard(c, 'hand', 'graveyard');
                      if (me) {
                        await triggerCutIn('ability', me.name, c, '呪文を詠唱！');
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
                        activeTab: battleZone.length > 0 ? 'battleZone' : 'mana',
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
                        await triggerCutIn('ability', me.name, c, '能力発動！');
                      }
                    }}
                    className="py-2 bg-cyan-600 hover:bg-cyan-500 rounded"
                  >
                    ⚡ 能力発動でカード提示
                  </button>
                </>
              )}
            </div>

            {selectedCard.zone === 'battleZone' &&
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

            <div className="pt-2 border-t border-slate-700 space-y-1.5">
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
                {selectedCard.zone !== 'battleZone' && selectedCard.zone !== 'hand' && selectedCard.zone !== 'mana' && (
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
                    シールドへ
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
            </div>

            <button
              onClick={() => setSelectedCard(null)}
              className="w-full py-2 bg-slate-800 rounded text-xs text-slate-300 font-bold"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ================= 【新機能】自由進化ビルダー（場・マナ・墓地・手札・山札から複数枚選択可） ================= */}
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

            {/* ゾーン切り替えタブ */}
            <div className="flex flex-wrap gap-1.5 border-b border-slate-700 pb-2 text-xs font-bold">
              {(
                [
                  { id: 'battleZone', label: `バトルゾーン (${battleZone.length})` },
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

            {/* 現在選択されている下敷きカード一覧バッジ */}
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

            {/* 候補カード一覧（タップで複数選択トグル） */}
            <div className="overflow-y-auto grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2.5 py-1 flex-1">
              {getEvolutionCandidates().map((c) => {
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
              {getEvolutionCandidates().length === 0 && (
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
                disabled={evolutionBuilder.selectedMaterials.length === 0}
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
              {battleZone.map((c) => (
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
              {battleZone.length === 0 && (
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

      {/* ================= 墓地全確認モーダル（墓地からの進化もここから起動可能） ================= */}
      {!isSpectator && graveSearchOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 border border-rose-500/60 rounded-xl p-4 max-w-2xl w-full max-h-[85vh] flex flex-col space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm text-rose-300">墓地の中身 ({graveyard.length}枚)</h3>
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
                            activeTab: battleZone.length > 0 ? 'battleZone' : 'graveyard',
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