'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { fetchCustomDecks, deleteCustomDeck } from '@/lib/supabaseDecks';
import { uploadCardImageToSupabase } from '@/lib/supabaseStorage';
import { DeckPreset } from '@/data/decks';
import { CardData, CardInstance, GameRoom, KindanType } from '@/types/game';
import CustomBgmManager from '@/components/CustomBgmManager';

type KindanImageKey =
  | 'dokindamFront'
  | 'dokindamBack'
  | 'dormageddonFront'
  | 'dormageddonBack';

function createDeckInstances(cards: CardData[]): CardInstance[] {
  let instances: CardInstance[] = cards.map((card, index) => ({
    ...card,
    instanceId: `${card.id}-${index}-${Math.random().toString(36).substring(2, 7)}`,
    tapped: false,
    faceUp: false,
    underCards: [],
  }));
  // 複数回のFisher-Yates＋デッキカットで初期手札・シールドの偏りを防止
  for (let p = 0; p < 7; p++) {
    for (let i = instances.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [instances[i], instances[j]] = [instances[j], instances[i]];
    }
    if (instances.length >= 4) {
      const cut = 1 + Math.floor(Math.random() * (instances.length - 2));
      instances = [...instances.slice(cut), ...instances.slice(0, cut)];
    }
  }
  return instances;
}

function createKindanCard(
  kindanType: KindanType,
  seals: CardInstance[],
  frontImageUrl?: string,
  backImageUrl?: string
): CardInstance | null {
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
    };
  }
  return null;
}

async function fetchRoomById(roomId: string): Promise<GameRoom | null> {
  const { data, error } = await supabase
    .from('rooms')
    .select('state')
    .eq('room_id', roomId)
    .maybeSingle();

  if (error) throw error;
  return (data?.state as GameRoom | undefined) ?? null;
}

async function upsertRoom(roomId: string, room: GameRoom): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .upsert(
      {
        room_id: roomId,
        state: room,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id' }
    );

  if (error) throw error;
}

