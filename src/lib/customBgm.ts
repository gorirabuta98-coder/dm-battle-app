import { supabase } from '@/lib/supabase';

export interface CustomBgmTrack {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

const BGM_BUCKET = 'custom-bgms';
const STORAGE_KEY = 'dm_my_custom_bgms_v1';

// 自分の端末に登録したマイBGM一覧を取得
export function getMyCustomBgms(): CustomBgmTrack[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomBgmTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 音声ファイルをSupabaseにアップロードしてマイBGMに登録（相手にも流せる共有URLを発行）
export async function uploadAndSaveCustomBgm(
  name: string,
  file: File
): Promise<CustomBgmTrack> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3';
  const filePath = `bgm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BGM_BUCKET)
    .upload(filePath, file, {
      contentType: file.type || 'audio/mpeg',
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`BGMのアップロードに失敗しました: ${uploadError.message}`);
  }

  const { data: urlData } = supabase.storage.from(BGM_BUCKET).getPublicUrl(filePath);
  const publicUrl = urlData.publicUrl;

  const cleanName = name.trim() || file.name.replace(/\.[^/.]+$/, '');
  const newTrack: CustomBgmTrack = {
    id: `bgm-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: cleanName,
    url: publicUrl,
    createdAt: Date.now(),
  };

  const current = getMyCustomBgms();
  const next = [...current, newTrack];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

  return newTrack;
}

// マイBGMを削除
export async function deleteCustomBgm(track: CustomBgmTrack): Promise<CustomBgmTrack[]> {
  try {
    const marker = `/object/public/${BGM_BUCKET}/`;
    const idx = track.url.indexOf(marker);
    if (idx !== -1) {
      const filePath = decodeURIComponent(track.url.slice(idx + marker.length));
      await supabase.storage.from(BGM_BUCKET).remove([filePath]);
    }
  } catch (e) {
    console.warn('Storage file delete skipped:', e);
  }

  const next = getMyCustomBgms().filter((t) => t.id !== track.id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}