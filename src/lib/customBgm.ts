import { supabase } from '@/lib/supabase';

export interface CustomBgmTrack {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

const BGM_BUCKET = 'custom-bgms';

// Supabaseから登録済みの共有BGM一覧をすべて取得（スマホ・PC・友達の端末すべて共通）
export async function fetchCustomBgms(): Promise<CustomBgmTrack[]> {
  const { data, error } = await supabase
    .from('custom_bgms')
    .select('id, name, url, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('BGM一覧取得エラー:', error);
    return [];
  }

  return (data || []).map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    createdAt: Number(row.created_at) || 0,
  }));
}

// 音声ファイルをSupabase Storageにアップロード＆DBに登録
export async function uploadAndSaveCustomBgm(
  name: string,
  file: File
): Promise<CustomBgmTrack> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'm4a';
  const filePath = `bgm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BGM_BUCKET)
    .upload(filePath, file, {
      contentType: file.type || 'audio/mp4',
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

  const { error: dbError } = await supabase.from('custom_bgms').insert({
    id: newTrack.id,
    name: newTrack.name,
    url: newTrack.url,
    created_at: newTrack.createdAt,
  });

  if (dbError) {
    throw new Error(`BGM情報の保存に失敗しました: ${dbError.message}`);
  }

  return newTrack;
}

// 共有BGMを削除（DBとStorageの両方から削除）
export async function deleteCustomBgm(track: CustomBgmTrack): Promise<void> {
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

  const { error } = await supabase.from('custom_bgms').delete().eq('id', track.id);
  if (error) {
    throw new Error(`BGMの削除に失敗しました: ${error.message}`);
  }
}