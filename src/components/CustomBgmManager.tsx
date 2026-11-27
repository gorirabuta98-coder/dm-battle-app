'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CustomBgmTrack,
  deleteCustomBgm,
  getMyCustomBgms,
  uploadAndSaveCustomBgm,
} from '@/lib/customBgm';

export default function CustomBgmManager() {
  const [tracks, setTracks] = useState<CustomBgmTrack[]>([]);
  const [bgmName, setBgmName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTracks(getMyCustomBgms());
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
    };
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return alert('音声ファイル（MP3 / M4A / WAVなど）を選んでください');
    setUploading(true);
    try {
      const saved = await uploadAndSaveCustomBgm(bgmName, selectedFile);
      setTracks((prev) => [...prev, saved]);
      setBgmName('');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setUploading(false);
    }
  };

  const handleTogglePreview = (track: CustomBgmTrack) => {
    if (previewingId === track.id) {
      previewAudioRef.current?.pause();
      setPreviewingId(null);
      return;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
    }
    const audio = new Audio(track.url);
    audio.volume = 0.4;
    audio.onended = () => setPreviewingId(null);
    audio.play().catch(() => {});
    previewAudioRef.current = audio;
    setPreviewingId(track.id);
  };

  const handleDelete = async (track: CustomBgmTrack) => {
    if (!confirm(`「${track.name}」を削除しますか？`)) return;
    if (previewingId === track.id) {
      previewAudioRef.current?.pause();
      setPreviewingId(null);
    }
    const next = await deleteCustomBgm(track);
    setTracks(next);
  };

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-3 shadow-lg">
      <div className="flex items-center justify-between">
        <h2 className="font-extrabold text-sm sm:text-base text-amber-300">
          🎵 マイBGM登録（試合中に選ぶと相手にも流れます）
        </h2>
        <span className="text-xs text-slate-400">{tracks.length}曲登録済み</span>
      </div>

      <form onSubmit={handleRegister} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
        <input
          type="text"
          value={bgmName}
          onChange={(e) => setBgmName(e.target.value)}
          placeholder="曲名（例：通常用 / 切り札BGM / ドキンダム解放）"
          className="sm:col-span-5 px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none focus:border-amber-400"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0] || null;
            setSelectedFile(f);
            if (f && !bgmName.trim()) {
              setBgmName(f.name.replace(/\.[^/.]+$/, ''));
            }
          }}
          className="sm:col-span-4 text-xs text-slate-300 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-slate-700 file:text-white hover:file:bg-slate-600 cursor-pointer self-center"
        />
        <button
          type="submit"
          disabled={uploading || !selectedFile}
          className="sm:col-span-3 py-2 px-3 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-extrabold rounded-lg text-xs sm:text-sm transition"
        >
          {uploading ? '登録中...' : '＋ BGMを登録'}
        </button>
      </form>

      {tracks.length > 0 && (
        <div className="space-y-1.5 pt-1 max-h-48 overflow-y-auto">
          {tracks.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-2 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs"
            >
              <span className="font-bold text-slate-100 truncate">🎵 {t.name}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleTogglePreview(t)}
                  className="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded font-bold"
                >
                  {previewingId === t.id ? '■ 停止' : '▶ 試聴'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(t)}
                  className="px-2 py-1 bg-rose-800 hover:bg-rose-700 text-white rounded font-bold"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}