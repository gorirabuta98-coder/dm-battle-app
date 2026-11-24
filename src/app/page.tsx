'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ref, set, get, onValue, remove } from 'firebase/database';
import { db } from '@/lib/firebase';
import { DeckPreset } from '@/data/decks';
import { CardData, CardInstance, GameRoom, KindanType } from '@/types/game';

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

function createKindanCard(kindanType: KindanType, seals: CardInstance[]): CardInstance | null {
  if (kindanType === 'dokindam') {
    return {
      instanceId: `kindan-dokindam-${Math.random().toString(36).substring(2, 7)}`,
      id: 'kindan-dokindam-x',
      name: '禁断 ～封印されしX～ / 伝説の禁断 ドキンダムX',
      cost: 99,
      civilization: ['fire'],
      type: 'creature',
      power: 99999,
      text: '【禁断の鼓動】ゲーム開始時、このカードを封印を6つ付けてバトルゾーンに置く。コマンドを出した時、封印を1つ墓地に置く。封印がすべてなくなった時、裏返して「伝説の禁断 ドキンダムX」に禁断解放する。',
      tapped: false,
      faceUp: true,
      underCards: seals,
      kindanRole: 'dokindam',
      kindanAwakened: false,
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
      tapped: false,
      faceUp: true,
      underCards: seals,
      kindanRole: 'dormageddon',
      kindanAwakened: false,
    };
  }
  return null;
}