export default function HomePage() {
  const router = useRouter();
  const [playerName, setPlayerName] = useState('');
  const [customDecks, setCustomDecks] = useState<DeckPreset[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string>('');
  const [selectedKindan, setSelectedKindan] = useState<KindanType>('none');

  const [kindanImages, setKindanImages] = useState<Record<KindanImageKey, string>>({
    dokindamFront: '',
    dokindamBack: '',
    dormageddonFront: '',
    dormageddonBack: '',
  });

  const [joinRoomId, setJoinRoomId] = useState('');
  const [loading, setLoading] = useState(false);

  const [lastActiveRoom, setLastActiveRoom] = useState<{
    roomId: string;
    playerId: string;
    playerName: string;
  } | null>(null);

  const clearLastActiveRoom = () => {
    localStorage.removeItem('dm_last_room_id');
    localStorage.removeItem('dm_last_room_ts');
    setLastActiveRoom(null);
    setJoinRoomId('');
  };

  const loadDecks = useCallback(async () => {
    try {
      const records = await fetchCustomDecks();
      const list: DeckPreset[] = records.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || '画像から作成したカスタム40枚デッキ',
        cards: (r.cards || []) as CardData[],
      }));
      setCustomDecks(list);
      setSelectedDeckId((prev) => {
        if (prev && list.some((d) => d.id === prev)) return prev;
        return list.length > 0 ? list[0].id : '';
      });
    } catch (err) {
      console.error('デッキ一覧の取得に失敗:', err);
    }
  }, []);

  const loadKindanImages = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('shared_kindan_images')
        .select('key, image_url');
      if (error) throw error;
      if (data && data.length > 0) {
        setKindanImages((prev) => {
          const next = { ...prev };
          for (const row of data) {
            const k = row.key as KindanImageKey;
            if (k in next && row.image_url) {
              next[k] = row.image_url;
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('共有禁断画像の取得に失敗:', err);
    }
  }, []);

  useEffect(() => {
    const savedName = localStorage.getItem('dm_player_name') || '';
    if (savedName) setPlayerName(savedName);

    try {
      const savedKindanImgs = localStorage.getItem('dm_kindan_images');
      if (savedKindanImgs) {
        setKindanImages((prev) => ({ ...prev, ...JSON.parse(savedKindanImgs) }));
      }
    } catch {
      // ignore
    }

    // 3時間以上前に作られた放置部屋をSupabaseから自動掃除
    const now = Date.now();
    const threeHoursAgoIso = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    supabase
      .from('rooms')
      .delete()
      .lt('updated_at', threeHoursAgoIso)
      .then(({ error }) => {
        if (error) console.error('放置部屋の掃除に失敗:', error);
      });

    loadDecks();
    loadKindanImages();

    const savedRoomId = localStorage.getItem('dm_last_room_id');
    const savedPlayerId = localStorage.getItem('dm_player_id');
    const savedRoomTs = Number(localStorage.getItem('dm_last_room_ts') || '0');
    const isExpired = savedRoomTs > 0 && Date.now() - savedRoomTs > 3 * 60 * 60 * 1000;

    if (isExpired) {
      localStorage.removeItem('dm_last_room_id');
      localStorage.removeItem('dm_last_room_ts');
    } else if (savedRoomId && savedPlayerId && !savedPlayerId.startsWith('spectator_')) {
      fetchRoomById(savedRoomId)
        .then((r) => {
          if (r) {
            const alreadyLeft = r.leftPlayers?.[savedPlayerId];
            if (r.status !== 'finished' && !alreadyLeft && r.players && r.players[savedPlayerId]) {
              setLastActiveRoom({
                roomId: savedRoomId,
                playerId: savedPlayerId,
                playerName: r.players[savedPlayerId].name || savedName,
              });
              setJoinRoomId(savedRoomId);
              return;
            }
          }
          localStorage.removeItem('dm_last_room_id');
          localStorage.removeItem('dm_last_room_ts');
        })
        .catch((err) => console.error(err));
    }

    const channel = supabase
      .channel('home-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'custom_decks' },
        () => {
          loadDecks();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shared_kindan_images' },
        () => {
          loadKindanImages();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadDecks, loadKindanImages]);

  const handleUploadKindanImage = async (key: KindanImageKey, file?: File) => {
    if (!file) return;
    try {
      const publicUrl = await uploadCardImageToSupabase(file, 'kindan', 960);
      const updated = { ...kindanImages, [key]: publicUrl };
      setKindanImages(updated);
      localStorage.setItem('dm_kindan_images', JSON.stringify(updated));

      const { error } = await supabase
        .from('shared_kindan_images')
        .upsert(
          {
            key,
            image_url: publicUrl,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'key' }
        );
      if (error) throw error;
    } catch (error) {
      console.error(error);
      alert('画像のアップロードに失敗しました');
    }
  };

  const handleDeleteDeck = async (e: React.MouseEvent, deck: DeckPreset) => {
    e.stopPropagation();
    if (!confirm(`共有デッキ「${deck.name}」を削除しますか？\n（全員の一覧から消去されます）`)) {
      return;
    }
    try {
      await deleteCustomDeck(deck.id);
      await loadDecks();
    } catch (error) {
      console.error(error);
      alert('デッキの削除に失敗しました');
    }
  };

  const buildInitialPlayerState = (
    playerId: string,
    name: string,
    deckPreset: DeckPreset,
    kindanType: KindanType
  ) => {
    const allCards = createDeckInstances(deckPreset.cards);
    // S1〜S5のスロット番号を明示的に固定して、3をブレイクしても4・5が詰まらないようにする
    const shields = allCards.slice(0, 5).map((c, idx) => ({
      ...c,
      faceUp: false,
      tapped: false,
      shieldOverlaySlot: `S${idx + 1}`,
    }));
    const hand = allCards.slice(5, 10).map((c) => ({ ...c, faceUp: true }));

    const sealCount =
      kindanType === 'dokindam' ? 6 : kindanType === 'dormageddon' ? 4 : 0;
    const seals = allCards
      .slice(10, 10 + sealCount)
      .map((c) => ({ ...c, faceUp: false, tapped: false }));
    const deck = allCards.slice(10 + sealCount);

    const frontImg =
      kindanType === 'dokindam'
        ? kindanImages.dokindamFront
        : kindanType === 'dormageddon'
        ? kindanImages.dormageddonFront
        : '';
    const backImg =
      kindanType === 'dokindam'
        ? kindanImages.dokindamBack
        : kindanType === 'dormageddon'
        ? kindanImages.dormageddonBack
        : '';

    const initialBZ: CardInstance[] = [];
    const kindanCard = createKindanCard(kindanType, seals, frontImg, backImg);
    if (kindanCard) {
      initialBZ.push(kindanCard);
    }

    return {
      id: playerId,
      name: name.trim(),
      deckId: deckPreset.id,
      kindanType,
      kindanFrontImageUrl: frontImg,
      kindanBackImageUrl: backImg,
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
        const existing = await fetchRoomById(candidate);
        if (!existing) {
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
      localStorage.setItem('dm_last_room_ts', String(Date.now()));

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
        createdAt: Date.now(),
        players: {
          [playerId]: initialPlayer,
        },
      };

      await upsertRoom(roomId, newRoom);
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
      const roomData = await fetchRoomById(cleanRoomId);

      if (!roomData) {
        alert('そのルームIDの部屋は見つかりませんでした');
        setLoading(false);
        return;
      }

      const playersMap = roomData.players || {};
      const existingPlayerIds = Object.keys(playersMap);
      const trimmedName = playerName.trim();

      const savedId = localStorage.getItem('dm_player_id') || '';
      if (savedId && existingPlayerIds.includes(savedId)) {
        localStorage.setItem('dm_player_name', trimmedName);
        localStorage.setItem('dm_last_room_id', cleanRoomId);
        localStorage.setItem('dm_last_room_ts', String(Date.now()));
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
        localStorage.setItem('dm_last_room_ts', String(Date.now()));
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
      localStorage.setItem('dm_last_room_ts', String(Date.now()));

      const joinPlayer = buildInitialPlayerState(
        newPlayerId,
        trimmedName,
        deckPreset,
        selectedKindan
      );

      const updatedRoom: GameRoom = {
        ...roomData,
        players: {
          ...playersMap,
          [newPlayerId]: joinPlayer,
        },
      };

      await upsertRoom(cleanRoomId, updatedRoom);
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
      const roomData = await fetchRoomById(cleanRoomId);

      if (!roomData) {
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

  const selectedDeckObj = customDecks.find((d) => d.id === selectedDeckId);

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

        {/* 試合落ちからのワンタップ復帰バナー（✕ボタンでいつでも消去可能） */}
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
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem('dm_player_id', lastActiveRoom.playerId);
                  localStorage.setItem('dm_last_room_ts', String(Date.now()));
                  router.push(`/room/${lastActiveRoom.roomId}`);
                }}
                className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold rounded-lg text-xs transition"
              >
                試合に復帰する
              </button>
              <button
                type="button"
                onClick={clearLastActiveRoom}
                title="この通知を消す"
                className="w-8 h-8 bg-slate-800/90 hover:bg-rose-700 text-slate-300 hover:text-white rounded-lg text-xs font-extrabold flex items-center justify-center transition"
              >
                ✕
              </button>
            </div>
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
            <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
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

        {/* 禁断カード設定 */}
        {selectedDeckObj && (
          <div className="bg-slate-900/80 border border-amber-500/40 rounded-xl p-3 space-y-2.5">
            <div className="text-xs font-extrabold text-amber-300 flex items-center justify-between">
              <span>🔥 禁断カード（40枚デッキとは別の41枚目・初期封印配置）</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 text-xs font-bold">
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
                className={`py-2 px-2 rounded-lg border text-center transition ${
                  selectedKindan === 'dokindam'
                    ? 'bg-rose-700 border-amber-400 text-white shadow'
                    : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                }`}
              >
                🔥 ドキンダムX
                <span className="block text-[9px] font-normal opacity-85">初期封印 6枚</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedKindan('dormageddon')}
                className={`py-2 px-2 rounded-lg border text-center transition ${
                  selectedKindan === 'dormageddon'
                    ? 'bg-purple-800 border-amber-400 text-white shadow'
                    : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                }`}
              >
                💀 ドルマゲドンX
                <span className="block text-[9px] font-normal opacity-85">初期封印 4枚</span>
              </button>
            </div>

            {selectedKindan !== 'none' && (
              <div className="pt-2 border-t border-slate-700/80 grid grid-cols-2 gap-2.5 text-xs">
                <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700 flex flex-col items-center space-y-1.5">
                  <span className="text-[10px] font-bold text-slate-300">
                    ① 鼓動面（封印中）の画像
                  </span>
                  {(selectedKindan === 'dokindam'
                    ? kindanImages.dokindamFront
                    : kindanImages.dormageddonFront) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={
                        selectedKindan === 'dokindam'
                          ? kindanImages.dokindamFront
                          : kindanImages.dormageddonFront
                      }
                      alt="鼓動面"
                      className="w-16 h-22 object-cover rounded border border-amber-400"
                    />
                  ) : (
                    <div className="w-16 h-22 bg-slate-900 rounded border border-dashed border-slate-600 flex items-center justify-center text-[10px] text-slate-400 text-center p-1">
                      画像未設定
                    </div>
                  )}
                  <label className="w-full py-1 px-2 bg-sky-600 hover:bg-sky-500 text-white text-[10px] font-bold rounded text-center cursor-pointer">
                    📷 画像を入れる
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        handleUploadKindanImage(
                          selectedKindan === 'dokindam'
                            ? 'dokindamFront'
                            : 'dormageddonFront',
                          e.target.files?.[0]
                        )
                      }
                    />
                  </label>
                </div>

                <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700 flex flex-col items-center space-y-1.5">
                  <span className="text-[10px] font-bold text-amber-300">
                    ② 禁断解放後（裏面）の画像
                  </span>
                  {(selectedKindan === 'dokindam'
                    ? kindanImages.dokindamBack
                    : kindanImages.dormageddonBack) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={
                        selectedKindan === 'dokindam'
                          ? kindanImages.dokindamBack
                          : kindanImages.dormageddonBack
                      }
                      alt="禁断解放面"
                      className="w-16 h-22 object-cover rounded border border-amber-400"
                    />
                  ) : (
                    <div className="w-16 h-22 bg-slate-900 rounded border border-dashed border-slate-600 flex items-center justify-center text-[10px] text-slate-400 text-center p-1">
                      画像未設定
                    </div>
                  )}
                  <label className="w-full py-1 px-2 bg-amber-600 hover:bg-amber-500 text-slate-950 text-[10px] font-extrabold rounded text-center cursor-pointer">
                    📷 解放後画像を入れる
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        handleUploadKindanImage(
                          selectedKindan === 'dokindam'
                            ? 'dokindamBack'
                            : 'dormageddonBack',
                          e.target.files?.[0]
                        )
                      }
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {/* マイBGM登録パネル（誰でも好きな曲名で登録・試聴・削除可能） */}
        <CustomBgmManager />

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