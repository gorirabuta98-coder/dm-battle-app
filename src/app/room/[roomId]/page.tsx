'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ref, onValue, update, get } from 'firebase/database';
import { db } from '@/lib/firebase';
import { CardData, CardInstance, GameRoom, PlayerState } from '@/types/game';
import { DeckPreset } from '@/data/decks';
import CutInOverlay, { CutInEvent } from '@/components/CutInOverlay';

type ZoneType = 'hand' | 'mana' | 'battleZone' | 'shields' | 'graveyard';

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
  const [selectedCard, setSelectedCard] = useState<{
    card: CardInstance;
    zone: ZoneType;
  } | null>(null);

  // 1つ戻る（Undo）用の操作履歴スタック（直前までの自分の盤面スナップショットを保存）
  const [undoStack, setUndoStack] = useState<string[]>([]);

  // 山札全確認モーダル
  const [deckSearchOpen, setDeckSearchOpen] = useState(false);

  // 墓地全確認モーダル
  const [graveSearchOpen, setGraveSearchOpen] = useState(false);

  // 山札の上から見る枚数（1〜10枚）
  const [peekCount, setPeekCount] = useState<number>(4);

  // 山札の上からN枚めくって自分だけ見る（秘匿確認）モーダル
  const [peekCards, setPeekCards] = useState<CardInstance[] | null>(null);

  // 進化 or 革命チェンジの対象選択モーダル
  const [specialSummonPending, setSpecialSummonPending] = useState<{
    card: CardInstance;
    fromZone: 'hand' | 'mana' | 'graveyard';
    mode: 'evolve' | 'change';
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

  // 参加者の場合は自分が下・相手が上。観戦者の場合はプレイヤー1が上・プレイヤー2が下
  const bottomPlayerId = isParticipant ? myPlayerId : playerIds[1] || playerIds[0];
  const topPlayerId = isParticipant
    ? playerIds.find((id) => id !== myPlayerId)
    : playerIds[0] !== bottomPlayerId
    ? playerIds[0]
    : undefined;

  const me: PlayerState | undefined = bottomPlayerId ? playersObj[bottomPlayerId] : undefined;
  const opponent: PlayerState | undefined = topPlayerId ? playersObj[topPlayerId] : undefined;
  const isMyTurn = !isSpectator && room.turnPlayerId === myPlayerId;

  // 操作前に現在の盤面スナップショットを履歴に積んでから更新するヘルパー
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

  // 【1つ戻る（Undo）】直前の盤面状態に巻き戻す
  const handleUndo = async () => {
    if (isSpectator || undoStack.length === 0 || !me) return;
    const lastSnapshotStr = undoStack[undoStack.length - 1];
    const restored = JSON.parse(lastSnapshotStr);
    setUndoStack((prev) => prev.slice(0, -1));
    setPeekCards(null);
    setSelectedCard(null);
    await setInspectingStatus(null);
    await update(ref(db, `rooms/${roomId}/players/${myPlayerId}`), restored);
  };

  // 【試合を強制終了して最初からやり直す（リセット）】
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

        // もし元デッキが消されていた場合は現在持っている全カードを回収してシャッフル
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
      });

      setUndoStack([]);
      setPeekCards(null);
      setSelectedCard(null);
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

  // 山札の一番上から各ゾーンへ直接送る
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

  // 山札シャッフル
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

  // ターン開始（全アンタップ＆1ドロー）
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

  // ターンエンド（相手にターンを渡す）
  const handleTurnEnd = async () => {
    if (isSpectator) return;
    if (!topPlayerId) return alert('対戦相手がまだいません');
    await update(ref(db, `rooms/${roomId}`), {
      turnPlayerId: topPlayerId,
      turnCount: (room.turnCount || 1) + 1,
    });
  };

  // 山札の上から1〜10枚めくって自分だけ見る
  const handlePeekTopDeck = async (count: number) => {
    if (!me || isSpectator || deck.length === 0) return alert('山札がありません');
    const actualCount = Math.min(count, deck.length);
    const newDeck = [...deck];
    const revealed = newDeck.splice(0, actualCount).map((c) => ({ ...c, faceUp: true }));

    await updateMyState({ deck: newDeck });
    await setInspectingStatus(`${me.name} が山札の上から ${actualCount} 枚を確認中...`);
    setPeekCards(revealed);
  };

  const handleMoveFromPeek = async (
    picked: CardInstance,
    dest: 'hand' | 'battleZone' | 'mana' | 'graveyard'
  ) => {
    if (!peekCards || !me || isSpectator) return;
    const remaining = peekCards.filter((c) => c.instanceId !== picked.instanceId);
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
      setPeekCards(null);
      await setInspectingStatus(null);
    } else {
      setPeekCards(remaining);
    }
  };

  const handleFinishPeek = async (destination: 'bottom' | 'top' | 'graveyard') => {
    if (!peekCards || isSpectator) return;
    if (destination === 'bottom') {
      const hidden = peekCards.map((c) => ({ ...c, faceUp: false }));
      await updateMyState({ deck: [...deck, ...hidden] }, false);
    } else if (destination === 'top') {
      const hidden = peekCards.map((c) => ({ ...c, faceUp: false }));
      await updateMyState({ deck: [...hidden, ...deck] }, false);
    } else {
      const toGrave = peekCards.map((c) => ({ ...c, faceUp: true, tapped: false }));
      await updateMyState({ graveyard: [...graveyard, ...toGrave] }, false);
    }
    setPeekCards(null);
    await setInspectingStatus(null);
  };

  // 任意のゾーンから任意のゾーンへの自由移動
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

  // タップ / アンタップ切り替え
  const toggleTap = async (card: CardInstance, zone: 'mana' | 'battleZone') => {
    if (!me || isSpectator) return;
    const list = zone === 'mana' ? mana : battleZone;
    const updated = list.map((c) =>
      c.instanceId === card.instanceId ? { ...c, tapped: !c.tapped } : c
    );
    await updateMyState({ [zone]: updated });
    setSelectedCard(null);
  };

  // 攻撃宣言
  const handleAttackDeclare = async (attacker: CardInstance) => {
    if (!me || isSpectator) return;
    const updatedBZ = battleZone.map((c) =>
      c.instanceId === attacker.instanceId ? { ...c, tapped: true } : c
    );
    await updateMyState({ battleZone: updatedBZ });
    setSelectedCard(null);

    await triggerCutIn('attack', me.name, attacker, 'クリーチャーで攻撃宣言！');
  };

  // シールドブレイク処理
  const handleBreakShield = async (card: CardInstance) => {
    if (!me || isSpectator) return;
    const updatedShields = shields.map((c) =>
      c.instanceId === card.instanceId ? { ...c, faceUp: true } : c
    );
    await updateMyState({ shields: updatedShields });

    if (card.isShieldTrigger) {
      await triggerCutIn('trigger', me.name, card, 'S・トリガー発動可能！');
    }
  };

  // 進化 ＆ 革命チェンジ実行
  const handleExecuteSpecialSummon = async (targetCard: CardInstance) => {
    if (!me || isSpectator || !specialSummonPending) return;
    const { card: incomingCard, fromZone, mode } = specialSummonPending;

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

    if (mode === 'evolve') {
      const existingUnder = targetCard.underCards || [];
      const baseWithoutNested: CardInstance = { ...targetCard, underCards: [] };
      const evolvedCard: CardInstance = {
        ...incomingCard,
        tapped: targetCard.tapped,
        faceUp: true,
        underCards: [...existingUnder, baseWithoutNested],
      };

      const nextBZ = battleZone.map((c) =>
        c.instanceId === targetCard.instanceId ? evolvedCard : c
      );

      await updateMyState({
        hand: nextHand,
        mana: nextMana,
        graveyard: nextGrave,
        battleZone: nextBZ,
      });

      setSpecialSummonPending(null);
      setSelectedCard(null);

      await triggerCutIn(
        'evolution',
        me.name,
        evolvedCard,
        `『${targetCard.name}』の上に進化！`
      );
    } else {
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

      setSpecialSummonPending(null);
      setSelectedCard(null);

      await triggerCutIn(
        'evolution',
        me.name,
        changedCard,
        `革命チェンジ！（『${targetCard.name}』は手札へ）`
      );
    }
  };

  // 進化元取り出し
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

  // 山札全確認モーダルから好きなゾーンへ直接送る
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
    index?: number
  ) => {
    // 観戦時は手札は裏向きのまま、場・マナ・表シールドは公開
    const showFace = card.faceUp || (isControllable && zone === 'hand');
    const underCount = card.underCards?.length || 0;

    return (
      <div
        key={card.instanceId}
        onClick={() => {
          if (!isControllable) return;
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
          if (!isControllable) return;
          e.preventDefault();
          setSelectedCard({ card, zone });
        }}
        title={showFace ? card.name : '裏向きカード'}
        className={`relative select-none transition-transform ${
          isControllable ? 'cursor-pointer' : 'cursor-default'
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

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-2 sm:p-4 max-w-6xl mx-auto">
      {/* 中央デカデカカード提示オーバーレイ */}
      <CutInOverlay event={room.cutIn} />

      {/* 上部バー：部屋情報＆ターン管理＆1つ戻る＆試合リセット */}
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
                title="直前の盤面操作を1つ元に戻します"
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
                title="試合を強制終了して最初からやり直します"
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
          {oppMana.map((c) => renderCard(c, 'mana', false))}
        </div>

        {/* 上側シールド */}
        <div className="flex flex-wrap gap-1.5 min-h-[40px] bg-slate-950/50 p-1.5 rounded items-center">
          <span className="text-[10px] text-slate-500 mr-1">シールド:</span>
          {oppShields.map((c, idx) => renderCard(c, 'shields', false, idx))}
        </div>

        {/* 上側バトルゾーン */}
        <div className="flex flex-wrap gap-2 min-h-[70px] bg-slate-800/40 p-2 rounded items-center">
          <span className="text-[10px] text-slate-400 mr-1">バトルゾーン:</span>
          {oppBattleZone.map((c) => renderCard(c, 'battleZone', false))}
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
          {battleZone.map((c) => renderCard(c, 'battleZone', !isSpectator))}
        </div>

        {/* 下側シールド & 山札・墓地操作ボタン群 */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/60 p-2 rounded">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-amber-400 font-bold mr-1">
              シールド{!isSpectator && '(タップでブレイク)'}:
            </span>
            {shields.map((c, idx) => renderCard(c, 'shields', !isSpectator, idx))}
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
                  title="山札の上から見る枚数を選択"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                    <option key={num} value={num}>
                      {num === 1 ? '1枚(トップ)' : `${num}枚`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => handlePeekTopDeck(peekCount)}
                  className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-bold"
                >
                  見る
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
            {mana.map((c) => renderCard(c, 'mana', !isSpectator))}
          </div>
          {!isSpectator && mana.length > 0 && (
            <button
              onClick={() => setSelectedCard({ card: mana[mana.length - 1], zone: 'mana' })}
              className="px-2.5 py-1.5 bg-lime-900 hover:bg-lime-800 border border-lime-500/50 rounded text-[11px] font-bold text-lime-200"
            >
              マナから場に出す・移動
            </button>
          )}
        </div>

        {/* 下側手札 */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
          <div className="text-[10px] text-slate-400 mb-1.5">
            {isSpectator
              ? `${me?.name || 'プレイヤー2'}の手札 (${hand.length}枚)`
              : `自分の手札 (${hand.length}枚) - タップでマナ置き・召喚・進化・革命チェンジ`}
          </div>
          <div className="flex flex-wrap gap-2 min-h-[90px]">
            {hand.map((c) => renderCard(c, 'hand', !isSpectator))}
          </div>
        </div>
      </section>

      {/* ================= 秘匿：山札の上から1〜10枚めくり選択モーダル ================= */}
      {!isSpectator && peekCards && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border-2 border-sky-400 rounded-2xl p-5 max-w-3xl w-full max-h-[90vh] flex flex-col space-y-4">
            <div>
              <h3 className="font-bold text-base text-sky-400">
                🔍 山札の上からめくったカード（あなただけ見えています）
              </h3>
              <p className="text-xs text-slate-400">
                手札に加える・場に出す・マナや墓地に置くカードを選び、残りを山札の下（または上）に戻してください
              </p>
            </div>

            <div className="overflow-y-auto grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3 py-1">
              {peekCards.map((c, idx) => (
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
                      className="w-20 h-28 object-cover rounded border border-slate-500"
                    />
                  ) : (
                    <div className="w-20 h-28 bg-slate-700 rounded flex items-center justify-center text-xs text-center p-1">
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

      {/* ================= 全ゾーン万能移動＆アクションモーダル ================= */}
      {!isSpectator && selectedCard && (
        <div
          onClick={() => setSelectedCard(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-800 border border-slate-600 rounded-xl p-4 max-w-sm w-full max-h-[90vh] overflow-y-auto space-y-3"
          >
            {selectedCard.card.imageUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selectedCard.card.imageUrl}
                  alt={selectedCard.card.name}
                  className="w-36 h-52 object-cover rounded-lg border border-slate-500 shadow-lg"
                />
              </div>
            )}

            <div className="text-center">
              <h3 className="font-bold text-base text-amber-400">{selectedCard.card.name}</h3>
              {selectedCard.zone === 'mana' && mana.length > 1 && (
                <div className="flex flex-wrap justify-center gap-1 mt-2 py-1">
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
                      setSpecialSummonPending({
                        card: selectedCard.card,
                        fromZone: 'hand',
                        mode: 'evolve',
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-purple-600 hover:bg-purple-500 rounded"
                  >
                    🧬 進化（上に重ねる）
                  </button>
                  <button
                    onClick={() => {
                      setSpecialSummonPending({
                        card: selectedCard.card,
                        fromZone: 'hand',
                        mode: 'change',
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
                      setSpecialSummonPending({
                        card: selectedCard.card,
                        fromZone: 'mana',
                        mode: 'evolve',
                      });
                      setSelectedCard(null);
                    }}
                    className="py-2 bg-purple-600 hover:bg-purple-500 rounded"
                  >
                    🧬 マナから進化
                  </button>
                  <button
                    onClick={() => {
                      setSpecialSummonPending({
                        card: selectedCard.card,
                        fromZone: 'mana',
                        mode: 'change',
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
                        className="flex items-center justify-between bg-slate-900 p-1.5 rounded text-xs"
                      >
                        <span className="truncate font-bold">{u.name}</span>
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
              className="w-full py-1.5 bg-slate-900 rounded text-xs text-slate-400"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ================= 進化・革命チェンジ 対象選択モーダル ================= */}
      {!isSpectator && specialSummonPending && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div
            className={`bg-slate-800 border-2 ${
              specialSummonPending.mode === 'evolve' ? 'border-purple-500' : 'border-fuchsia-500'
            } rounded-xl p-4 max-w-md w-full space-y-3`}
          >
            <h3 className="font-bold text-sm text-white">
              {specialSummonPending.mode === 'evolve'
                ? `🧬 「${specialSummonPending.card.name}」を上に乗せる進化元を選択`
                : `🔄 「${specialSummonPending.card.name}」と革命チェンジする場のキャラを選択（手札に戻ります）`}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {battleZone.map((c) => (
                <button
                  key={c.instanceId}
                  onClick={() => handleExecuteSpecialSummon(c)}
                  className={`p-2 rounded text-xs font-bold flex items-center gap-2 ${
                    specialSummonPending.mode === 'evolve'
                      ? 'bg-purple-700 hover:bg-purple-600'
                      : 'bg-fuchsia-700 hover:bg-fuchsia-600'
                  }`}
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
              onClick={() => setSpecialSummonPending(null)}
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
                  <div className="flex items-center gap-2 min-w-0">
                    {c.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                    )}
                    <div className="font-bold text-xs truncate">{c.name}</div>
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

      {/* ================= 墓地全確認モーダル ================= */}
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
                    <div className="flex items-center gap-2 min-w-0">
                      {c.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageUrl} alt={c.name} className="w-8 h-11 object-cover rounded shrink-0" />
                      )}
                      <div className="font-bold text-xs truncate">{c.name}</div>
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