export default function HomePage() {
  const router = useRouter();
  const [playerName, setPlayerName] = useState('');
  const [customDecks, setCustomDecks] = useState<DeckPreset[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string>('');
  const [selectedKindan, setSelectedKindan] = useState<KindanType>('none');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [loading, setLoading] = useState(false);

  const [lastActiveRoom, setLastActiveRoom] = useState<{
    roomId: string;
    playerId: string;
    playerName: string;
  } | null>(null);

  useEffect(() => {
    const savedName = localStorage.getItem('dm_player_name') || '';
    if (savedName) setPlayerName(savedName);

    const savedRoomId = localStorage.getItem('dm_last_room_id');
    const savedPlayerId = localStorage.getItem('dm_player_id');
    if (savedRoomId && savedPlayerId && !savedPlayerId.startsWith('spectator_')) {
      get(ref(db, `rooms/${savedRoomId}`)).then((snap) => {
        if (snap.exists()) {
          const r = snap.val() as GameRoom;
          if (r.players && r.players[savedPlayerId]) {
            setLastActiveRoom({
              roomId: savedRoomId,
              playerId: savedPlayerId,
              playerName: r.players[savedPlayerId].name || savedName,
            });
            setJoinRoomId(savedRoomId);
          }
        }
      });
    }

    const decksRef = ref(db, 'customDecks');
    const unsubscribe = onValue(decksRef, (snapshot) => {
      if (snapshot.exists()) {
        const val = snapshot.val();
        const list = Object.values(val) as DeckPreset[];
        setCustomDecks(list);
        setSelectedDeckId((prev) => {
          if (prev && list.some((d) => d.id === prev)) return prev;
          return list.length > 0 ? list[0].id : '';
        });
      } else {
        setCustomDecks([]);
        setSelectedDeckId('');
      }
    });

    return () => unsubscribe();
  }, []);

  const handleDeleteDeck = async (e: React.MouseEvent, deck: DeckPreset) => {
    e.stopPropagation();
    if (!confirm(`共有デッキ「${deck.name}」を削除しますか？\n（全員の一覧から消去されます）`)) {
      return;
    }
    try {
      await remove(ref(db, `customDecks/${deck.id}`));
    } catch (error) {
      console.error(error);
      alert('デッキの削除に失敗しました');
    }
  };

  // 初期盤面生成（シールド5枚・手札5枚 ＋ ドキンダムXなら封印6枚 / ドルマゲドンXなら封印4枚）
  const buildInitialPlayerState = (
    playerId: string,
    name: string,
    deckPreset: DeckPreset,
    kindanType: KindanType
  ) => {
    const allCards = createDeckInstances(deckPreset.cards);
    const shields = allCards.slice(0, 5).map((c) => ({ ...c, faceUp: false }));
    const hand = allCards.slice(5, 10).map((c) => ({ ...c, faceUp: true }));

    const sealCount =
      kindanType === 'dokindam' ? 6 : kindanType === 'dormageddon' ? 4 : 0;
    const seals = allCards
      .slice(10, 10 + sealCount)
      .map((c) => ({ ...c, faceUp: false, tapped: false }));
    const deck = allCards.slice(10 + sealCount);

    const initialBZ: CardInstance[] = [];
    const kindanCard = createKindanCard(kindanType, seals);
    if (kindanCard) {
      initialBZ.push(kindanCard);
    }

    return {
      id: playerId,
      name: name.trim(),
      deckId: deckPreset.id,
      kindanType,
      deck,
      hand,
      mana: [],
      shields,
      battleZone: initialBZ,
      graveyard: [],
    };
  };

  const handleCreateRoom = async () => {
    if (!playerName.trim()) return alert('プレイヤー名を入力してください');
    const deckPreset = customDecks.find((d) => d.id === selectedDeckId);
    if (!deckPreset) return alert('先にデッキを作成して選択してください！');

    setLoading(true);
    try {
      let roomId = '';
      for (let attempt = 0; attempt < 15; attempt++) {
        const candidate = String(Math.floor(100 + Math.random() * 900));
        const snap = await get(ref(db, `rooms/${candidate}`));
        if (!snap.exists()) {
          roomId = candidate;
          break;
        }
      }
      if (!roomId) {
        roomId = String(Math.floor(100 + Math.random() * 900));
      }

      const playerId = 'p1_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('dm_player_id', playerId);
      localStorage.setItem('dm_player_name', playerName.trim());
      localStorage.setItem('dm_last_room_id', roomId);

      const initialPlayer = buildInitialPlayerState(
        playerId,
        playerName.trim(),
        deckPreset,
        selectedKindan
      );

      const newRoom: GameRoom = {
        roomId,
        status: 'waiting',
        turnPlayerId: playerId,
        turnCount: 1,
        players: {
          [playerId]: initialPlayer,
        },
      };

      await set(ref(db, `rooms/${roomId}`), newRoom);
      router.push(`/room/${roomId}`);
    } catch (error) {
      console.error(error);
      alert('部屋の作成に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async () => {
    if (!playerName.trim()) return alert('プレイヤー名を入力してください');
    const cleanRoomId = joinRoomId.trim();
    if (!cleanRoomId) return alert('3桁のルームIDを入力してください');

    setLoading(true);
    try {
      const roomRef = ref(db, `rooms/${cleanRoomId}`);
      const snapshot = await get(roomRef);

      if (!snapshot.exists()) {
        alert('そのルームIDの部屋は見つかりませんでした');
        setLoading(false);
        return;
      }

      const roomData = snapshot.val() as GameRoom;
      const playersMap = roomData.players || {};
      const existingPlayerIds = Object.keys(playersMap);
      const trimmedName = playerName.trim();

      const savedId = localStorage.getItem('dm_player_id') || '';
      if (savedId && existingPlayerIds.includes(savedId)) {
        localStorage.setItem('dm_player_name', trimmedName);
        localStorage.setItem('dm_last_room_id', cleanRoomId);
        router.push(`/room/${cleanRoomId}`);
        return;
      }

      const matchedByNameId = existingPlayerIds.find(
        (pid) => playersMap[pid]?.name?.trim() === trimmedName
      );
      if (matchedByNameId) {
        localStorage.setItem('dm_player_id', matchedByNameId);
        localStorage.setItem('dm_player_name', trimmedName);
        localStorage.setItem('dm_last_room_id', cleanRoomId);
        router.push(`/room/${cleanRoomId}`);
        return;
      }

      if (existingPlayerIds.length >= 2) {
        const namesList = existingPlayerIds.map((id) => playersMap[id]?.name).join(' / ');
        alert(
          `この部屋はすでに2人（${namesList}）が対戦中です！\n\n・途中の試合に復帰する場合は、対戦時と同じプレイヤー名を入力して「対戦参加 / 復帰」を押してください。\n・観戦する場合は右の「👁️ 観戦する」を押してください。`
        );
        setLoading(false);
        return;
      }

      const deckPreset = customDecks.find((d) => d.id === selectedDeckId);
      if (!deckPreset) {
        alert('先にデッキを作成して選択してください！');
        setLoading(false);
        return;
      }

      const newPlayerId = 'p2_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('dm_player_id', newPlayerId);
      localStorage.setItem('dm_player_name', trimmedName);
      localStorage.setItem('dm_last_room_id', cleanRoomId);

      const joinPlayer = buildInitialPlayerState(
        newPlayerId,
        trimmedName,
        deckPreset,
        selectedKindan
      );
      await set(ref(db, `rooms/${cleanRoomId}/players/${newPlayerId}`), joinPlayer);

      router.push(`/room/${cleanRoomId}`);
    } catch (error) {
      console.error(error);
      alert('参加に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSpectateRoom = async () => {
    const cleanRoomId = joinRoomId.trim();
    if (!cleanRoomId) return alert('観戦したい部屋の3桁ルームIDを入力してください');

    setLoading(true);
    try {
      const roomRef = ref(db, `rooms/${cleanRoomId}`);
      const snapshot = await get(roomRef);

      if (!snapshot.exists()) {
        alert('そのルームIDの部屋は見つかりませんでした');
        setLoading(false);
        return;
      }

      const specId = 'spectator_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('dm_player_id', specId);
      router.push(`/room/${cleanRoomId}?spectate=1`);
    } catch (error) {
      console.error(error);
      alert('観戦への接続に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-800 rounded-2xl shadow-xl p-6 space-y-5 border border-slate-700">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-wider text-amber-400">
            DM ONLINE SIMULATOR
          </h1>
          <p className="text-xs text-slate-400">
            みんなでデッキを共有・編集して対戦＆観戦できるプライベート卓
          </p>
        </div>

        {/* 試合落ちからのワンタップ復帰バナー */}
        {lastActiveRoom && (
          <div className="p-3 bg-emerald-950/90 border-2 border-emerald-400 rounded-xl flex items-center justify-between gap-2 shadow-lg">
            <div className="min-w-0">
              <div className="text-xs font-extrabold text-emerald-300">
                ⚡ 進行中の対戦部屋が見つかりました
              </div>
              <div className="text-[11px] text-slate-300 truncate">
                部屋ID: <span className="font-mono font-bold text-white">{lastActiveRoom.roomId}</span>（{lastActiveRoom.playerName}）
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem('dm_player_id', lastActiveRoom.playerId);
                router.push(`/room/${lastActiveRoom.roomId}`);
              }}
              className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold rounded-lg text-xs shrink-0 transition"
            >
              試合に復帰する
            </button>
          </div>
        )}

        {/* プレイヤー名 */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">
            プレイヤー名（落ちた時は同じ名前で再入室できます）
          </label>
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="例：タロウ"
            className="w-full px-4 py-2.5 rounded-lg bg-slate-700 border border-slate-600 focus:outline-none focus:border-amber-400 text-white"
          />
        </div>

        {/* 共有カスタムデッキ一覧 */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="block text-sm font-medium text-slate-300">
              使用する40枚デッキ ({customDecks.length}個)
            </label>
            <button
              type="button"
              onClick={() => router.push('/deck-builder')}
              className="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold rounded-md transition"
            >
              ＋ 新しくデッキを作る
            </button>
          </div>

          {customDecks.length === 0 ? (
            <div className="p-6 rounded-xl border-2 border-dashed border-slate-600 bg-slate-900/60 text-center space-y-3">
              <p className="text-sm text-slate-300 font-bold">
                まだ共有デッキがありません
              </p>
              <button
                type="button"
                onClick={() => router.push('/deck-builder')}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs"
              >
                画像から40枚デッキを作成する
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 max-h-52 overflow-y-auto pr-1">
              {customDecks.map((deck) => {
                const isSelected = selectedDeckId === deck.id;
                const coverImage = deck.cards?.[0]?.imageUrl;

                return (
                  <div
                    key={deck.id}
                    onClick={() => setSelectedDeckId(deck.id)}
                    className={`p-2.5 rounded-lg border transition cursor-pointer flex items-center justify-between gap-2 ${
                      isSelected
                        ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                        : 'bg-slate-700/60 border-slate-600 hover:bg-slate-700 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {coverImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={coverImage}
                          alt={deck.name}
                          className="w-9 h-12 object-cover rounded border border-slate-500 shrink-0"
                        />
                      ) : (
                        <div className="w-9 h-12 bg-slate-800 rounded flex items-center justify-center text-[10px] shrink-0">
                          40枚
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="font-bold text-sm truncate">{deck.name}</div>
                        <div className="text-[11px] opacity-75 truncate">{deck.description}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/deck-builder?editId=${deck.id}`);
                        }}
                        className="px-2.5 py-1.5 bg-slate-600 hover:bg-slate-500 text-white text-xs font-bold rounded"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteDeck(e, deck)}
                        className="px-2.5 py-1.5 bg-rose-700/90 hover:bg-rose-600 text-white text-xs font-bold rounded"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 禁断カード（41枚目・初期封印セット）オプション */}
        <div className="space-y-1.5 bg-slate-900/70 p-3 rounded-xl border border-rose-500/40">
          <label className="block text-xs font-extrabold text-rose-300">
            🔥 禁断カード（40枚デッキとは別の41枚目・初期封印配置）
          </label>
          <div className="grid grid-cols-3 gap-1.5 text-xs font-bold">
            <button
              type="button"
              onClick={() => setSelectedKindan('none')}
              className={`py-2 px-2 rounded-lg border text-center transition ${
                selectedKindan === 'none'
                  ? 'bg-slate-600 border-white text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
              }`}
            >
              なし（40枚）
            </button>
            <button
              type="button"
              onClick={() => setSelectedKindan('dokindam')}
              className={`py-2 px-1.5 rounded-lg border text-center transition ${
                selectedKindan === 'dokindam'
                  ? 'bg-rose-700 border-amber-400 text-white shadow'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              🔥 ドキンダムX
              <span className="block text-[9px] font-normal opacity-85">初期封印 6枚</span>
            </button>
            <button
              type="button"
              onClick={() => setSelectedKindan('dormageddon')}
              className={`py-2 px-1.5 rounded-lg border text-center transition ${
                selectedKindan === 'dormageddon'
                  ? 'bg-purple-800 border-amber-400 text-white shadow'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              💀 ドルマゲドンX
              <span className="block text-[9px] font-normal opacity-85">初期封印 4枚</span>
            </button>
          </div>
        </div>

        {/* 部屋を作る（数字3桁ID） */}
        <div className="pt-2 border-t border-slate-700 space-y-3">
          <button
            onClick={handleCreateRoom}
            disabled={loading || customDecks.length === 0}
            className="w-full py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-bold rounded-lg transition shadow-lg"
          >
            {loading ? '通信中...' : '新しく対戦部屋を作る（数字3桁ID発行）'}
          </button>

          <div className="text-center text-xs text-slate-400">
            または数字3桁のIDで参加・復帰・観戦
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              inputMode="numeric"
              maxLength={3}
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="ID (例: 428)"
              className="w-full sm:w-32 px-3 py-2.5 rounded-lg bg-slate-700 border border-slate-600 focus:outline-none focus:border-emerald-400 text-center font-mono font-bold text-lg tracking-widest"
            />
            <button
              onClick={handleJoinRoom}
              disabled={loading}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 font-bold rounded-lg transition text-sm"
            >
              対戦参加 / 復帰
            </button>
            <button
              onClick={handleSpectateRoom}
              disabled={loading}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 font-bold rounded-lg transition text-sm"
            >
              👁️ 観戦する
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}