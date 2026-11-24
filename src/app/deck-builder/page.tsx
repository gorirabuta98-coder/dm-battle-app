'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ref, push, set, get } from 'firebase/database';
import { db } from '@/lib/firebase';
import { CardData } from '@/types/game';
import { DeckPreset } from '@/data/decks';

interface BuilderCardItem {
  tempId: string;
  name: string;
  imageUrl: string;
  count: number;
  isShieldTrigger: boolean;
}

function DeckBuilderContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('editId');

  const [deckName, setDeckName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<BuilderCardItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const [singleUrl, setSingleUrl] = useState('');

  // 編集モードの場合、Firebaseから対象デッキを読み込んでカードごとに枚数を集計する
  useEffect(() => {
    if (!editId) return;
    setLoadingEdit(true);

    get(ref(db, `customDecks/${editId}`))
      .then((snapshot) => {
        if (!snapshot.exists()) {
          alert('編集対象のデッキが見つかりませんでした');
          router.push('/');
          return;
        }
        const deck = snapshot.val() as DeckPreset;
        setDeckName(deck.name || '');
        setDescription(deck.description || '');

        const grouped: BuilderCardItem[] = [];
        (deck.cards || []).forEach((card) => {
          const existing = grouped.find(
            (g) => g.imageUrl === card.imageUrl && g.name === card.name
          );
          if (existing) {
            existing.count += 1;
          } else {
            grouped.push({
              tempId: Math.random().toString(36).substring(2, 9),
              name: card.name,
              imageUrl: card.imageUrl || '',
              count: 1,
              isShieldTrigger: !!card.isShieldTrigger,
            });
          }
        });
        setItems(grouped);
      })
      .catch((err) => {
        console.error(err);
        alert('デッキの読み込みに失敗しました');
      })
      .finally(() => setLoadingEdit(false));
  }, [editId, router]);

  const totalCards = items.reduce((sum, item) => sum + item.count, 0);

  // 1枚の画像ファイルを圧縮してDataURLに変換するヘルパー
  const compressImageFile = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxHeight = 380;
          const scale = maxHeight / img.height;
          canvas.width = img.width * scale;
          canvas.height = maxHeight;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = reject;
        img.src = event.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // 複数枚の画像を一括で読み込んでリストに追加する
  const handleMultipleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const fileArray = Array.from(files);
      const newItems: BuilderCardItem[] = [];
      let currentTotal = totalCards;

      for (const file of fileArray) {
        const compressedUrl = await compressImageFile(file);
        const remaining = 40 - currentTotal;
        const initialCount = remaining >= 4 ? 4 : remaining > 0 ? remaining : 1;
        currentTotal += initialCount;

        const cleanName = file.name.replace(/\.[^/.]+$/, '');

        newItems.push({
          tempId: Math.random().toString(36).substring(2, 9),
          name: cleanName || `カード`,
          imageUrl: compressedUrl,
          count: initialCount,
          isShieldTrigger: false,
        });
      }

      setItems((prev) => [...prev, ...newItems]);
    } catch (error) {
      console.error(error);
      alert('一部の画像の読み込みに失敗しました');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  // URL貼り付けで1枚追加
  const handleAddByUrl = () => {
    if (!singleUrl.trim()) return;
    const remaining = 40 - totalCards;
    const initialCount = remaining >= 4 ? 4 : remaining > 0 ? remaining : 1;

    setItems((prev) => [
      ...prev,
      {
        tempId: Math.random().toString(36).substring(2, 9),
        name: `カード ${prev.length + 1}`,
        imageUrl: singleUrl.trim(),
        count: initialCount,
        isShieldTrigger: false,
      },
    ]);
    setSingleUrl('');
  };

  // 個別の枚数を直接指定（1〜4枚）
  const setExactCount = (tempId: string, newCount: number) => {
    setItems((prev) =>
      prev.map((item) => (item.tempId === tempId ? { ...item, count: newCount } : item))
    );
  };

  // 不要な画像を除外
  const removeItem = (tempId: string) => {
    setItems((prev) => prev.filter((item) => item.tempId !== tempId));
  };

  // カード名やS・トリガー設定を個別編集
  const updateItemField = (
    tempId: string,
    field: 'name' | 'isShieldTrigger',
    value: string | boolean
  ) => {
    setItems((prev) =>
      prev.map((item) => (item.tempId === tempId ? { ...item, [field]: value } : item))
    );
  };

  // Firebaseの共有デッキ一覧に保存（編集モードなら上書き保存）
  const handleSaveDeck = async () => {
    if (!deckName.trim()) return alert('デッキ名を入力してください');
    if (totalCards !== 40) return alert(`現在 ${totalCards} 枚です。ちょうど40枚にしてください！`);

    setSaving(true);
    try {
      const cards: CardData[] = [];
      items.forEach((item, idx) => {
        for (let i = 0; i < item.count; i++) {
          cards.push({
            id: `custom-${idx}`,
            name: item.name.trim() || `カード ${idx + 1}`,
            cost: 0,
            civilization: ['zero'],
            type: 'creature',
            text: '※カード画像を参照',
            isShieldTrigger: item.isShieldTrigger,
            imageUrl: item.imageUrl,
          });
        }
      });

      if (editId) {
        await set(ref(db, `customDecks/${editId}`), {
          id: editId,
          name: deckName.trim(),
          description: description.trim() || '画像から作成したカスタム40枚デッキ',
          cards,
        });
        alert('デッキの変更を上書き保存しました！');
      } else {
        const decksRef = ref(db, 'customDecks');
        const newDeckRef = push(decksRef);
        await set(newDeckRef, {
          id: newDeckRef.key,
          name: deckName.trim(),
          description: description.trim() || '画像から作成したカスタム40枚デッキ',
          cards,
        });
        alert('共有デッキとして保存しました！あなたも友達もトップ画面から使えます。');
      }

      router.push('/');
    } catch (error) {
      console.error(error);
      alert('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (loadingEdit) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        デッキデータを読み込み中...
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-900 text-white p-3 sm:p-5 flex flex-col items-center">
      <div className="w-full max-w-3xl bg-slate-800 rounded-xl p-4 sm:p-6 border border-slate-700 space-y-5">
        <div className="flex justify-between items-center">
          <h1 className="text-lg sm:text-xl font-bold text-amber-400">
            {editId ? '共有デッキの編集' : '画像から40枚共有デッキ作成'}
          </h1>
          <button
            onClick={() => router.push('/')}
            className="px-3 py-1.5 bg-slate-700 rounded text-xs hover:bg-slate-600"
          >
            トップへ戻る
          </button>
        </div>

        {/* デッキ名・説明 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-300 mb-1">デッキ名（必須）</label>
            <input
              type="text"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="例：赤単速攻、5c蒼龍など"
              className="w-full px-3 py-2 rounded bg-slate-700 border border-slate-600 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-300 mb-1">メモ・作成者名（任意）</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例：タロウ作 / ガチ構築"
              className="w-full px-3 py-2 rounded bg-slate-700 border border-slate-600 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
        </div>

        {/* 一括アップロードエリア */}
        <div className="bg-slate-900/90 p-4 rounded-xl border-2 border-dashed border-sky-500/60 space-y-3">
          <div className="text-center space-y-1">
            <div className="text-sm font-bold text-sky-400">
              カード画像を複数枚まとめて追加（一括アップロード）
            </div>
            <p className="text-[11px] text-slate-400">
              ShiftやCtrl（スマホなら複数選択）で何枚でも一気に追加できます
            </p>
          </div>

          <label className="block w-full py-3 bg-sky-600 hover:bg-sky-500 text-center font-bold rounded-lg cursor-pointer transition text-sm">
            {uploading ? '画像を読み込み・圧縮中...' : '📁 フォルダ・写真から画像を一括選択する'}
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={uploading}
              onChange={handleMultipleFileUpload}
              className="hidden"
            />
          </label>

          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={singleUrl}
              onChange={(e) => setSingleUrl(e.target.value)}
              placeholder="または画像URLを貼って追加（https://...）"
              className="flex-1 px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs"
            />
            <button
              type="button"
              onClick={handleAddByUrl}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-bold shrink-0"
            >
              URL追加
            </button>
          </div>
        </div>

        {/* 現在の合計枚数バー */}
        <div className="sticky top-2 z-20 bg-slate-900/95 border border-slate-600 px-4 py-2.5 rounded-lg flex items-center justify-between shadow-lg">
          <div className="text-sm font-bold">
            合計枚数:{' '}
            <span
              className={`text-lg ${
                totalCards === 40
                  ? 'text-emerald-400'
                  : totalCards > 40
                  ? 'text-rose-400'
                  : 'text-amber-400'
              }`}
            >
              {totalCards}
            </span>{' '}
            / 40枚
          </div>
          <div className="text-xs text-slate-300">
            {totalCards === 40
              ? '✅ ちょうど40枚！保存できます'
              : totalCards > 40
              ? `⚠️ ${totalCards - 40}枚オーバーしています`
              : `あと ${40 - totalCards} 枚`}
          </div>
        </div>

        {/* 読み込んだカード一覧 */}
        {items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => (
              <div
                key={item.tempId}
                className="relative bg-slate-900 border border-slate-700 rounded-lg p-2 flex flex-col items-center space-y-2"
              >
                <button
                  type="button"
                  onClick={() => removeItem(item.tempId)}
                  title="この画像を除外"
                  className="absolute -top-2 -right-2 w-7 h-7 bg-rose-600 hover:bg-rose-500 text-white rounded-full font-bold text-xs shadow-md flex items-center justify-center z-10"
                >
                  ✕
                </button>

                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.imageUrl}
                  alt={item.name}
                  className="w-24 h-32 object-cover rounded border border-slate-600"
                />

                <input
                  type="text"
                  value={item.name}
                  onChange={(e) => updateItemField(item.tempId, 'name', e.target.value)}
                  className="w-full px-1.5 py-1 bg-slate-800 border border-slate-700 rounded text-[11px] text-center"
                />

                <div className="grid grid-cols-4 gap-1 w-full">
                  {[1, 2, 3, 4].map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => setExactCount(item.tempId, num)}
                      className={`py-1 rounded font-bold text-xs transition ${
                        item.count === num
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                      }`}
                    >
                      ×{num}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-1.5 text-[11px] cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={item.isShieldTrigger}
                    onChange={(e) =>
                      updateItemField(item.tempId, 'isShieldTrigger', e.target.checked)
                    }
                  />
                  <span className={item.isShieldTrigger ? 'text-yellow-400 font-bold' : ''}>
                    ⚡S・トリガー
                  </span>
                </label>
              </div>
            ))}
          </div>
        )}

        {/* 保存ボタン */}
        <button
          onClick={handleSaveDeck}
          disabled={saving || totalCards !== 40}
          className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-bold rounded-lg transition text-sm"
        >
          {saving
            ? '保存中...'
            : totalCards === 40
            ? editId
              ? '変更を上書き保存する'
              : 'この40枚を共有デッキとして保存する'
            : `合計を40枚にしてください（現在 ${totalCards} 枚）`}
        </button>
      </div>
    </main>
  );
}

export default function DeckBuilderPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">読み込み中...</div>}>
      <DeckBuilderContent />
    </Suspense>
  );
}