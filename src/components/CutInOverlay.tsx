'use client';

import { useEffect, useState } from 'react';

export interface CutInEvent {
  id: string;
  type: 'summon' | 'ability' | 'attack' | 'evolution' | 'trigger';
  playerName: string;
  cardName: string;
  imageUrl?: string;
  subText?: string;
  timestamp: number;
}

interface CutInOverlayProps {
  event?: CutInEvent | null;
}

export default function CutInOverlay({ event }: CutInOverlayProps) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!event) return;
    // すでに自分が閉じたイベントなら再表示しない
    if (event.id === dismissedId) return;
    // 30秒以上前の古いイベントは表示しない
    if (Date.now() - event.timestamp > 30000) return;

    setVisible(true);
  }, [event, dismissedId]);

  if (!visible || !event || event.id === dismissedId) return null;

  const badgeConfig = {
    summon: {
      label: '召喚 / バトルゾーン登場',
      badgeBg: 'bg-amber-500 text-slate-950',
      border: 'border-amber-400',
    },
    ability: {
      label: '呪文詠唱 / 能力発動',
      badgeBg: 'bg-sky-500 text-slate-950',
      border: 'border-sky-400',
    },
    attack: {
      label: '攻撃宣言',
      badgeBg: 'bg-rose-600 text-white',
      border: 'border-rose-400',
    },
    evolution: {
      label: '進化 / 革命チェンジ',
      badgeBg: 'bg-purple-500 text-white',
      border: 'border-purple-400',
    },
    trigger: {
      label: 'S・トリガー発動',
      badgeBg: 'bg-yellow-400 text-slate-950',
      border: 'border-yellow-300',
    },
  }[event.type];

  const handleClose = () => {
    setDismissedId(event.id);
    setVisible(false);
  };

  return (
    <div
      onClick={handleClose}
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 cursor-pointer transition-opacity duration-150"
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          handleClose();
        }}
        className={`bg-slate-900 border-2 ${badgeConfig.border} rounded-2xl p-4 sm:p-5 max-w-xs sm:max-w-sm w-full flex flex-col items-center space-y-3 shadow-2xl transition-transform duration-150 scale-100`}
      >
        {/* アクション種別＆プレイヤー名 */}
        <div className="flex items-center justify-between w-full gap-2">
          <span className={`px-2.5 py-0.5 rounded text-xs font-extrabold ${badgeConfig.badgeBg}`}>
            {badgeConfig.label}
          </span>
          <span className="text-xs text-slate-300 font-bold truncate">
            {event.playerName}
          </span>
        </div>

        {/* カード画像をデカデカと表示 */}
        {event.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.imageUrl}
            alt={event.cardName}
            className="w-60 h-84 sm:w-64 sm:h-90 object-contain rounded-xl border border-slate-600 bg-slate-950 shadow-xl"
          />
        ) : (
          <div className="w-56 h-72 bg-slate-800 rounded-xl border border-slate-600 flex items-center justify-center p-4 text-center font-bold text-lg">
            {event.cardName}
          </div>
        )}

        {/* カード名＆補足 */}
        <div className="text-center space-y-0.5 w-full">
          <div className="text-base sm:text-lg font-extrabold text-white truncate">
            {event.cardName}
          </div>
          {event.subText && (
            <div className="text-xs text-slate-300">{event.subText}</div>
          )}
        </div>

        {/* 閉じるボタン */}
        <button
          type="button"
          onClick={handleClose}
          className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white font-bold rounded-xl text-xs sm:text-sm transition"
        >
          閉じる（画面タップでも閉じます）
        </button>
      </div>
    </div>
  );
}